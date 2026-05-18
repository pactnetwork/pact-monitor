/**
 * Per-agent webhook fan-out, invoked AFTER the ingest transaction commits
 * (never inside it, never awaited by it). Best-effort: ingest/Call rows are
 * the source of truth and the SDK poller is the durable backstop, so a failed
 * or disabled delivery is a no-op for correctness — it only costs latency.
 *
 * Feature-flagged off by default (WEBHOOK_DELIVERY_ENABLED). Module is
 * disjoint from the inbound Helius `webhook/` receiver (named `refund-delivery`
 * to avoid the collision the review flagged).
 */
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { outcomeToBreach, type WrapCallEventDto } from "../events/events.dto";
import { loadSigningKey, type WebhookCall, type WebhookPayload } from "./webhook-payload";
import { WebhookSender } from "./webhook-sender";

@Injectable()
export class RefundDeliveryService implements OnModuleInit {
  private readonly logger = new Logger(RefundDeliveryService.name);
  private enabled = false;
  private signer: { secretKey: Uint8Array; publicKeyBase58: string } | null =
    null;
  private sender!: WebhookSender;
  private maxFailCount = 20;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.enabled =
      this.config.get<string>("WEBHOOK_DELIVERY_ENABLED") === "true";
    this.maxFailCount = Number(
      this.config.get<string>("WEBHOOK_MAX_FAIL_COUNT") ?? "20",
    );
    this.sender = new WebhookSender({
      timeoutMs: Number(this.config.get("WEBHOOK_TIMEOUT_MS") ?? "5000"),
      maxAttempts: Number(this.config.get("WEBHOOK_MAX_ATTEMPTS") ?? "4"),
      backoffBaseMs: Number(this.config.get("WEBHOOK_BACKOFF_BASE_MS") ?? "500"),
      maxBodyBytes: Number(this.config.get("WEBHOOK_MAX_BODY_BYTES") ?? "262144"),
    });
    if (this.enabled) {
      const secret = this.config.get<string>("INDEXER_WEBHOOK_SIGNING_SECRET");
      if (!secret) {
        this.logger.error(
          "WEBHOOK_DELIVERY_ENABLED=true but INDEXER_WEBHOOK_SIGNING_SECRET " +
            "is unset — webhook delivery disabled.",
        );
        this.enabled = false;
        return;
      }
      try {
        this.signer = loadSigningKey(secret);
        this.logger.log(
          `refund-delivery enabled; signing pubkey ${this.signer.publicKeyBase58}`,
        );
      } catch (err) {
        this.logger.error(
          `bad INDEXER_WEBHOOK_SIGNING_SECRET: ${(err as Error).message}`,
        );
        this.enabled = false;
      }
    }
  }

  /**
   * Fire-and-forget. MUST NOT be awaited by ingest and MUST NOT throw.
   * `insertedCalls` is the exact set of brand-new calls (duplicates excluded).
   */
  enqueue(insertedCalls: WrapCallEventDto[]): void {
    if (!this.enabled || !this.signer || insertedCalls.length === 0) return;
    void this.run(insertedCalls).catch((err) => {
      this.logger.warn(`refund-delivery run failed: ${(err as Error).message}`);
    });
  }

  private async run(calls: WrapCallEventDto[]): Promise<void> {
    const byAgent = new Map<string, WrapCallEventDto[]>();
    for (const c of calls) {
      const arr = byAgent.get(c.agentPubkey) ?? [];
      arr.push(c);
      byAgent.set(c.agentPubkey, arr);
    }

    const agents = await this.prisma.agent.findMany({
      where: { pubkey: { in: [...byAgent.keys()] }, webhookUrl: { not: null } },
      select: { pubkey: true, webhookUrl: true },
    });

    await Promise.all(
      agents.map(async (a) => {
        const url = a.webhookUrl;
        if (!url) return;
        const agentCalls = byAgent.get(a.pubkey) ?? [];
        const payload: WebhookPayload = {
          type: "settlement.calls",
          version: 1,
          indexerTs: new Date().toISOString(),
          agentPubkey: a.pubkey,
          calls: agentCalls.map(toWebhookCall),
        };
        const { ok } = await this.sender.deliver({
          url,
          payload,
          secretKey: this.signer!.secretKey,
          publicKeyBase58: this.signer!.publicKeyBase58,
        });
        await this.recordResult(a.pubkey, ok);
      }),
    );
  }

  private async recordResult(pubkey: string, ok: boolean): Promise<void> {
    try {
      if (ok) {
        await this.prisma.agent.update({
          where: { pubkey },
          data: { webhookLastDeliveryAt: new Date(), webhookFailCount: 0 },
        });
        return;
      }
      const a = await this.prisma.agent.update({
        where: { pubkey },
        data: { webhookFailCount: { increment: 1 } },
        select: { webhookFailCount: true },
      });
      if (a.webhookFailCount >= this.maxFailCount) {
        await this.prisma.agent.update({
          where: { pubkey },
          data: { webhookUrl: null, webhookFailCount: 0 },
        });
        this.logger.warn(
          `auto-disabled webhook for ${pubkey} after ${this.maxFailCount} failures`,
        );
      }
    } catch (err) {
      // Best-effort bookkeeping; never escalate.
      this.logger.debug(`recordResult ${pubkey}: ${(err as Error).message}`);
    }
  }
}

function toWebhookCall(c: WrapCallEventDto): WebhookCall {
  const { breach } = outcomeToBreach(c.outcome);
  return {
    callId: c.callId,
    agentPubkey: c.agentPubkey,
    endpointSlug: c.endpointSlug,
    premiumLamports: c.premiumLamports,
    refundLamports: c.refundLamports,
    breach,
    settledAt: c.settledAt,
    signature: c.signature,
  };
}
