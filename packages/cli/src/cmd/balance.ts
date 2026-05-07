import { Connection, PublicKey } from "@solana/web3.js";
import {
  getAgentInsurableState,
  getSettlementAuthorityPda,
} from "@pact-network/protocol-v1-client";
import { loadOrCreateWallet } from "../lib/wallet.ts";
import { resolveClusterConfig } from "../lib/solana.ts";
import type { Envelope } from "../lib/envelope.ts";

export async function balanceCommand(opts: {
  configDir: string;
  rpcUrl: string;
}): Promise<Envelope> {
  const cfg = resolveClusterConfig();
  if ("error" in cfg) {
    return { status: "client_error", body: { error: cfg.error } };
  }
  const wallet = loadOrCreateWallet({ configDir: opts.configDir });
  const conn = new Connection(opts.rpcUrl, "confirmed");
  const { programId, mint } = cfg;
  const [settlementAuthorityPda] = getSettlementAuthorityPda(programId);

  const owner = new PublicKey(wallet.keypair.publicKey.toBase58());
  // requiredLamports=0 reports raw state; remediation logic lives in cmd/run.
  const state = await getAgentInsurableState(
    conn,
    owner,
    mint,
    settlementAuthorityPda,
    0n,
  );

  return {
    status: "ok",
    body: {
      wallet: owner.toBase58(),
      ata: state.ata.toBase58(),
      ata_balance_usdc: Number(state.ataBalance) / 1_000_000,
      allowance_usdc: Number(state.allowance) / 1_000_000,
      eligible: state.eligible,
      ...(state.reason ? { reason: state.reason } : {}),
    },
  };
}
