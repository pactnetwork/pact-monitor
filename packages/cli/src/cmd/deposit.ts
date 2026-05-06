import { loadOrCreateWallet } from "../lib/wallet.ts";
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
  loadOrCreateWallet({ configDir: opts.configDir });

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

  if (!opts.submitDeposit) {
    return {
      status: "cli_internal_error",
      body: { error: "submitDeposit not injected" },
    };
  }

  try {
    const result = await opts.submitDeposit(opts.amountUsdc);
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
