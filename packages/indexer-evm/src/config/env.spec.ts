import { describe, it, expect } from 'vitest';
import { parseEnv } from './env';

const ok = {
  PG_URL_ZEROG: 'postgresql://localhost/pact0g',
  ZEROG_RPC_URL: 'https://evmrpc-testnet.0g.ai',
  ZEROG_CHAIN_ID: '16602',
  PACT_CORE_ADDRESS: '0x1111111111111111111111111111111111111111',
  ZEROG_STORAGE_INDEXER_URL: 'https://indexer-storage-testnet-turbo.0g.ai',
  INDEXER_START_BLOCK: '1234',
};

describe('indexer-evm env', () => {
  it('parses with coerced numerics + defaults', () => {
    const env = parseEnv(ok as unknown as NodeJS.ProcessEnv);
    expect(env.ZEROG_CHAIN_ID).toBe(16602);
    expect(env.INDEXER_START_BLOCK).toBe(1234);
    expect(env.POLL_INTERVAL_MS).toBe(2000);
    expect(env.LOG_RANGE).toBe(500);
    expect(env.PORT).toBe(3001);
  });

  it('rejects a non-EVM PACT_CORE_ADDRESS', () => {
    expect(() =>
      parseEnv({ ...ok, PACT_CORE_ADDRESS: 'nope' } as never),
    ).toThrow(/Invalid env/);
  });

  it('rejects a missing required var', () => {
    const { PG_URL_ZEROG, ...rest } = ok;
    void PG_URL_ZEROG;
    expect(() => parseEnv(rest as never)).toThrow(/Invalid env/);
  });

  it('allows START_BLOCK 0 (genesis) but not negative', () => {
    expect(parseEnv({ ...ok, INDEXER_START_BLOCK: '0' } as never).INDEXER_START_BLOCK).toBe(0);
    expect(() =>
      parseEnv({ ...ok, INDEXER_START_BLOCK: '-1' } as never),
    ).toThrow(/Invalid env/);
  });
});
