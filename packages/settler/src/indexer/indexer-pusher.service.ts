import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import { SettleBatch } from "../batcher/batcher.service";

@Injectable()
export class IndexerPusherService {
  private readonly logger = new Logger(IndexerPusherService.name);
  private readonly indexerUrl: string;
  private readonly secret: string;

  constructor(private readonly config: ConfigService) {
    this.indexerUrl = this.config.getOrThrow<string>("INDEXER_URL");
    this.secret = this.config.getOrThrow<string>("INDEXER_PUSH_SECRET");
  }

  async push(signature: string, batch: SettleBatch): Promise<void> {
    const calls = batch.messages.map((m) => {
      const d = m.data as Record<string, unknown>;
      return {
        callId: d["callId"] as string,
        agentPubkey: d["agentPubkey"] as string,
        endpointSlug: d["endpointSlug"] as string,
        premiumLamports: String(d["premiumLamports"]),
        refundLamports: String(d["refundLamports"]),
        latencyMs: d["latencyMs"] as number,
        breach: d["breach"] as boolean,
        breachReason: d["breachReason"] as string | undefined,
        source: d["source"] as string | undefined,
        ts: d["ts"] as string,
        settledAt: new Date().toISOString(),
        signature,
      };
    });

    const body = {
      signature,
      batchSize: batch.messages.length,
      totalPremiumsLamports: String(
        calls.reduce((s, c) => s + BigInt(c.premiumLamports), 0n)
      ),
      totalRefundsLamports: String(
        calls.reduce((s, c) => s + BigInt(c.refundLamports), 0n)
      ),
      ts: new Date().toISOString(),
      calls,
    };

    await this.postWithRetry(body, 3);
  }

  private async postWithRetry(body: unknown, maxAttempts: number): Promise<void> {
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
        this.logger.warn(`indexer push attempt ${attempt}/${maxAttempts} failed: ${err}`);
        if (attempt < maxAttempts) {
          await sleep(500 * 2 ** (attempt - 1));
        }
      }
    }
    this.logger.error(`indexer push failed permanently after ${maxAttempts} attempts: ${lastErr}`);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
