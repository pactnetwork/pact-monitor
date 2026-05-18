/**
 * The agent's entire on-chain footprint in V1.
 *
 * V1 has no Policy PDA, no enable_insurance, no claims. An agent does exactly
 * one thing: a single SPL `approve` delegating its USDC ATA to the SINGLETON
 * SettlementAuthority PDA (`[b"settlement_authority"]`, no slug). That one
 * delegation covers EVERY endpoint — the settler pulls per-call premiums
 * through it and the program refunds breaches automatically. `topUp` is just
 * a re-approve with a higher allowance.
 *
 * The approve + revoke flow is the proven path from
 * `packages/cli/src/cmd/approve.ts`; PDA/ix builders are reused from
 * `@pact-network/protocol-v1-client`. The associated-token-account
 * create-idempotent instruction is built inline (well-known program, fixed
 * layout) so the SDK keeps `@solana/web3.js` as its only Solana runtime dep.
 *
 * Plan blocker B1: the SettlementAuthority PDA is derived from the program
 * ID. mainnet's is canonical; devnet/localnet must be confirmed by the
 * operator and passed via `createPact({ programId })`. The factory rejects
 * on-chain ops when the program ID is unset on those networks — guessing
 * would delegate to the wrong PDA and premiums/refunds would never settle.
 */
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  type Keypair,
} from "@solana/web3.js";
import {
  buildApproveIx,
  buildRevokeIx,
  deriveAssociatedTokenAccount,
  getSettlementAuthorityPda,
  getAgentInsurableState,
  TOKEN_PROGRAM_ID,
  type AgentInsurableState,
} from "@pact-network/protocol-v1-client";
import { PactError, PactErrorCode } from "./errors.js";
import { isKeypair, signerPublicKey, type PactSigner } from "./signer.js";

const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);
const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");

/**
 * SPL Associated Token Account `CreateIdempotent` (discriminator 1).
 * No-op if the ATA already exists, so it is safe to prepend to every setup.
 */
export function buildCreateAtaIdempotentIx(params: {
  funder: PublicKey;
  ata: PublicKey;
  owner: PublicKey;
  mint: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: params.funder, isSigner: true, isWritable: true },
      { pubkey: params.ata, isSigner: false, isWritable: true },
      { pubkey: params.owner, isSigner: false, isWritable: false },
      { pubkey: params.mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

export interface OnChainContext {
  connection: Connection;
  signer: PactSigner;
  programId: PublicKey;
  usdcMint: PublicKey;
  /** Test seam: bypass real submission. */
  submit?: (tx: Transaction) => Promise<string>;
}

function ownerPk(signer: PactSigner): PublicKey {
  return new PublicKey(signerPublicKey(signer));
}

async function signAndSend(
  ctx: OnChainContext,
  tx: Transaction,
): Promise<string> {
  if (ctx.submit) return ctx.submit(tx);
  const owner = ownerPk(ctx.signer);
  try {
    if (isKeypair(ctx.signer)) {
      return await sendAndConfirmTransaction(
        ctx.connection,
        tx,
        [ctx.signer as Keypair],
        { commitment: "confirmed" },
      );
    }
    const { blockhash } = await ctx.connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = owner;
    const signed = await ctx.signer.signTransaction(tx);
    const sig = await ctx.connection.sendRawTransaction(signed.serialize());
    await ctx.connection.confirmTransaction(sig, "confirmed");
    return sig;
  } catch (err) {
    throw new PactError(
      PactErrorCode.ON_CHAIN_TX_FAILED,
      `on-chain transaction failed: ${(err as Error).message}`,
      { cause: err, retryable: true },
    );
  }
}

export interface SetupResult {
  txSignature: string;
  ata: string;
  allowanceLamports: bigint;
}

/**
 * Ensure the agent USDC ATA exists, then SPL-approve the SettlementAuthority
 * delegate for `allowanceLamports`. Idempotent: re-running just re-approves.
 */
export async function ensureAtaAndApprove(
  ctx: OnChainContext,
  allowanceLamports: bigint,
): Promise<SetupResult> {
  const owner = ownerPk(ctx.signer);
  const ata = deriveAssociatedTokenAccount(owner, ctx.usdcMint);
  const [saPda] = getSettlementAuthorityPda(ctx.programId);

  const tx = new Transaction()
    .add(
      buildCreateAtaIdempotentIx({
        funder: owner,
        ata,
        owner,
        mint: ctx.usdcMint,
      }),
    )
    .add(
      buildApproveIx({
        agentAta: ata,
        settlementAuthorityPda: saPda,
        allowanceLamports,
        agentOwner: owner,
      }),
    );

  const txSignature = await signAndSend(ctx, tx);
  return { txSignature, ata: ata.toBase58(), allowanceLamports };
}

/** Raise (or lower) the delegated allowance — a plain re-approve. */
export async function topUp(
  ctx: OnChainContext,
  allowanceLamports: bigint,
): Promise<SetupResult> {
  const owner = ownerPk(ctx.signer);
  const ata = deriveAssociatedTokenAccount(owner, ctx.usdcMint);
  const [saPda] = getSettlementAuthorityPda(ctx.programId);
  const tx = new Transaction().add(
    buildApproveIx({
      agentAta: ata,
      settlementAuthorityPda: saPda,
      allowanceLamports,
      agentOwner: owner,
    }),
  );
  const txSignature = await signAndSend(ctx, tx);
  return { txSignature, ata: ata.toBase58(), allowanceLamports };
}

/** Revoke the delegation (stops all future premium pulls). */
export async function revoke(ctx: OnChainContext): Promise<string> {
  const owner = ownerPk(ctx.signer);
  const ata = deriveAssociatedTokenAccount(owner, ctx.usdcMint);
  const tx = new Transaction().add(
    buildRevokeIx({ agentAta: ata, agentOwner: owner }),
  );
  return signAndSend(ctx, tx);
}

/** Read ATA balance + delegated allowance + eligibility (no Policy PDA in V1). */
export async function readInsurableState(opts: {
  connection: Connection;
  agentPubkey: PublicKey;
  programId: PublicKey;
  usdcMint: PublicKey;
  requiredLamports?: bigint;
}): Promise<AgentInsurableState> {
  const [saPda] = getSettlementAuthorityPda(opts.programId);
  return getAgentInsurableState(
    opts.connection,
    opts.agentPubkey,
    opts.usdcMint,
    saPda,
    opts.requiredLamports ?? 0n,
  );
}

export interface AutoTopUpWatcher {
  stop(): void;
}

/**
 * Poll the delegated allowance and re-approve when it drops below threshold.
 * Timer is `unref()`ed so it never keeps the Node event loop alive.
 */
export function startAutoTopUpWatcher(opts: {
  ctx: OnChainContext;
  thresholdLamports: bigint;
  refillLamports: bigint;
  intervalMs: number;
  onTopUp?: (sig: string) => void;
  onLowBalance?: (s: AgentInsurableState) => void;
  onError?: (err: Error) => void;
}): AutoTopUpWatcher {
  const owner = ownerPk(opts.ctx.signer);
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const state = await readInsurableState({
        connection: opts.ctx.connection,
        agentPubkey: owner,
        programId: opts.ctx.programId,
        usdcMint: opts.ctx.usdcMint,
      });
      if (state.allowance < opts.thresholdLamports) {
        opts.onLowBalance?.(state);
        const r = await topUp(opts.ctx, opts.refillLamports);
        opts.onTopUp?.(r.txSignature);
      }
    } catch (err) {
      opts.onError?.(err as Error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), opts.intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
