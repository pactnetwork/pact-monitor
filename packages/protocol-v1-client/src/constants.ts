import { PublicKey } from "@solana/web3.js";

export const PROGRAM_ID = new PublicKey(
  "DhWibM2z3Vwp5VmJyashoeZCAZHLFKeHab8o12qYsiQc"
);

export const USDC_DEVNET = new PublicKey(
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
);

export const USDC_MAINNET = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);

// PDA seeds
export const SEED_COVERAGE_POOL = Buffer.from("coverage_pool");
export const SEED_SETTLEMENT_AUTHORITY = Buffer.from("settlement_authority");
export const SEED_ENDPOINT = Buffer.from("endpoint");
export const SEED_AGENT_WALLET = Buffer.from("agent_wallet");
export const SEED_CALL = Buffer.from("call");
