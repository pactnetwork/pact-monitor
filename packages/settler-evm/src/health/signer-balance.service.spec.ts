import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { SecretLoaderService } from '../config/secret-loader.service';
import {
  SignerBalanceService,
  WARN_THRESHOLD_WEI,
  CRIT_THRESHOLD_WEI,
  UNKNOWN_BALANCE,
} from './signer-balance.service';

const ADDR = '0x1111111111111111111111111111111111111111';

function make(accountThrows = false) {
  const config = {
    getOrThrow: (k: string) =>
      k === 'ZEROG_CHAIN_ID' ? 16_602 : 'https://evmrpc-testnet.0g.ai',
  } as unknown as ConfigService;
  const secrets = {
    get account() {
      if (accountThrows) throw new Error('Settlement key not loaded');
      return { address: ADDR };
    },
  } as unknown as SecretLoaderService;
  return new SignerBalanceService(config, secrets);
}

describe('SignerBalanceService', () => {
  let svc: SignerBalanceService;
  beforeEach(() => {
    svc = make();
  });

  it('starts UNKNOWN and reports neither low nor critical', () => {
    expect(svc.currentWei).toBe(UNKNOWN_BALANCE);
    expect(svc.isCritical).toBe(false);
    expect(svc.isLow).toBe(false);
  });

  it('classifies thresholds', () => {
    svc.setBalanceForTest(CRIT_THRESHOLD_WEI - 1n);
    expect(svc.isCritical).toBe(true);
    expect(svc.isLow).toBe(true);

    svc.setBalanceForTest(WARN_THRESHOLD_WEI - 1n);
    expect(svc.isCritical).toBe(false);
    expect(svc.isLow).toBe(true);

    svc.setBalanceForTest(WARN_THRESHOLD_WEI + 1n);
    expect(svc.isCritical).toBe(false);
    expect(svc.isLow).toBe(false);
  });

  it('poll reads native balance via the public client', async () => {
    (svc as unknown as { publicClient: unknown }).publicClient = {
      getBalance: vi.fn().mockResolvedValue(2n * 10n ** 17n),
    };
    await svc.poll();
    expect(svc.currentWei).toBe(2n * 10n ** 17n);
    expect(svc.lastError).toBeNull();
  });

  it('fail-closed: first poll RPC failure leaves balance UNKNOWN', async () => {
    (svc as unknown as { publicClient: unknown }).publicClient = {
      getBalance: vi.fn().mockRejectedValue(new Error('rpc down')),
    };
    await svc.poll();
    expect(svc.currentWei).toBe(UNKNOWN_BALANCE);
    expect(svc.lastError).toContain('rpc down');
  });

  it('skips the poll when the signer key is not loaded yet', async () => {
    const s = make(true);
    await s.poll();
    expect(s.currentWei).toBe(UNKNOWN_BALANCE);
  });
});
