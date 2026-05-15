import { describe, it, expect } from 'vitest';
import { defineZerogChain, createReadClients } from '../src/chain';

const PACT = ('0x' + '1'.repeat(40)) as `0x${string}`;

describe('defineZerogChain', () => {
  it('names testnet vs mainnet and sets the 0G native currency', () => {
    const t = defineZerogChain(16_602, 'https://evmrpc-testnet.0g.ai');
    expect(t.id).toBe(16_602);
    expect(t.name).toBe('0G Galileo');
    expect(t.nativeCurrency).toEqual({ name: '0G', symbol: '0G', decimals: 18 });

    const m = defineZerogChain(16_661, 'https://evmrpc.0g.ai', 'https://chainscan.0g.ai');
    expect(m.name).toBe('0G Aristotle');
    expect(m.blockExplorers?.default.url).toBe('https://chainscan.0g.ai');
  });
});

describe('createReadClients', () => {
  it('builds a public client + read-only PactCoreClient (no wallet)', () => {
    const { chain, publicClient, pactCore } = createReadClients({
      chainId: 16_602,
      rpcUrl: 'https://evmrpc-testnet.0g.ai',
      pactCoreAddress: PACT,
    });
    expect(chain.id).toBe(16_602);
    expect(typeof publicClient.readContract).toBe('function');
    expect(pactCore.address).toBe(PACT);
    // read-only: a write must throw (no walletClient supplied)
    expect(() => pactCore.pauseProtocol(true)).toThrow(/no walletClient/);
  });
});
