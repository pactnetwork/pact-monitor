import { Connection } from "@solana/web3.js";
import { loadOrCreateWallet } from "../lib/wallet.ts";
import {
  USDC_DEVNET_MINT,
  USDC_MAINNET_MINT,
  getUsdcAtaBalanceLamports,
  agentWalletPda,
  PACT_INSURANCE_PROGRAM_ID_DEVNET,
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
  const lamports = await getUsdcAtaBalanceLamports({
    connection: conn,
    agentPubkey: wallet.keypair.publicKey,
    mint,
  });
  const balanceUsdc = Number(lamports) / 1_000_000;

  const programId =
    opts.cluster === "devnet" ? PACT_INSURANCE_PROGRAM_ID_DEVNET : PACT_INSURANCE_PROGRAM_ID_DEVNET;
  const _pda = agentWalletPda(wallet.keypair.publicKey, programId);
  // V1: pendingRefund read deferred to lib/solana follow-up; report 0 for now
  const pendingRefundUsdc = 0;

  return {
    status: "ok",
    body: {
      wallet: wallet.keypair.publicKey.toBase58(),
      balance_usdc: balanceUsdc,
      pending_refund_usdc: pendingRefundUsdc,
    },
  };
}
