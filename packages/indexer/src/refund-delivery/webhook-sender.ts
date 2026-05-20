/**
 * Single-agent webhook POST: SSRF-checked, signed, bounded-retry, never
 * throws. Best-effort by design — the Call rows are the source of truth and
 * the SDK poller is the durable backstop, so a failed delivery is logged and
 * dropped, never retried forever and never allowed to affect ingest.
 */
import { Logger } from "@nestjs/common";
import {
  assertSafeWebhookUrl,
  safeDispatcher,
  SsrfRejectedError,
} from "./ssrf-guard";
import {
  signWebhook,
  type WebhookPayload,
} from "./webhook-payload";

export interface WebhookSenderConfig {
  timeoutMs: number;
  maxAttempts: number;
  backoffBaseMs: number;
  maxBodyBytes: number;
}

export interface DeliverArgs {
  url: string;
  payload: WebhookPayload;
  secretKey: Uint8Array;
  publicKeyBase58: string;
}

export class WebhookSender {
  private readonly logger = new Logger(WebhookSender.name);

  constructor(private readonly cfg: WebhookSenderConfig) {}

  /** Resolves { ok }. NEVER throws. */
  async deliver(args: DeliverArgs): Promise<{ ok: boolean }> {
    let safeUrl: URL;
    try {
      safeUrl = assertSafeWebhookUrl(args.url);
    } catch (err) {
      this.logger.warn(
        `webhook URL rejected (${args.payload.agentPubkey}): ${
          err instanceof SsrfRejectedError ? err.message : String(err)
        }`,
      );
      return { ok: false };
    }

    const { headers, body } = signWebhook({
      secretKey: args.secretKey,
      publicKeyBase58: args.publicKeyBase58,
      webhookUrl: safeUrl.toString(),
      payload: args.payload,
    });
    if (new TextEncoder().encode(body).byteLength > this.cfg.maxBodyBytes) {
      this.logger.warn(
        `webhook payload over ${this.cfg.maxBodyBytes}B for ` +
          `${args.payload.agentPubkey}; dropping`,
      );
      return { ok: false };
    }

    const dispatcher = safeDispatcher(this.cfg.timeoutMs);
    try {
      for (let attempt = 1; attempt <= this.cfg.maxAttempts; attempt++) {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), this.cfg.timeoutMs);
        try {
          const res = await fetch(safeUrl.toString(), {
            method: "POST",
            headers,
            body,
            redirect: "manual",
            signal: ac.signal,
            // @ts-expect-error undici-specific option on global fetch
            dispatcher,
          });
          // 2xx => done. 4xx => agent rejected (bad sig / clock); retrying
          // won't help — stop. 3xx (manual) / 5xx => transient, retry.
          if (res.status >= 200 && res.status < 300) return { ok: true };
          if (res.status >= 400 && res.status < 500) {
            this.logger.debug(
              `webhook ${args.payload.agentPubkey} got ${res.status}; no retry`,
            );
            return { ok: false };
          }
        } catch (err) {
          this.logger.debug(
            `webhook attempt ${attempt} failed (${args.payload.agentPubkey}): ${
              (err as Error).message
            }`,
          );
        } finally {
          clearTimeout(t);
        }
        if (attempt < this.cfg.maxAttempts) {
          const backoff =
            this.cfg.backoffBaseMs *
            2 ** (attempt - 1) *
            (0.5 + Math.random()); // full jitter
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
      return { ok: false };
    } finally {
      void dispatcher.close().catch(() => {});
    }
  }
}
