import { describe, it, expect } from 'vitest';
import { PactCoreClient } from '@pact-network/protocol-zerog-client';
import { defineZerogChain, createReadClients } from './chain';

describe('defineZerogChain', () => {
  it('sets 0G native currency + RPC, names by chain id', () => {
    const c = defineZerogChain(16_602, 'https://evmrpc-testnet.0g.ai');
    expect(c.id).toBe(16_602);
    expect(c.nativeCurrency).toEqual({ name: '0G', symbol: '0G', decimals: 18 });
    expect(c.rpcUrls.default.http).toEqual(['https://evmrpc-testnet.0g.ai']);
    expect(c.name).toContain('Galileo');
    expect(defineZerogChain(16_661, 'https://evmrpc.0g.ai').name).toContain(
      'Aristotle',
    );
  });
});

describe('createReadClients', () => {
  it('builds a read-only public client + PactCoreClient (no wallet)', () => {
    const { publicClient, pactCore, chain } = createReadClients({
      chainId: 16_602,
      rpcUrl: 'https://evmrpc-testnet.0g.ai',
      pactCoreAddress: '0x1111111111111111111111111111111111111111',
    });
    expect(chain.id).toBe(16_602);
    expect(publicClient.chain?.id).toBe(16_602);
    expect(pactCore).toBeInstanceOf(PactCoreClient);
    expect(pactCore.address).toBe(
      '0x1111111111111111111111111111111111111111',
    );
  });
});
