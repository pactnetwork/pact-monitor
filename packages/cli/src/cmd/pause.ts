import {
  Connection,
  Keypair,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  buildPauseProtocolIx,
  getProtocolConfigPda,
} from "@q3labs/pact-protocol-v1-client";
import { resolveClusterConfig } from "../lib/solana.ts";
import { loadAuthorityKeypair } from "../lib/authority.ts";
import type { Envelope } from "../lib/envelope.ts";

type SubmitPauseResult = { tx_signature: string; confirmation_pending: boolean };

export async function pauseCommand(opts: {
  rpcUrl: string;
  submitPause?: (params: {
    authority: Keypair;
    programId: import("@solana/web3.js").PublicKey;
    protocolConfigPda: import("@solana/web3.js").PublicKey;
  }) => Promise<SubmitPauseResult>;
}): Promise<Envelope> {
  const cfg = resolveClusterConfig();
  if ("error" in cfg) {
    return { status: "client_error", body: { error: cfg.error } };
  }

  const authResult = loadAuthorityKeypair({ commandLabel: "pact pause" });
  if ("error" in authResult) {
    return { status: "client_error", body: { error: authResult.error } };
  }
  const authority = authResult;
  const [protocolConfigPda] = getProtocolConfigPda(cfg.programId);

  const submit =
    opts.submitPause ??
    (async ({ authority, programId }): Promise<SubmitPauseResult> => {
      const conn = new Connection(opts.rpcUrl, "confirmed");
      const ix = buildPauseProtocolIx({
        programId,
        authority: authority.publicKey,
        paused: true,
      });
      const tx = new Transaction().add(ix);
      const sig = await sendAndConfirmTransaction(conn, tx, [authority]);
      return { tx_signature: sig, confirmation_pending: false };
    });

  try {
    const result = await submit({
      authority,
      programId: cfg.programId,
      protocolConfigPda,
    });
    return {
      status: "ok",
      body: {
        action: "pause",
        tx_signature: result.tx_signature,
        confirmation_pending: result.confirmation_pending,
        protocol_config: protocolConfigPda.toBase58(),
        authority: authority.publicKey.toBase58(),
      },
    };
  } catch (err) {
    return {
      status: "cli_internal_error",
      body: { error: (err as Error).message },
    };
  }
}
