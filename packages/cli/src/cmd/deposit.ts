import { Connection } from "@solana/web3.js";
import { loadOrCreateWallet } from "../lib/wallet.ts";
import {
  depositUsdc,
  PACT_INSURANCE_PROGRAM_ID_DEVNET,
} from "../lib/solana.ts";
import type { Envelope } from "../lib/envelope.ts";

export async function depositCommand(opts: {
  amountUsdc: number;
  configDir: string;
  rpcUrl: string;
  cluster: "devnet" | "mainnet";
  providerHostname?: string;
}): Promise<Envelope> {
  const wallet = loadOrCreateWallet({ configDir: opts.configDir });
  const _conn = new Connection(opts.rpcUrl, "confirmed");
  const programId = PACT_INSURANCE_PROGRAM_ID_DEVNET;
  const provider = opts.providerHostname ?? "default";

  try {
    const { tx_signature, confirmation_pending } = await depositUsdc({
      connection: _conn,
      keypair: wallet.keypair,
      programId,
      providerHostname: provider,
      amountUsdc: opts.amountUsdc,
      rpcUrl: opts.rpcUrl,
    });
    return {
      status: "ok",
      body: {
        tx_signature,
        confirmation_pending,
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
