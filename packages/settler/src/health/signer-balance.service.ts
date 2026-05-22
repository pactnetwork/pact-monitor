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
import { AdaptersService } from "../adapters/adapters.service";
import { hasSolanaNetwork } from "../config/enabled-networks";

/** 1 SOL = 1e9 lamports. */
export const LAMPORTS_PER_SOL = 1_000_000_000;

/** 1 native gas token (e.g. 1 ETH) = 1e18 wei. */
export const WEI_PER_NATIVE = 1_000_000_000_000_000_000n;

/**
 * EVM signer gas-balance thresholds (multi-evm WP T4), in wei. Parallel to the
 * SOL thresholds: WARN at 0.01 native token, CRIT at 0.003. Overridable per
 * chain via env (see resolveEvmGasThreshold). Native gas is monitored as a
 * warn/alert signal (log + gauge); it does NOT gate the settler /health probe
 * (one underfunded EVM chain must not deroute the whole settler).
 */
export const EVM_GAS_WARN_WEI = 10_000_000_000_000_000n; // 0.01 native token
export const EVM_GAS_CRIT_WEI = 3_000_000_000_000_000n; // 0.003 native token

export type EvmSignerStatus = "ok" | "warn" | "crit";

export interface EvmSignerState {
  /** Native gas-token balance in wei. */
  wei: bigint;
  status: EvmSignerStatus;
}

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
  /** True iff a solana-* network is enabled; gates the Solana balance poll. */
  private readonly solanaEnabled: boolean;
  /** Solana RPC connection — null on an EVM-only settler (multi-evm WP T5). */
  private readonly connection: Connection | null;
  private readonly balanceGauge: Gauge;
  private readonly evmGasGauge: Gauge<"network">;
  private _lamports: number = UNKNOWN_BALANCE;
  private _lastPolledAt: number | null = null;
  private _lastError: string | null = null;
  /** Last observed EVM signer gas balance + status, keyed by network. */
  private readonly _evm = new Map<string, EvmSignerState>();

  constructor(
    private readonly config: ConfigService,
    private readonly secrets: SecretLoaderService,
    private readonly adapters: AdaptersService,
  ) {
    this.solanaEnabled = hasSolanaNetwork(
      this.config.get<string>("PACT_ENABLED_NETWORKS"),
    );
    // Build the Solana RPC connection only when a Solana network is enabled, so
    // an EVM-only settler boots without SOLANA_RPC_URL (multi-evm WP T5). When
    // enabled, behave exactly as today (fail-fast on a missing SOLANA_RPC_URL).
    if (this.solanaEnabled) {
      const rpc = this.config.getOrThrow<string>("SOLANA_RPC_URL");
      this.connection = new Connection(rpc, "confirmed");
    } else {
      this.connection = null;
      this.logger.log(
        "[settler] EVM-only boot — Solana signer balance monitoring disabled",
      );
    }

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

    const existingEvm = register.getSingleMetric(
      "settler_evm_signer_gas_native",
    );
    this.evmGasGauge =
      (existingEvm as Gauge<"network"> | undefined) ??
      new Gauge({
        name: "settler_evm_signer_gas_native",
        help: "EVM settler signer native gas-token balance, per network (1 = 1 native token, e.g. 1 ETH). Drives the EVM signer-low-gas alert.",
        labelNames: ["network"] as const,
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
   * Public for tests + first-pass at boot. Idempotent. Runs the Solana signer
   * check (unchanged) AND the per-network EVM signer gas-balance check. The two
   * are independent: an EVM RPC failure does not affect the Solana result, and
   * a missing Solana keypair (EVM-only deploy) does not skip the EVM checks.
   */
  async poll(): Promise<void> {
    await this.pollSolana();
    await this.pollEvmSigners();
  }

  /** Whether the Solana signer SOL balance is monitored (a solana-* net enabled). */
  get solanaMonitored(): boolean {
    return this.solanaEnabled;
  }

  /** Solana SettlementAuthority signer SOL-balance poll. */
  private async pollSolana(): Promise<void> {
    // EVM-only settler: no Solana signer to monitor (multi-evm WP T5).
    if (!this.solanaEnabled || !this.connection) return;
    const connection = this.connection;
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
      const lamports = await connection.getBalance(signer, "confirmed");
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
      //
      // Fail-closed by design: if this is the FIRST poll attempt and it fails
      // (e.g. SOLANA_RPC_URL is misconfigured at boot), `_lamports` stays at
      // UNKNOWN_BALANCE (-1), which causes `/health` to return HTTP 503. That
      // is the desired behavior — when we cannot determine signer balance we
      // must not accept settle traffic, because we have no evidence the
      // signer can actually pay tx fees. The cron will retry every 5 minutes;
      // once a poll succeeds, /health flips back to 200 automatically.
      this._lastError = (err as Error).message ?? String(err);
      this.logger.warn(
        `signer balance poll failed: ${this._lastError} (gauge unchanged)`,
      );
    }
  }

  /**
   * Poll the native gas-token balance of each ENABLED EVM signer (multi-evm WP
   * T4). Per-network isolated: a network with no loaded signer (read-only
   * deploy) or an RPC failure is logged and skipped, never thrown — one chain's
   * problem must not abort the others or the Solana check.
   */
  private async pollEvmSigners(): Promise<void> {
    let networks: string[];
    try {
      networks = this.adapters.listEnabledNetworks();
    } catch {
      // Adapters not bootstrapped yet (cold-boot race) — the cron will retry.
      return;
    }

    for (const network of networks) {
      let adapter;
      try {
        adapter = this.adapters.getAdapter(network);
      } catch {
        continue;
      }
      if (adapter.descriptor.vm !== "evm") continue;
      if (typeof adapter.getNativeBalance !== "function") continue;

      let account: { address: string };
      try {
        account = this.adapters.getEvmAccount(network);
      } catch {
        // Read-only deploy (no EVM signer loaded) — nothing to monitor.
        this.logger.debug(
          `[evm-gas] no signer loaded for ${network}; skipping gas-balance poll`,
        );
        continue;
      }

      try {
        const wei = await adapter.getNativeBalance(account.address);
        const warnWei = this.resolveEvmGasThreshold(network, "WARN");
        const critWei = this.resolveEvmGasThreshold(network, "CRIT");
        const status: EvmSignerStatus =
          wei < critWei ? "crit" : wei < warnWei ? "warn" : "ok";
        this._evm.set(network, { wei, status });

        const native = Number(wei) / Number(WEI_PER_NATIVE);
        this.evmGasGauge.set({ network }, native);

        const detail = `${native.toFixed(6)} native (wei=${wei})`;
        if (status === "crit") {
          this.logger.error(
            `[evm-gas] ${network} signer ${account.address} CRITICAL: ${detail} — below ${critWei} wei`,
          );
        } else if (status === "warn") {
          this.logger.warn(
            `[evm-gas] ${network} signer ${account.address} LOW: ${detail} — below ${warnWei} wei`,
          );
        } else {
          this.logger.log(
            `[evm-gas] ${network} signer ${account.address} balance: ${detail}`,
          );
        }
      } catch (err) {
        // RPC failure for this chain — log and continue; the gauge keeps its
        // last value and alerts use an evaluation window.
        this.logger.warn(
          `[evm-gas] balance poll failed for ${network}: ${
            (err as Error).message ?? String(err)
          }`,
        );
      }
    }
  }

  /**
   * Resolve an EVM gas-balance threshold (wei) for a network. Precedence:
   *   1. per-chain env  PACT_EVM_GAS_<WARN|CRIT>_WEI_<NETWORK_UPPER>
   *   2. global env     PACT_EVM_GAS_<WARN|CRIT>_WEI
   *   3. baked default  EVM_GAS_WARN_WEI / EVM_GAS_CRIT_WEI
   * where NETWORK_UPPER = network.replace(/-/g, "_").toUpperCase() (matching the
   * chain-scoped env convention from WP T1).
   */
  private resolveEvmGasThreshold(
    network: string,
    kind: "WARN" | "CRIT",
  ): bigint {
    const suffix = network.replace(/-/g, "_").toUpperCase();
    const globalKey = `PACT_EVM_GAS_${kind}_WEI`;
    const raw =
      this.config.get<string>(`${globalKey}_${suffix}`) ??
      this.config.get<string>(globalKey);
    if (raw) {
      try {
        return BigInt(raw);
      } catch {
        this.logger.warn(
          `[evm-gas] invalid ${globalKey}_${suffix}/${globalKey}="${raw}"; using default`,
        );
      }
    }
    return kind === "WARN" ? EVM_GAS_WARN_WEI : EVM_GAS_CRIT_WEI;
  }

  /** Last observed EVM signer gas state for a network, or undefined if untracked. */
  getEvmSignerState(network: string): EvmSignerState | undefined {
    return this._evm.get(network);
  }

  /** Networks for which an EVM signer gas balance has been recorded. */
  listEvmSignerNetworks(): string[] {
    return [...this._evm.keys()];
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
