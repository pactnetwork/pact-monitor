/**
 * IndexerPusherService — POSTs a settlement summary to the indexer's `/events`
 * endpoint after a batch is confirmed on-chain.
 *
 * Body shape (Step D #62 + #59 of the Network/Market layering refactor):
 *
 *   {
 *     signature: <base58 tx signature>,
 *     batchSize: <int>,
 *     totalPremiumsLamports: <bigint string>,
 *     totalRefundsLamports:  <bigint string>,
 *     ts: <ISO8601>,
 *     calls: [
 *       {
 *         callId, agentPubkey, endpointSlug,
 *         premiumLamports: <bigint string>,
 *         refundLamports:  <bigint string>,
 *         latencyMs, outcome, ts, settledAt, signature,
 *         source?, payee?, resource?,   // pay.sh-covered calls carry these
 *         shares: [
 *           { kind: 0|1|2, pubkey, amountLamports: <bigint string> },
 *           ...
 *         ]
 *       }
 *     ]
 *   }
 *
 * `outcome` is the canonical wrap-library Outcome string
 * (`ok | latency_breach | server_error | client_error | network_error`). The
 * indexer's split-error-classification migration stores this verbatim.
 *
 * `shares` mirrors on-chain `settle_batch` fee fan-out: one entry per
 * EndpointConfig.fee_recipients[i] with the rounded-down `premium * bps /
 * 10_000` amount actually transferred. Source data is the EndpointConfig
 * snapshot the SubmitterService captured at submit time.
 */
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";

import { SettleBatch } from "../batcher/batcher.service";
import {
  RecipientShare,
  SettlementOutcome,
} from "../submitter/submitter.service";

@Injectable()
export class IndexerPusherService {
  private readonly logger = new Logger(IndexerPusherService.name);
  private readonly indexerUrl: string;
  private readonly secret: string;

  constructor(private readonly config: ConfigService) {
    this.indexerUrl = this.config.getOrThrow<string>("INDEXER_URL");
    this.secret = this.config.getOrThrow<string>("INDEXER_PUSH_SECRET");
  }

  async push(outcome: SettlementOutcome, batch: SettleBatch): Promise<void> {
    const { signature, perEventShares } = outcome;
    const settledAt = new Date().toISOString();

    const calls = batch.messages.map((m, idx) => {
      const d = m.data as Record<string, unknown>;
      const shares: RecipientShare[] = perEventShares[idx] ?? [];
      return {
        callId: d["callId"] as string,
        agentPubkey: d["agentPubkey"] as string,
        endpointSlug: d["endpointSlug"] as string,
        premiumLamports: String(d["premiumLamports"]),
        refundLamports: String(d["refundLamports"] ?? "0"),
        latencyMs: d["latencyMs"] as number,
        outcome: (d["outcome"] as string | undefined) ?? "ok",
        // Pass through `source` (and, for pay.sh-covered calls, `payee` /
        // `resource`) so the indexer can tag the Call row. Gateway-path events
        // carry no `source` today; pay.sh events from facilitator.pact.network
        // carry source: "pay.sh" + payee + resource. Absent keys → undefined →
        // omitted from the JSON → indexer stores NULL.
        source: d["source"] as string | undefined,
        payee: d["payee"] as string | undefined,
        resource: d["resource"] as string | undefined,
        ts: d["ts"] as string | undefined,
        settledAt,
        signature,
        shares: shares.map((s) => ({
          kind: s.kind,
          pubkey: s.pubkey,
          amountLamports: s.amountLamports.toString(),
        })),
      };
    });

    const body = {
      signature,
      batchSize: batch.messages.length,
      totalPremiumsLamports: String(
        calls.reduce((sum, c) => sum + BigInt(c.premiumLamports), 0n),
      ),
      totalRefundsLamports: String(
        calls.reduce((sum, c) => sum + BigInt(c.refundLamports), 0n),
      ),
      ts: settledAt,
      calls,
    };

    await this.postWithRetry(body, 3);
  }

  private async postWithRetry(
    body: unknown,
    maxAttempts: number,
  ): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await axios.post(`${this.indexerUrl}/events`, body, {
          headers: { Authorization: `Bearer ${this.secret}` },
          timeout: 10_000,
        });
        return;
      } catch (err) {
        lastErr = err;
        this.logger.warn(
          `indexer push attempt ${attempt}/${maxAttempts} failed: ${err}`,
        );
        if (attempt < maxAttempts) {
          await sleep(500 * 2 ** (attempt - 1));
        }
      }
    }
    // THROW on permanent failure — previously this method swallowed the error
    // and returned, which let PipelineService ack Pub/Sub for a settled-on-
    // chain-but-not-indexed batch, permanently losing the call records from
    // the indexer's view (Alan + codex review). Now the pipeline catches and
    // can decide whether to nack or surface.
    throw new IndexerPushError(
      `indexer push failed permanently after ${maxAttempts} attempts`,
      { cause: lastErr },
    );
  }
}

export class IndexerPushError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "IndexerPushError";
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
