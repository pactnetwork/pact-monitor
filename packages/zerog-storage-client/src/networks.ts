import type { StorageNetworkConfig } from './client.js';

/** 0G Galileo testnet (chain 16602). Validated end-to-end in spikes/RESULTS.md. */
export const GALILEO_TESTNET: StorageNetworkConfig = {
  chainId:    16_602,
  rpcUrl:     'https://evmrpc-testnet.0g.ai',
  indexerUrl: 'https://indexer-storage-testnet-turbo.0g.ai',
};

/** 0G Aristotle mainnet (chain 16661). Not yet validated by spike. */
export const ARISTOTLE_MAINNET: StorageNetworkConfig = {
  chainId:    16_661,
  rpcUrl:     'https://evmrpc.0g.ai',
  indexerUrl: 'https://indexer-storage-turbo.0g.ai',
};
