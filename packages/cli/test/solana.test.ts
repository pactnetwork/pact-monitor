import { describe, expect, test } from "bun:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { agentWalletPda, USDC_DEVNET_MINT } from "../src/lib/solana.ts";

describe("solana helpers", () => {
  test("USDC_DEVNET_MINT is correct", () => {
    expect(USDC_DEVNET_MINT.toBase58()).toBe("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
  });

  test("agentWalletPda derives deterministic address per agent", () => {
    const kp = Keypair.generate();
    const programId = new PublicKey("9oxX3JL1ePMq6Df6oo4tGu3hbsP3wAH7C7t9eg8jBd9C");
    const a = agentWalletPda(kp.publicKey, programId);
    const b = agentWalletPda(kp.publicKey, programId);
    expect(a.toBase58()).toBe(b.toBase58());
  });
});
