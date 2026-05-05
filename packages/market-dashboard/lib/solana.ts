// TODO(wave2-integration): replace with @pact-network/market-client once 1A program crew ships
export const PLACEHOLDER_PROGRAM_ID = "11111111111111111111111111111111";

export const SOLANA_RPC =
  process.env.NEXT_PUBLIC_SOLANA_RPC ?? "https://api.devnet.solana.com";

// Stub: derive AgentWallet PDA address for a given agent pubkey
// TODO(wave2-integration): replace with Codama-generated PDA derivation
export function deriveAgentWalletPda(agentPubkey: string): string {
  return `pda_stub_${agentPubkey.slice(0, 8)}`;
}

// Stub: build deposit_usdc instruction
// TODO(wave2-integration): replace with Codama-generated instruction builder
export function buildDepositIx(agentPubkey: string, amountUsdc: number) {
  return {
    programId: PLACEHOLDER_PROGRAM_ID,
    keys: [{ pubkey: agentPubkey, isSigner: true, isWritable: true }],
    data: { instruction: "deposit_usdc", amount: amountUsdc },
  };
}

// Stub: build claim_refund instruction
// TODO(wave2-integration): replace with Codama-generated instruction builder
export function buildClaimRefundIx(agentPubkey: string) {
  return {
    programId: PLACEHOLDER_PROGRAM_ID,
    keys: [{ pubkey: agentPubkey, isSigner: true, isWritable: true }],
    data: { instruction: "claim_refund" },
  };
}
