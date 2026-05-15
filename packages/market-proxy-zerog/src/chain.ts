import {
  createPublicClient,
  defineChain,
  http,
  type Chain,
  type PublicClient,
} from 'viem';
import { PactCoreClient } from '@pact-network/protocol-zerog-client';

/** 0G Chain — Galileo testnet (16602) / Aristotle mainnet (16661). Native
 *  gas token is `0G`, 18 decimals. Standard EVM JSON-RPC. Ported from
 *  settler-evm so chain identity stays consistent across the stack. */
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

export interface ReadClients {
  chain: Chain;
  publicClient: PublicClient;
  pactCore: PactCoreClient;
}

/**
 * The proxy only ever READS chain state (endpoint pricing + ERC20
 * balance/allowance). It never signs an on-chain tx — the compute broker
 * wallet signs request headers off-chain, and settlement is the settler's
 * job. So: no wallet client, no `SigningMutex` (cf. settler-evm BLOCKER #1,
 * which does not apply here — plan 5 architecture decision #3).
 */
export function createReadClients(opts: {
  chainId: number;
  rpcUrl: string;
  pactCoreAddress: `0x${string}`;
  explorerUrl?: string;
}): ReadClients {
  const chain = defineZerogChain(opts.chainId, opts.rpcUrl, opts.explorerUrl);
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
