import { Connection, PublicKey } from "@solana/web3.js";
import {
  getAgentInsurableState,
  getSettlementAuthorityPda,
} from "@pact-network/protocol-v1-client";
import { loadOrCreateWallet } from "../lib/wallet.ts";
import {
  USDC_DEVNET_MINT,
  USDC_MAINNET_MINT,
  PACT_NETWORK_V1_PROGRAM_ID,
} from "../lib/solana.ts";
import type { Envelope } from "../lib/envelope.ts";

export async function balanceCommand(opts: {
  configDir: string;
  rpcUrl: string;
  cluster: "devnet" | "mainnet";
}): Promise<Envelope> {
  const wallet = loadOrCreateWallet({ configDir: opts.configDir });
  const conn = new Connection(opts.rpcUrl, "confirmed");
  const mint = opts.cluster === "devnet" ? USDC_DEVNET_MINT : USDC_MAINNET_MINT;
  const programId = PACT_NETWORK_V1_PROGRAM_ID;
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
