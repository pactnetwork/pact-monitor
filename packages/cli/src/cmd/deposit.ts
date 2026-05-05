import { Connection } from "@solana/web3.js";
import { loadOrCreateWallet } from "../lib/wallet.ts";
import {
  depositUsdc,
  PACT_INSURANCE_PROGRAM_ID_DEVNET,
} from "../lib/solana.ts";
import {
  loadOrCreatePolicy,
  canAutoDeposit,
  recordAutoDeposit,
} from "../lib/policy.ts";
import type { Envelope } from "../lib/envelope.ts";

export async function depositCommand(opts: {
  amountUsdc: number;
  configDir: string;
  rpcUrl: string;
  cluster: "devnet" | "mainnet";
  providerHostname?: string;
  submitDeposit?: (amountUsdc: number) => Promise<{ tx_signature: string; confirmation_pending: boolean }>;
}): Promise<Envelope> {
  const wallet = loadOrCreateWallet({ configDir: opts.configDir });
  const programId = PACT_INSURANCE_PROGRAM_ID_DEVNET;
  const provider = opts.providerHostname ?? "default";

  const policy = loadOrCreatePolicy({ configDir: opts.configDir });
  const check = canAutoDeposit({ configDir: opts.configDir, policy, requestedUsdc: opts.amountUsdc });
  if (!check.allowed) {
    return {
      status: "auto_deposit_capped",
      body: {
        reason: check.reason,
        session_used_usdc: check.session_used_usdc,
        session_max_usdc: check.session_max_usdc,
        per_deposit_max_usdc: check.per_deposit_max_usdc,
        suggest: "raise cap in ~/.config/pact/<project>/policy.yaml or run pact deposit manually",
      },
    };
  }

  try {
    let result: { tx_signature: string; confirmation_pending: boolean };
    if (opts.submitDeposit) {
      result = await opts.submitDeposit(opts.amountUsdc);
    } else {
      const _conn = new Connection(opts.rpcUrl, "confirmed");
      result = await depositUsdc({
        connection: _conn,
        keypair: wallet.keypair,
        programId,
        providerHostname: provider,
        amountUsdc: opts.amountUsdc,
        rpcUrl: opts.rpcUrl,
      });
    }
    recordAutoDeposit({ configDir: opts.configDir, amountUsdc: opts.amountUsdc });
    return {
      status: "ok",
      body: {
        tx_signature: result.tx_signature,
        confirmation_pending: result.confirmation_pending,
        new_balance_usdc: null,
      },
    };
  } catch (err) {
    return {
      status: "cli_internal_error",
      body: { error: (err as Error).message },
    };
  }
}
