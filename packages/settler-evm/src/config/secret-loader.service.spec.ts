import { describe, it, expect } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { SecretLoaderService } from './secret-loader.service';

// A known test key (Anvil account #0) — never used on any live network.
const TEST_PK =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

function svc(value: string): SecretLoaderService {
  const config = {
    getOrThrow: () => value,
  } as unknown as ConfigService;
  return new SecretLoaderService(config);
}

describe('SecretLoaderService (raw-key path)', () => {
  it('loads a 0x private key into a viem account', async () => {
    const s = svc(TEST_PK);
    await s.load();
    expect(s.account.address).toBe(TEST_ADDR);
    expect(s.privateKey).toBe(TEST_PK);
  });

  it('accepts a key without the 0x prefix', async () => {
    const s = svc(TEST_PK.slice(2));
    await s.load();
    expect(s.account.address).toBe(TEST_ADDR);
    expect(s.privateKey).toBe(TEST_PK);
  });

  it('throws on a malformed key (fail loud at boot)', async () => {
    const s = svc('0xdeadbeef');
    await expect(s.load()).rejects.toThrow();
  });

  it('throws when accessed before load', () => {
    const s = svc(TEST_PK);
    expect(() => s.account).toThrow(/not loaded/);
    expect(() => s.privateKey).toThrow(/not loaded/);
  });
});
