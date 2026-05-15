// @pact-network/wrap — event sinks.
//
// Four sink implementations. All `publish` calls MUST swallow errors so
// the wrapped fetch hot path never blocks on event delivery — settlement
// is reconciled out-of-band by the settler worker via the same stream.
//
// - PubSubEventSink         — `@google-cloud/pubsub`. Listed as a peer dep
//                             so consumers without GCP don't pull the
//                             transitive grpc tree.
// - RedisStreamsEventSink   — XADD to a Redis stream. Consumer (e.g.
//                             ioredis) is injected as a `RedisStreamPublisher`
//                             interface so this package stays free of any
//                             Redis client dep. Used by devnet (Railway)
//                             where Pub/Sub isn't available.
// - HttpEventSink           — POST JSON to an arbitrary URL with bearer auth.
// - MemoryEventSink         — in-memory array, primarily for tests.

import type { SettlementEvent } from "./types";

export interface EventSink {
  publish(event: SettlementEvent): Promise<void>;
}

// ---------------------------------------------------------------------------
// MemoryEventSink
// ---------------------------------------------------------------------------

export class MemoryEventSink implements EventSink {
  /** Public so tests can introspect. */
  public readonly events: SettlementEvent[] = [];

  async publish(event: SettlementEvent): Promise<void> {
    this.events.push(event);
  }

  reset(): void {
    this.events.length = 0;
  }
}

// ---------------------------------------------------------------------------
// HttpEventSink
// ---------------------------------------------------------------------------

export interface HttpEventSinkOptions {
  /** Endpoint that accepts POST {event} JSON, e.g. an internal ingest. */
  url: string;
  /** Optional bearer secret. If set, sent as `Authorization: Bearer <secret>`. */
  secret?: string;
  /** Optional fetch override (tests). */
  fetchImpl?: typeof fetch;
  /**
   * Optional logger called with publish failures. Default: console.warn.
   * Failures are NEVER thrown — they only flow through this hook.
   */
  onError?: (err: unknown) => void;
}

export class HttpEventSink implements EventSink {
  private readonly url: string;
  private readonly secret: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly onError: (err: unknown) => void;

  constructor(opts: HttpEventSinkOptions) {
    this.url = opts.url;
    this.secret = opts.secret;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.onError =
      opts.onError ??
      ((err) => {
        // eslint-disable-next-line no-console
        console.warn("wrap.HttpEventSink: publish failed", err);
      });
  }

  async publish(event: SettlementEvent): Promise<void> {
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (this.secret) headers.authorization = `Bearer ${this.secret}`;

      const resp = await this.fetchImpl(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(event),
      });
      if (!resp.ok) {
        this.onError(
          new Error(`wrap.HttpEventSink: ${this.url} returned ${resp.status}`),
        );
      }
    } catch (err) {
      this.onError(err);
    }
  }
}

// ---------------------------------------------------------------------------
// PubSubEventSink
// ---------------------------------------------------------------------------
//
// `@google-cloud/pubsub` is not bundled. We accept a pre-built topic
// publisher via DI so:
//   (a) consumers without GCP don't pay the transitive cost,
//   (b) tests can stub the publisher trivially,
//   (c) the wrap library stays free of GCP creds plumbing.
//
// The shape we depend on is the smallest viable subset of
// `Topic.publishMessage({ json })` from `@google-cloud/pubsub`.

export interface PubSubTopicPublisher {
  publishMessage(args: { json: SettlementEvent }): Promise<string>;
}

export interface PubSubEventSinkOptions {
  /** Pre-built topic publisher. Use `pubsub.topic(name)` from @google-cloud/pubsub. */
  topic: PubSubTopicPublisher;
  /** Optional logger called with publish failures. Default: console.warn. */
  onError?: (err: unknown) => void;
}

export class PubSubEventSink implements EventSink {
  private readonly topic: PubSubTopicPublisher;
  private readonly onError: (err: unknown) => void;

  constructor(opts: PubSubEventSinkOptions) {
    this.topic = opts.topic;
    this.onError =
      opts.onError ??
      ((err) => {
        // eslint-disable-next-line no-console
        console.warn("wrap.PubSubEventSink: publish failed", err);
      });
  }

  async publish(event: SettlementEvent): Promise<void> {
    try {
      await this.topic.publishMessage({ json: event });
    } catch (err) {
      this.onError(err);
    }
  }
}

// ---------------------------------------------------------------------------
// RedisStreamsEventSink
// ---------------------------------------------------------------------------
//
// XADD-based event sink. `ioredis` (or any Redis client) is not bundled.
// We accept a pre-built publisher via DI for the same reasons PubSubEventSink
// does:
//   (a) consumers without Redis don't pay the transitive cost,
//   (b) tests can stub the publisher trivially,
//   (c) the wrap library stays free of Redis-client plumbing.
//
// The shape we depend on is the smallest viable subset of ioredis'
// `xadd(stream, "*", field, value)` signature, normalised to a single call
// per event so the publisher implementation can adapt to non-ioredis
// clients (node-redis, mocked test doubles, etc.) without changing this
// file.

export interface RedisStreamPublisher {
  /**
   * Append `event` (serialised) to `stream`. The publisher is responsible
   * for picking a Redis client method (`xadd`, `XADD` over RESP, etc.) and
   * for ID generation (typically `"*"`).
   *
   * Must resolve with the assigned stream entry ID on success, or reject
   * on error. The sink swallows rejections — callers should not throw.
   */
  publish(stream: string, event: SettlementEvent): Promise<string>;
}

export interface RedisStreamsEventSinkOptions {
  /** Pre-built Redis stream publisher. */
  publisher: RedisStreamPublisher;
  /** Stream name to XADD into. Default: `"pact-settle-events"`. */
  stream?: string;
  /** Optional logger called with publish failures. Default: console.warn. */
  onError?: (err: unknown) => void;
}

export class RedisStreamsEventSink implements EventSink {
  private readonly publisher: RedisStreamPublisher;
  private readonly stream: string;
  private readonly onError: (err: unknown) => void;

  constructor(opts: RedisStreamsEventSinkOptions) {
    this.publisher = opts.publisher;
    this.stream = opts.stream ?? "pact-settle-events";
    this.onError =
      opts.onError ??
      ((err) => {
        // eslint-disable-next-line no-console
        console.warn("wrap.RedisStreamsEventSink: publish failed", err);
      });
  }

  async publish(event: SettlementEvent): Promise<void> {
    try {
      await this.publisher.publish(this.stream, event);
    } catch (err) {
      this.onError(err);
    }
  }
}
