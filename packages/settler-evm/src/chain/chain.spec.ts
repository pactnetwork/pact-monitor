import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { defineZerogChain, createClients, SigningMutex } from './chain';

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

describe('defineZerogChain', () => {
  it('sets 0G native currency, 18 decimals, and the RPC', () => {
    const c = defineZerogChain(16_602, 'https://evmrpc-testnet.0g.ai');
    expect(c.id).toBe(16_602);
    expect(c.nativeCurrency).toEqual({ name: '0G', symbol: '0G', decimals: 18 });
    expect(c.rpcUrls.default.http).toEqual(['https://evmrpc-testnet.0g.ai']);
    expect(c.name).toContain('Galileo');
  });

  it('names mainnet Aristotle for 16661', () => {
    expect(defineZerogChain(16_661, 'https://evmrpc.0g.ai').name).toContain(
      'Aristotle',
    );
  });
});

describe('createClients', () => {
  it('builds public + wallet clients bound to the chain', () => {
    const { publicClient, walletClient, chain } = createClients({
      chainId: 16_602,
      rpcUrl: 'https://evmrpc-testnet.0g.ai',
      account: privateKeyToAccount(PK),
    });
    expect(chain.id).toBe(16_602);
    expect(publicClient.chain?.id).toBe(16_602);
    expect(walletClient.account?.address).toBe(
      '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    );
  });
});

describe('SigningMutex', () => {
  it('runs tasks strictly sequentially in submission order', async () => {
    const m = new SigningMutex();
    const order: number[] = [];
    const mk = (n: number, delay: number) =>
      m.runExclusive(async () => {
        await new Promise((r) => setTimeout(r, delay));
        order.push(n);
      });
    // first submitted has the longest delay — must still complete first
    await Promise.all([mk(1, 30), mk(2, 5), mk(3, 1)]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('a rejection does not wedge the queue', async () => {
    const m = new SigningMutex();
    const failed = m.runExclusive(async () => {
      throw new Error('boom');
    });
    await expect(failed).rejects.toThrow('boom');
    await expect(m.runExclusive(async () => 'ok')).resolves.toBe('ok');
  });
});
