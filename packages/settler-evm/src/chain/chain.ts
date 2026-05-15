import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Chain,
  type PublicClient,
  type WalletClient,
} from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';

/** 0G Chain — Galileo testnet (16602) / Aristotle mainnet (16661). Native
 *  gas token is `0G`, 18 decimals. Standard EVM JSON-RPC, so a plain
 *  `defineChain` is sufficient. */
export function defineZerogChain(
  chainId: number,
  rpcUrl: string,
  explorerUrl?: string,
): Chain {
  return defineChain({
    id: chainId,
    name: chainId === 16_661 ? '0G Aristotle' : '0G Galileo',
    nativeCurrency: { name: '0G', symbol: '0G', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: explorerUrl
      ? { default: { name: '0G Chainscan', url: explorerUrl } }
      : undefined,
  });
}

export interface ChainClients {
  chain: Chain;
  publicClient: PublicClient;
  walletClient: WalletClient;
}

export function createClients(opts: {
  chainId: number;
  rpcUrl: string;
  account: PrivateKeyAccount;
  explorerUrl?: string;
}): ChainClients {
  const chain = defineZerogChain(opts.chainId, opts.rpcUrl, opts.explorerUrl);
  const transport = http(opts.rpcUrl);
  return {
    chain,
    publicClient: createPublicClient({ chain, transport }),
    walletClient: createWalletClient({
      account: opts.account,
      chain,
      transport,
    }),
  };
}

/**
 * Serializes ALL signing through the single settlement EOA. Both the
 * ethers-based 0G Storage upload and the viem `settleBatch` tx sign with the
 * same key; viem and ethers each manage nonces independently, so concurrent
 * sends collide ("nonce too low" / replacement-underpriced). Every storage
 * upload and every settle goes through `runExclusive` — strictly one
 * in-flight signed tx per process (BLOCKER #1).
 */
export class SigningMutex {
  private tail: Promise<unknown> = Promise.resolve();

  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(
      () => fn(),
      () => fn(),
    );
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
