import {
  createPublicClient,
  defineChain,
  http,
  type Chain,
  type PublicClient,
} from 'viem';
import { PactCoreClient } from '@pact-network/protocol-zerog-client';

/** 0G Chain — Galileo testnet (16602) / Aristotle mainnet (16661). */
export function defineZerogChain(chainId: number, rpcUrl: string): Chain {
  return defineChain({
    id: chainId,
    name: chainId === 16_661 ? '0G Aristotle' : '0G Galileo',
    nativeCurrency: { name: '0G', symbol: '0G', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

export interface ReadClients {
  chain: Chain;
  publicClient: PublicClient;
  pactCore: PactCoreClient;
}

/** Read-only clients. The indexer never signs — no wallet client. */
export function createReadClients(opts: {
  chainId: number;
  rpcUrl: string;
  pactCoreAddress: `0x${string}`;
}): ReadClients {
  const chain = defineZerogChain(opts.chainId, opts.rpcUrl);
  const publicClient = createPublicClient({
    chain,
    transport: http(opts.rpcUrl),
  });
  const pactCore = new PactCoreClient({
    address: opts.pactCoreAddress,
    publicClient,
  });
  return { chain, publicClient, pactCore };
}
