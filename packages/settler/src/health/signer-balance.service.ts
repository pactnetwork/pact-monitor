/**
 * SignerBalanceService — periodically polls the settler's SettlementAuthority
 * signer SOL balance and exposes it on:
 *
 *   1. A Prometheus gauge `settler_signer_sol_lamports` (scraped by Cloud
 *      Monitoring via the prom-to-stackdriver sidecar / managed-prom pipeline).
 *   2. A synchronous accessor `currentLamports` consumed by HealthController
 *      so the readiness probe (and the LB) can fail-closed when the signer is
 *      below the hard floor.
 *
 * Why this lives in the settler (approach "c") rather than a separate Cloud
 * Run Job / Function:
 *   - settler already runs with min_instances=1 (per pact-network terraform
 *     services.tf), so the metric is emitted continuously without a new
 *     scheduler resource.
 *   - The signer keypair is already loaded in this process via
 *     SecretLoaderService — no need to grant a second SA access to the
 *     PACT_SETTLEMENT_AUTHORITY_BS58 secret.
 *   - Balance + queue lag + lastSuccessAt all fall under one health story.
 *
 * Thresholds (V1):
 *   - WARN  < 0.01 SOL  (~1000 settle_batch txs at 10k lamports/tx)
 *   - CRIT  < 0.003 SOL (~300 settle_batch txs)  → /health returns 503
 *
 * The hard floor of 0.003 SOL was chosen because at ~10k lamports/settle and
 * 5-min poll interval, an upper-bound burst rate of 30 settles/min would
 * deplete from CRIT to zero in ~10 min — long enough for an on-call response.
 *
 * Background: see docs/runbooks/settler-signer-low-sol.md and the 2026-05-07
 * mainnet first-settle postmortem (signer shipped with 0 SOL, blocked smoke
 * for 50 minutes).
 */
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron, CronExpression } from "@nestjs/schedule";
import { Connection, PublicKey } from "@solana/web3.js";
import { Gauge, register } from "prom-client";

import { SecretLoaderService } from "../config/secret-loader.service";

/** 1 SOL = 1e9 lamports. */
export const LAMPORTS_PER_SOL = 1_000_000_000;

/** WARN threshold: 0.01 SOL ~= 1000 settles. */
export const WARN_THRESHOLD_LAMPORTS = 10_000_000;

/**
 * CRIT (unhealthy) threshold: 0.003 SOL ~= 300 settles. Below this the
 * /health endpoint flips to HTTP 503 so Cloud Run / the LB can deroute.
 */
export const CRIT_THRESHOLD_LAMPORTS = 3_000_000;

/** Sentinel for "we have not yet successfully polled the RPC." */
export const UNKNOWN_BALANCE = -1;

@Injectable()
export class SignerBalanceService implements OnModuleInit {
  private readonly logger = new Logger(SignerBalanceService.name);
  private readonly connection: Connection;
  private readonly balanceGauge: Gauge;
  private _lamports: number = UNKNOWN_BALANCE;
  private _lastPolledAt: number | null = null;
  private _lastError: string | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly secrets: SecretLoaderService,
  ) {
    const rpc = this.config.getOrThrow<string>("SOLANA_RPC_URL");
    this.connection = new Connection(rpc, "confirmed");

    // Reuse the global registry so /metrics surfaces the gauge alongside the
    // existing pipeline metrics. Guard against duplicate registration when
    // multiple test modules instantiate the service.
    const existing = register.getSingleMetric("settler_signer_sol_lamports");
    this.balanceGauge =
      (existing as Gauge | undefined) ??
      new Gauge({
        name: "settler_signer_sol_lamports",
        help: "SettlementAuthority signer SOL balance, in lamports. Drives signer-low-sol alert. -1 = unknown (RPC failure).",
      });
  }

  async onModuleInit(): Promise<void> {
    // Eager poll at boot so the health endpoint reflects reality before the
    // first cron tick. Failures here are non-fatal — the cron will retry.
    await this.poll();
  }

  /**
   * Cron: every 5 minutes. Aligned with the Cloud Monitoring alert evaluation
   * window. Does not block module init; logs and swallows transient RPC
   * failures (the gauge stays at the last known value, sentinel -1 on
   * never-polled).
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async tick(): Promise<void> {
    await this.poll();
  }

  /**
   * Public for tests + first-pass at boot. Idempotent.
   */
  async poll(): Promise<void> {
    let signer: PublicKey;
    try {
      signer = this.secrets.keypair.publicKey;
    } catch (err) {
      // Keypair not loaded yet — secret-loader runs in the same OnModuleInit
      // wave, so on cold boot we may race. Skip this tick.
      this.logger.warn(
        `signer keypair not yet loaded; skipping balance poll: ${(err as Error).message}`,
      );
      return;
    }

    try {
      const lamports = await this.connection.getBalance(signer, "confirmed");
      this._lamports = lamports;
      this._lastPolledAt = Date.now();
      this._lastError = null;
      this.balanceGauge.set(lamports);

      if (lamports < CRIT_THRESHOLD_LAMPORTS) {
        this.logger.error(
          `signer ${signer.toBase58()} CRITICAL: ${lamports} lamports (${(lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL) — below ${CRIT_THRESHOLD_LAMPORTS}`,
        );
      } else if (lamports < WARN_THRESHOLD_LAMPORTS) {
        this.logger.warn(
          `signer ${signer.toBase58()} LOW: ${lamports} lamports (${(lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL) — below ${WARN_THRESHOLD_LAMPORTS}`,
        );
      } else {
        this.logger.log(
          `signer ${signer.toBase58()} balance: ${lamports} lamports (${(lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL)`,
        );
      }
    } catch (err) {
      // RPC failure: keep the previous gauge value (alerts use a window so a
      // single missed poll won't trip them). Surface via /health for ops.
      this._lastError = (err as Error).message ?? String(err);
      this.logger.warn(
        `signer balance poll failed: ${this._lastError} (gauge unchanged)`,
      );
    }
  }

  /** Last observed balance, in lamports. -1 if never successfully polled. */
  get currentLamports(): number {
    return this._lamports;
  }

  /** Unix-ms of the last successful poll, or null if never. */
  get lastPolledAt(): number | null {
    return this._lastPolledAt;
  }

  /** Error string from the last poll, or null on success. */
  get lastError(): string | null {
    return this._lastError;
  }

  /** Convenience: true iff we've polled at least once and balance is below CRIT. */
  get isCritical(): boolean {
    return (
      this._lamports !== UNKNOWN_BALANCE &&
      this._lamports < CRIT_THRESHOLD_LAMPORTS
    );
  }

  /** Convenience: true iff we've polled at least once and balance is below WARN. */
  get isLow(): boolean {
    return (
      this._lamports !== UNKNOWN_BALANCE &&
      this._lamports < WARN_THRESHOLD_LAMPORTS
    );
  }

  /** Test-only: forcibly inject a balance (skip the RPC call). */
  setBalanceForTest(lamports: number): void {
    this._lamports = lamports;
    this._lastPolledAt = Date.now();
    this._lastError = null;
    this.balanceGauge.set(lamports);
  }
}
