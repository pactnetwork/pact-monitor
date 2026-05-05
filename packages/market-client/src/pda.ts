import { PublicKey } from "@solana/web3.js";
import {
  PROGRAM_ID,
  SEED_COVERAGE_POOL,
  SEED_SETTLEMENT_AUTHORITY,
  SEED_ENDPOINT,
  SEED_AGENT_WALLET,
  SEED_CALL,
} from "./constants.js";

export function deriveCoveragePool(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEED_COVERAGE_POOL], PROGRAM_ID);
}

export function deriveSettlementAuthority(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEED_SETTLEMENT_AUTHORITY],
    PROGRAM_ID
  );
}

export function deriveEndpointConfig(slug: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEED_ENDPOINT, slug],
    PROGRAM_ID
  );
}

export function deriveAgentWallet(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SEED_AGENT_WALLET, owner.toBuffer()],
    PROGRAM_ID
  );
}

export function deriveCallRecord(callId: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEED_CALL, callId], PROGRAM_ID);
}

export function slugBytes(slug: string): Uint8Array {
  const buf = new Uint8Array(16);
  const encoded = new TextEncoder().encode(slug.slice(0, 16));
  buf.set(encoded);
  return buf;
}
