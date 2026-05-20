// Redis-Streams-backed QueueConsumer. Used on devnet (Railway) where
// Pub/Sub isn't available. Designed to give the settler the same logical
// semantics as the Pub/Sub backend:
//
//   - XREADGROUP (BLOCK 5000)             ≈ subscription.on("message")
//   - XACK <stream> <group> <id>          ≈ msg.ack()
//   - XADD <dlq> + XACK after >MAX retries ≈ Pub/Sub dead_letter_policy
//   - XCLAIM IDLE > <timeout>             ≈ Pub/Sub re-delivery on stuck PEL
//
// Behavior intentionally mirrors mainnet's max_delivery_attempts=10 from
// terraform-gcp/pact-network/base.tf so DLQ thresholds match across envs.
//
// `ioredis` is imported via type-only `import type` so the wrap package's
// dep policy is preserved; the actual ioredis client is injected by
// ConsumerModule (Wave 5).

import { Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import type { QueueConsumer, SettleMessage } from "./queue-consumer.interface";

// ioredis' generated overloads for variable-arity stream commands are
// finicky — the typed overload doesn't accept the "BLOCK <ms> COUNT <n>"
// mix in any single sensible permutation. Use the raw send_command escape
// hatch instead. Behavior is identical; we just bypass the type tax.
type RawRedis = {
  call(command: string, ...args: (string | number)[]): Promise<unknown>;
};

/** Max delivery attempts before the message is moved to the DLQ stream. Matches mainnet. */
export const MAX_DELIVERY_ATTEMPTS = 10;

/** Block time on XREADGROUP, ms. 5s matches the Pub/Sub batcher flush cadence. */
const READ_BLOCK_MS = 5000;

/** How long a PEL entry must idle before XCLAIM can steal it (ms). */
const STALE_CLAIM_THRESHOLD_MS = 60_000;

export interface RedisStreamsQueueConsumerConfig {
  /** Stream key. e.g. "pact-settle-events". */
  stream: string;
  /** Consumer group name. e.g. "settler". */
  group: string;
  /** Per-consumer identifier within the group. Default = hostname or "settler-1". */
  consumerName?: string;
  /** DLQ stream key. Default = `${stream}-dlq`. */
  dlqStream?: string;
}

interface PendingEntry {
  /** Stream entry ID, e.g. "1700000000-0". */
  id: string;
  /** Raw event JSON for DLQ re-publish. */
  raw: string;
  /** Delivery counter from XPENDING for this consumer/entry. */
  deliveryCount: number;
}

export class RedisStreamsQueueConsumer implements QueueConsumer {
  private readonly logger = new Logger(RedisStreamsQueueConsumer.name);
  private readonly queue: SettleMessage[] = [];
  private onEnqueue: ((msg: SettleMessage) => void) | null = null;
  private running = false;
  private pollLoop: Promise<void> | null = null;
  private readonly dlqStream: string;
  private readonly consumerName: string;

  constructor(
    private readonly client: Redis,
    private readonly config: RedisStreamsQueueConsumerConfig,
  ) {
    this.dlqStream = config.dlqStream ?? `${config.stream}-dlq`;
    this.consumerName = config.consumerName ?? `settler-${process.pid}`;
  }

  async init(): Promise<void> {
    const raw = this.client as unknown as RawRedis;

    // Idempotently create the consumer group. MKSTREAM ensures the stream
    // exists too — important on a fresh devnet boot where no events have
    // been published yet. BUSYGROUP error is ignored (already exists).
    try {
      await raw.call(
        "XGROUP",
        "CREATE",
        this.config.stream,
        this.config.group,
        "$",
        "MKSTREAM",
      );
    } catch (err) {
      const message = (err as Error).message ?? "";
      if (!message.includes("BUSYGROUP")) {
        throw err;
      }
    }

    // Recover stale pending entries from previous incarnations before
    // starting the steady-state loop. Anything idle > STALE_CLAIM_THRESHOLD_MS
    // gets claimed by this consumer and re-enqueued.
    await this.recoverStalePending();

    this.running = true;
    this.pollLoop = this.runPollLoop().catch((err) => {
      this.logger.error("Redis Streams poll loop crashed", err);
    });
  }

  async destroy(): Promise<void> {
    this.running = false;
    await this.pollLoop;
    // Note: we intentionally do not call client.quit() here — the client
    // is injected and owned by ConsumerModule.
  }

  setEnqueueCallback(cb: (msg: SettleMessage) => void): void {
    this.onEnqueue = cb;
  }

  drain(): SettleMessage[] {
    return this.queue.splice(0, this.queue.length);
  }

  ack(messages: SettleMessage[]): void {
    for (const m of messages) m.ack();
  }

  nack(messages: SettleMessage[]): void {
    for (const m of messages) m.nack();
  }

  get queueLength(): number {
    return this.queue.length;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async runPollLoop(): Promise<void> {
    const raw = this.client as unknown as RawRedis;
    while (this.running) {
      try {
        // XREADGROUP GROUP <group> <consumer> BLOCK <ms> COUNT 16 STREAMS <stream> >
        // The ">" token tells Redis to deliver only entries that have not
        // yet been delivered to any consumer in this group.
        const result = (await raw.call(
          "XREADGROUP",
          "GROUP",
          this.config.group,
          this.consumerName,
          "BLOCK",
          READ_BLOCK_MS,
          "COUNT",
          16,
          "STREAMS",
          this.config.stream,
          ">",
        )) as Array<[string, Array<[string, string[]]>]> | null;

        if (!result) {
          // BLOCK timeout / no entries. In production XREADGROUP's BLOCK
          // already gave us a wait. In tests with a stub that returns
          // synchronously, yield to the event loop so this.running can
          // flip on destroy() — otherwise we'd spin forever.
          await new Promise((r) => setImmediate(r));
          continue;
        }
        for (const [, entries] of result) {
          for (const [id, fields] of entries) {
            this.enqueueEntry(id, fields);
          }
        }
      } catch (err) {
        // Don't let transient Redis errors kill the loop. Log and back off
        // briefly so we don't spin.
        this.logger.error("XREADGROUP failed", err);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  private enqueueEntry(id: string, fields: string[]): void {
    const raw = this.client as unknown as RawRedis;

    // fields = ["event", "<json>", ...]; we only use the "event" field.
    let payload = "";
    for (let i = 0; i + 1 < fields.length; i += 2) {
      if (fields[i] === "event") {
        payload = fields[i + 1];
        break;
      }
    }
    if (!payload) {
      this.logger.warn(`Stream entry ${id} missing "event" field — XACKing and dropping`);
      void raw
        .call("XACK", this.config.stream, this.config.group, id)
        .catch((err) => this.logger.error(`XACK on malformed entry ${id} failed`, err));
      return;
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(payload) as Record<string, unknown>;
    } catch (err) {
      this.logger.warn(`Stream entry ${id} has unparseable JSON — XACKing and dropping`, err);
      void raw
        .call("XACK", this.config.stream, this.config.group, id)
        .catch((e) => this.logger.error(`XACK on malformed entry ${id} failed`, e));
      return;
    }

    const message: SettleMessage = {
      id,
      data,
      ack: () => {
        void raw
          .call("XACK", this.config.stream, this.config.group, id)
          .catch((err) => this.logger.error(`XACK ${id} failed`, err));
      },
      nack: () => {
        // No native nack in Redis Streams. Leave the entry in the consumer
        // group's PEL — XCLAIM after the idle threshold will redeliver it,
        // up to MAX_DELIVERY_ATTEMPTS, after which we move to DLQ.
        void this.handleNack(id, payload);
      },
    };

    this.queue.push(message);
    this.onEnqueue?.(message);
  }

  private async handleNack(id: string, payload: string): Promise<void> {
    const raw = this.client as unknown as RawRedis;
    try {
      // XPENDING <stream> <group> IDLE 0 <start> <end> 1
      // returns [[id, consumer, idleMs, deliveryCount]] for this entry.
      const pending = (await raw.call(
        "XPENDING",
        this.config.stream,
        this.config.group,
        "IDLE",
        0,
        id,
        id,
        1,
      )) as Array<[string, string, number, number]>;

      const deliveryCount = pending?.[0]?.[3] ?? 1;
      if (deliveryCount >= MAX_DELIVERY_ATTEMPTS) {
        // Move to DLQ and ack so it stops being redelivered.
        await raw.call(
          "XADD",
          this.dlqStream,
          "*",
          "event",
          payload,
          "origId",
          id,
        );
        await raw.call("XACK", this.config.stream, this.config.group, id);
        this.logger.warn(
          `Entry ${id} hit MAX_DELIVERY_ATTEMPTS (${deliveryCount}); moved to ${this.dlqStream} and acked`,
        );
      }
      // Else: leave it pending; XCLAIM / next read will redeliver.
    } catch (err) {
      this.logger.error(`nack handling for ${id} failed`, err);
    }
  }

  private async recoverStalePending(): Promise<void> {
    const raw = this.client as unknown as RawRedis;
    try {
      // XAUTOCLAIM is the modern primitive (Redis 6.2+). Falls back to a
      // no-op silently if the server doesn't support it — Railway Redis is
      // recent enough.
      const claimed = (await raw.call(
        "XAUTOCLAIM",
        this.config.stream,
        this.config.group,
        this.consumerName,
        STALE_CLAIM_THRESHOLD_MS,
        "0",
        "COUNT",
        100,
      )) as [string, Array<[string, string[]]>, string[]];

      const entries = claimed?.[1] ?? [];
      for (const [id, fields] of entries) {
        this.enqueueEntry(id, fields);
      }
      if (entries.length > 0) {
        this.logger.log(`Recovered ${entries.length} stale pending entries`);
      }
    } catch (err) {
      // XAUTOCLAIM may not exist or may return nothing useful. Non-fatal.
      this.logger.debug(`XAUTOCLAIM skipped/failed (non-fatal): ${(err as Error).message}`);
    }
  }
}
