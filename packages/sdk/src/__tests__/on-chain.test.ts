import { describe, it, expect } from "vitest";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  getSettlementAuthorityPda,
  deriveAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
} from "@q3labs/pact-protocol-v1-client";
import {
  buildCreateAtaIdempotentIx,
  ensureAtaAndApprove,
  topUp,
  revoke,
  readInsurableState,
  type OnChainContext,
} from "../on-chain.js";

const PROGRAM_ID = new PublicKey("5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const ATA_PROGRAM = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

function ctxWithCapture(): { ctx: OnChainContext; captured: Transaction[] } {
  const captured: Transaction[] = [];
  const signer = Keypair.generate();
  const ctx: OnChainContext = {
    connection: {} as Connection,
    signer,
    programId: PROGRAM_ID,
    usdcMint: USDC,
    submit: async (tx) => {
      captured.push(tx);
      return "SIG_" + captured.length;
    },
  };
  return { ctx, captured };
}

describe("buildCreateAtaIdempotentIx", () => {
  it("targets the ATA program with the idempotent discriminator", () => {
    const owner = Keypair.generate().publicKey;
    const ata = deriveAssociatedTokenAccount(owner, USDC);
    const ix = buildCreateAtaIdempotentIx({ funder: owner, ata, owner, mint: USDC });
    expect(ix.programId.equals(ATA_PROGRAM)).toBe(true);
    expect(ix.keys).toHaveLength(6);
    expect(ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[1].pubkey.equals(ata)).toBe(true);
    expect([...ix.data]).toEqual([1]);
  });
});

describe("ensureAtaAndApprove", () => {
  it("submits create-ATA + approve to the singleton SettlementAuthority", async () => {
    const { ctx, captured } = ctxWithCapture();
    const owner = ctx.signer.publicKey;
    const r = await ensureAtaAndApprove(ctx, 5_000_000n);

    expect(r.txSignature).toBe("SIG_1");
    expect(r.allowanceLamports).toBe(5_000_000n);
    expect(captured).toHaveLength(1);
    const ixs = captured[0].instructions;
    expect(ixs).toHaveLength(2);

    // [0] create ATA idempotent
    expect(ixs[0].programId.equals(ATA_PROGRAM)).toBe(true);
    // [1] SPL approve → delegate is the program-derived SettlementAuthority
    const [saPda] = getSettlementAuthorityPda(PROGRAM_ID);
    expect(ixs[1].programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(ixs[1].keys[1].pubkey.equals(saPda)).toBe(true);
    expect(ixs[1].keys[2].pubkey.equals(owner)).toBe(true);
    // approve opcode = 4, then u64 LE allowance
    expect(ixs[1].data[0]).toBe(4);
    const allowance = ixs[1].data.readBigUInt64LE(1);
    expect(allowance).toBe(5_000_000n);

    expect(r.ata).toBe(deriveAssociatedTokenAccount(owner, USDC).toBase58());
  });
});

describe("topUp / revoke", () => {
  it("topUp is a single re-approve with the new allowance", async () => {
    const { ctx, captured } = ctxWithCapture();
    await topUp(ctx, 9_000_000n);
    const ixs = captured[0].instructions;
    expect(ixs).toHaveLength(1);
    expect(ixs[0].programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(ixs[0].data[0]).toBe(4);
    expect(ixs[0].data.readBigUInt64LE(1)).toBe(9_000_000n);
  });

  it("revoke is a single SPL revoke", async () => {
    const { ctx, captured } = ctxWithCapture();
    const sig = await revoke(ctx);
    expect(sig).toBe("SIG_1");
    const ixs = captured[0].instructions;
    expect(ixs).toHaveLength(1);
    expect(ixs[0].programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect([...ixs[0].data]).toEqual([5]); // SPL revoke opcode
  });
});

describe("readInsurableState", () => {
  it("reports not-eligible when the ATA does not exist", async () => {
    const connection = {
      getAccountInfo: async () => null,
    } as unknown as Connection;
    const state = await readInsurableState({
      connection,
      agentPubkey: Keypair.generate().publicKey,
      programId: PROGRAM_ID,
      usdcMint: USDC,
      requiredLamports: 1_000n,
    });
    expect(state.eligible).toBe(false);
    expect(state.ataBalance).toBe(0n);
    expect(state.reason).toMatch(/ATA does not exist/i);
  });
});
