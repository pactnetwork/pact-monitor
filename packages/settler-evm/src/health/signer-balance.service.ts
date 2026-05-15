/**
 * Polls the settlement-authority EOA's native 0G balance. EVM port of the
 * Solana settler's `SignerBalanceService` (SOL → native 0G, lamports → wei).
 *
 * Exposes:
 *   1. Prometheus gauge `settler_evm_signer_0g_wei` (-1 = unknown).
 *   2. `currentWei` / `isCritical` / `isLow` for the readiness probe.
 *
 * Fail-closed: if the FIRST poll fails (bad RPC at boot), the balance stays
 * UNKNOWN and `/health` returns 503 — we must not accept settle traffic when
 * we cannot prove the signer can pay gas. The cron retries every 5 min.
 *
 * Thresholds (0G demo wallet funded ~1 0G; 0G gas/storage fees are µ0G-scale):
 *   - WARN  < 0.05 0G   → /health `degraded` (200, alert routes)
 *   - CRIT  < 0.01 0G   → /health `unhealthy` (503, LB deroutes)
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { formatEther, type PublicClient } from 'viem';
import { Gauge, register } from 'prom-client';
import { SecretLoaderService } from '../config/secret-loader.service';
import { defineZerogChain } from '../chain/chain';
import { createPublicClient, http } from 'viem';

export const WARN_THRESHOLD_WEI = 5n * 10n ** 16n; // 0.05 0G
export const CRIT_THRESHOLD_WEI = 1n * 10n ** 16n; // 0.01 0G
export const UNKNOWN_BALANCE = -1n;

@Injectable()
export class SignerBalanceService implements OnModuleInit {
  private readonly logger = new Logger(SignerBalanceService.name);
  private publicClient: PublicClient | null = null;
  private readonly balanceGauge: Gauge;
  private _wei: bigint = UNKNOWN_BALANCE;
  private _lastPolledAt: number | null = null;
  private _lastError: string | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly secrets: SecretLoaderService,
  ) {
    const existing = register.getSingleMetric('settler_evm_signer_0g_wei');
    this.balanceGauge =
      (existing as Gauge | undefined) ??
      new Gauge({
        name: 'settler_evm_signer_0g_wei',
        help: 'SettlementAuthority signer native 0G balance, in wei. -1 = unknown (RPC failure).',
      });
  }

  async onModuleInit(): Promise<void> {
    await this.poll();
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async tick(): Promise<void> {
    await this.poll();
  }

  async poll(): Promise<void> {
    let address: `0x${string}`;
    try {
      address = this.secrets.account.address;
    } catch (err) {
      this.logger.warn(
        `signer key not yet loaded; skipping balance poll: ${(err as Error).message}`,
      );
      return;
    }

    if (!this.publicClient) {
      const chainId = this.config.getOrThrow<number>('ZEROG_CHAIN_ID');
      const rpcUrl = this.config.getOrThrow<string>('ZEROG_RPC_URL');
      const chain = defineZerogChain(chainId, rpcUrl);
      this.publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    }

    try {
      const wei = await this.publicClient.getBalance({ address });
      this._wei = wei;
      this._lastPolledAt = Date.now();
      this._lastError = null;
      this.balanceGauge.set(Number(wei));

      const og = formatEther(wei);
      if (wei < CRIT_THRESHOLD_WEI) {
        this.logger.error(`signer ${address} CRITICAL: ${og} 0G`);
      } else if (wei < WARN_THRESHOLD_WEI) {
        this.logger.warn(`signer ${address} LOW: ${og} 0G`);
      } else {
        this.logger.log(`signer ${address} balance: ${og} 0G`);
      }
    } catch (err) {
      this._lastError = (err as Error).message ?? String(err);
      this.logger.warn(
        `signer balance poll failed: ${this._lastError} (gauge unchanged)`,
      );
    }
  }

  get currentWei(): bigint {
    return this._wei;
  }
  get lastPolledAt(): number | null {
    return this._lastPolledAt;
  }
  get lastError(): string | null {
    return this._lastError;
  }
  get isCritical(): boolean {
    return this._wei !== UNKNOWN_BALANCE && this._wei < CRIT_THRESHOLD_WEI;
  }
  get isLow(): boolean {
    return this._wei !== UNKNOWN_BALANCE && this._wei < WARN_THRESHOLD_WEI;
  }

  /** Test-only: inject a balance, skip the RPC call. */
  setBalanceForTest(wei: bigint): void {
    this._wei = wei;
    this._lastPolledAt = Date.now();
    this._lastError = null;
    this.balanceGauge.set(Number(wei));
  }
}
