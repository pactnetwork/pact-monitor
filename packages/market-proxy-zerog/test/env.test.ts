import { describe, it, expect } from 'vitest';
import { parseEnv } from '../src/env';

const PACT = '0x' + '1'.repeat(40);
const USDC = '0x' + '2'.repeat(40);
const PK = '0x' + 'a'.repeat(64);

const base: NodeJS.ProcessEnv = {
  ZEROG_RPC_URL: 'https://evmrpc-testnet.0g.ai',
  ZEROG_CHAIN_ID: '16602',
  PACT_CORE_ADDRESS: PACT,
  USDC_ADDRESS: USDC,
  ZEROG_COMPUTE_PRIVATE_KEY: PK,
  PUBSUB_PROJECT: 'proj',
  PUBSUB_TOPIC: 'topic',
};

describe('parseEnv', () => {
  it('applies defaults', () => {
    const e = parseEnv(base);
    expect(e.ZEROG_CHAIN_ID).toBe(16602);
    expect(e.PORT).toBe(8080);
    expect(e.ZEROG_COMPUTE_MIN_DEPOSIT_0G).toBe(3);
    expect(e.ZEROG_COMPUTE_SUBACCOUNT_FUND_0G).toBe(2);
    expect(e.ZEROG_COMPUTE_ENSURE_LEDGER).toBe(true);
    expect(e.ZEROG_COMPUTE_TEE_VERIFY).toBe(false);
    expect(e.PACT_PROXY_INSECURE_DEMO).toBe('0');
    expect(e.LOG_LEVEL).toBe('log');
  });

  it('coerces booleans only from 1/true, not 0/false', () => {
    expect(parseEnv({ ...base, ZEROG_COMPUTE_ENSURE_LEDGER: '0' }).ZEROG_COMPUTE_ENSURE_LEDGER).toBe(false);
    expect(parseEnv({ ...base, ZEROG_COMPUTE_ENSURE_LEDGER: 'false' }).ZEROG_COMPUTE_ENSURE_LEDGER).toBe(false);
    expect(parseEnv({ ...base, ZEROG_COMPUTE_TEE_VERIFY: '1' }).ZEROG_COMPUTE_TEE_VERIFY).toBe(true);
    expect(parseEnv({ ...base, ZEROG_COMPUTE_TEE_VERIFY: 'TRUE' }).ZEROG_COMPUTE_TEE_VERIFY).toBe(true);
  });

  it('rejects a non-EVM PACT_CORE_ADDRESS', () => {
    expect(() => parseEnv({ ...base, PACT_CORE_ADDRESS: 'notanaddr' })).toThrow(
      /PACT_CORE_ADDRESS/,
    );
  });

  it('rejects a malformed private key', () => {
    expect(() => parseEnv({ ...base, ZEROG_COMPUTE_PRIVATE_KEY: '0xabc' })).toThrow(
      /ZEROG_COMPUTE_PRIVATE_KEY/,
    );
  });

  it('rejects a missing required var', () => {
    const { PUBSUB_TOPIC: _omit, ...rest } = base;
    expect(() => parseEnv(rest)).toThrow(/PUBSUB_TOPIC/);
  });
});
