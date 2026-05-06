import { Connection, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  buildApproveIx,
  buildRevokeIx,
  deriveAssociatedTokenAccount,
  getSettlementAuthorityPda,
} from "@pact-network/protocol-v1-client";
import { loadOrCreateWallet } from "../lib/wallet.ts";
import { resolveClusterConfig } from "../lib/solana.ts";
import {
  loadOrCreatePolicy,
  canAutoDeposit,
  recordAutoDeposit,
} from "../lib/policy.ts";
import type { Envelope } from "../lib/envelope.ts";

type SubmitResult = { tx_signature: string; confirmation_pending: boolean };

export async function approveCommand(opts: {
  amountUsdc: number;
  configDir: string;
  rpcUrl: string;
  cluster: "devnet" | "mainnet";
  submitApprove?: (allowanceLamports: bigint) => Promise<SubmitResult>;
}): Promise<Envelope> {
  const cfg = resolveClusterConfig(opts.cluster);
  if ("error" in cfg) {
    return { status: "client_error", body: { error: cfg.error } };
  }
  const wallet = loadOrCreateWallet({ configDir: opts.configDir });

  const policy = loadOrCreatePolicy({ configDir: opts.configDir });
  const check = canAutoDeposit({
    configDir: opts.configDir,
    policy,
    requestedUsdc: opts.amountUsdc,
  });
  if (!check.allowed) {
    return {
      status: "auto_deposit_capped",
      body: {
        reason: check.reason,
        session_used_usdc: check.session_used_usdc,
        session_max_usdc: check.session_max_usdc,
        per_deposit_max_usdc: check.per_deposit_max_usdc,
        suggest:
          "raise cap in ~/.config/pact/<project>/policy.yaml or run pact approve manually",
      },
    };
  }

  const allowanceLamports = BigInt(Math.floor(opts.amountUsdc * 1_000_000));
  const submit =
    opts.submitApprove ??
    (async (lamports: bigint): Promise<SubmitResult> => {
      const conn = new Connection(opts.rpcUrl, "confirmed");
      const ata = deriveAssociatedTokenAccount(wallet.keypair.publicKey, cfg.mint);
      const [pda] = getSettlementAuthorityPda(cfg.programId);
      const ix = buildApproveIx({
        agentAta: ata,
        settlementAuthorityPda: pda,
        allowanceLamports: lamports,
        agentOwner: wallet.keypair.publicKey,
      });
      const tx = new Transaction().add(ix);
      const sig = await sendAndConfirmTransaction(conn, tx, [wallet.keypair]);
      return { tx_signature: sig, confirmation_pending: false };
    });

  try {
    const result = await submit(allowanceLamports);
    recordAutoDeposit({ configDir: opts.configDir, amountUsdc: opts.amountUsdc });
    return {
      status: "ok",
      body: {
        tx_signature: result.tx_signature,
        confirmation_pending: result.confirmation_pending,
        allowance_usdc: opts.amountUsdc,
      },
    };
  } catch (err) {
    return {
      status: "cli_internal_error",
      body: { error: (err as Error).message },
    };
  }
}

export async function revokeCommand(opts: {
  configDir: string;
  rpcUrl: string;
  cluster: "devnet" | "mainnet";
  submitRevoke?: () => Promise<SubmitResult>;
}): Promise<Envelope> {
  const cfg = resolveClusterConfig(opts.cluster);
  if ("error" in cfg) {
    return { status: "client_error", body: { error: cfg.error } };
  }
  const wallet = loadOrCreateWallet({ configDir: opts.configDir });

  const submit =
    opts.submitRevoke ??
    (async (): Promise<SubmitResult> => {
      const conn = new Connection(opts.rpcUrl, "confirmed");
      const ata = deriveAssociatedTokenAccount(wallet.keypair.publicKey, cfg.mint);
      const ix = buildRevokeIx({
        agentAta: ata,
        agentOwner: wallet.keypair.publicKey,
      });
      const tx = new Transaction().add(ix);
      const sig = await sendAndConfirmTransaction(conn, tx, [wallet.keypair]);
      return { tx_signature: sig, confirmation_pending: false };
    });

  try {
    const result = await submit();
    return {
      status: "ok",
      body: {
        tx_signature: result.tx_signature,
        confirmation_pending: result.confirmation_pending,
      },
    };
  } catch (err) {
    return {
      status: "cli_internal_error",
      body: { error: (err as Error).message },
    };
  }
}
