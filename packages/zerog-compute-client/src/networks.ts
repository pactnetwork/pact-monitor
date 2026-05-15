import type { ComputeNetworkConfig } from './client';

// NOTE: `ledgerContract` is INFORMATIONAL ONLY. `createZGComputeNetworkBroker`
// is called with no explicit ledger CA (see client.ts), so the SDK
// auto-detects the correct contract set from the signer's chain id. The
// scaffolded value here was the SDK's *inference serving* contract, not the
// ledger — corrected below from the SDK's own CONTRACT_ADDRESSES table so a
// future wiring of this field doesn't point ledger ops at the wrong contract.

/** 0G Galileo testnet. Validated partial in spike 2 (discovery path). */
export const GALILEO_TESTNET: ComputeNetworkConfig = {
  chainId:           16_602,
  rpcUrl:            'https://evmrpc-testnet.0g.ai',
  ledgerContract:    '0xE70830508dAc0A97e6c087c75f402f9Be669E406',  // SDK CONTRACT_ADDRESSES.testnet.ledger
  minLedgerDeposit0G: 3,                                            // enforced on-chain
  subAccountFund0G:   2,                                            // auto-fund amount on first getRequestHeaders
};

/** 0G Aristotle mainnet. Not yet validated. */
export const ARISTOTLE_MAINNET: ComputeNetworkConfig = {
  chainId:           16_661,
  rpcUrl:            'https://evmrpc.0g.ai',
  ledgerContract:    '0x2dE54c845Cd948B72D2e32e39586fe89607074E3',  // SDK CONTRACT_ADDRESSES.mainnet.ledger
  minLedgerDeposit0G: 3,
  subAccountFund0G:   2,
};
