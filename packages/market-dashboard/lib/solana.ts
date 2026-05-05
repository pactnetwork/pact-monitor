/**
 * Solana wiring for the dashboard. Pulls instruction builders, PDAs, and
 * constants from `@pact-network/protocol-v1-client` so the dashboard speaks
 * directly to the deployed V1 program (`5jBQb7fL…` on devnet) without any
 * placeholder discriminators.
 */
import {
  Connection,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  PROGRAM_ID,
  USDC_MINT_DEVNET,
  buildApproveIx,
  buildRevokeIx,
  getSettlementAuthorityPda,
  deriveAssociatedTokenAccount,
} from "@pact-network/protocol-v1-client";

export const SOLANA_RPC =
  process.env.NEXT_PUBLIC_SOLANA_RPC ?? "https://api.devnet.solana.com";

/** USDC mint used by the deployed devnet program (hardcoded server-side). */
export const USDC_MINT = USDC_MINT_DEVNET;

/** Re-export the canonical V1 program ID so consumers don't import the SDK directly. */
export const PACT_PROGRAM_ID = PROGRAM_ID;

/**
 * UX default for the SPL Token Approve allowance — 25 USDC. There is no
 * on-chain enforcement of this number; it just keeps a single Approve from
 * granting unlimited custody. Agents can re-approve any amount.
 */
export const DEFAULT_APPROVE_LAMPORTS = 25_000_000n;

/** Singleton SettlementAuthority PDA — used as the SPL Token delegate. */
export function settlementAuthorityPda(): PublicKey {
  const [pda] = getSettlementAuthorityPda(PROGRAM_ID);
  return pda;
}

/** Standard SPL Token ATA for the agent's USDC. */
export function agentUsdcAta(agentOwner: PublicKey): PublicKey {
  return deriveAssociatedTokenAccount(agentOwner, USDC_MINT);
}

/**
 * Build an SPL Token `Approve` ix that sets the SettlementAuthority PDA as the
 * delegate for the agent's USDC ATA with `allowance` base units (default 25
 * USDC). Returns a single-ix `Transaction`.
 */
export function buildApproveTransaction(
  agentOwner: PublicKey,
  allowanceLamports: bigint = DEFAULT_APPROVE_LAMPORTS
): Transaction {
  const ix = buildApproveIx({
    agentAta: agentUsdcAta(agentOwner),
    settlementAuthorityPda: settlementAuthorityPda(),
    allowanceLamports,
    agentOwner,
  });
  return new Transaction().add(ix);
}

/**
 * Build an SPL Token `Revoke` ix that clears the delegate on the agent's
 * USDC ATA. After this lands, no settle_batch will be able to debit the
 * agent's funds until they re-approve.
 */
export function buildRevokeTransaction(agentOwner: PublicKey): Transaction {
  const ix = buildRevokeIx({
    agentAta: agentUsdcAta(agentOwner),
    agentOwner,
  });
  return new Transaction().add(ix);
}

/** Lazily-constructed RPC client. */
let _connection: Connection | null = null;
export function getConnection(): Connection {
  if (!_connection) {
    _connection = new Connection(SOLANA_RPC, "confirmed");
  }
  return _connection;
}
