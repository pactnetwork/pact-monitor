import type { ComputeNetworkConfig } from './client';

/** 0G Galileo testnet. Validated partial in spike 2 (discovery path). */
export const GALILEO_TESTNET: ComputeNetworkConfig = {
  chainId:           16_602,
  rpcUrl:            'https://evmrpc-testnet.0g.ai',
  ledgerContract:    '0xa79F4c8311FF93C06b8CfB403690cc987c93F91E',  // captured via spike 2
  minLedgerDeposit0G: 3,                                            // enforced on-chain
  subAccountFund0G:   2,                                            // auto-fund amount on first getRequestHeaders
};

/** 0G Aristotle mainnet. Not yet validated. */
export const ARISTOTLE_MAINNET: ComputeNetworkConfig = {
  chainId:           16_661,
  rpcUrl:            'https://evmrpc.0g.ai',
  ledgerContract:    '',                                            // TBD — capture during Day 18 mainnet smoke
  minLedgerDeposit0G: 3,
  subAccountFund0G:   2,
};
