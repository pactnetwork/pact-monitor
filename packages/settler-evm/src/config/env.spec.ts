import { describe, it, expect } from 'vitest';
import { parseEnv } from './env';

const ok = {
  PUBSUB_PROJECT: 'p',
  PUBSUB_SUBSCRIPTION: 's',
  ZEROG_RPC_URL: 'https://evmrpc-testnet.0g.ai',
  ZEROG_CHAIN_ID: '16602',
  PACT_CORE_ADDRESS: '0x1111111111111111111111111111111111111111',
  ZEROG_STORAGE_INDEXER_URL: 'https://indexer-storage-testnet-turbo.0g.ai',
  SETTLEMENT_AUTHORITY_KEY: '0xabc',
  PG_URL_ZEROG: 'postgresql://localhost/pact0g',
};

describe('settler-evm env', () => {
  it('parses a valid env with coerced chain id and default batch size', () => {
    const env = parseEnv(ok as unknown as NodeJS.ProcessEnv);
    expect(env.ZEROG_CHAIN_ID).toBe(16602);
    expect(env.MAX_BATCH_SIZE).toBe(10);
    expect(env.PORT).toBe(8080);
  });

  it('rejects a non-EVM PACT_CORE_ADDRESS', () => {
    expect(() =>
      parseEnv({ ...ok, PACT_CORE_ADDRESS: 'not-an-address' } as never),
    ).toThrow(/Invalid env/);
  });

  it('rejects a missing required var', () => {
    const { PG_URL_ZEROG, ...missing } = ok;
    void PG_URL_ZEROG;
    expect(() => parseEnv(missing as never)).toThrow(/Invalid env/);
  });

  it('caps MAX_BATCH_SIZE at the contract limit (50)', () => {
    expect(() =>
      parseEnv({ ...ok, MAX_BATCH_SIZE: '51' } as never),
    ).toThrow(/Invalid env/);
    expect(parseEnv({ ...ok, MAX_BATCH_SIZE: '50' } as never).MAX_BATCH_SIZE).toBe(
      50,
    );
  });
});
