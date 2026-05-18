/**
 * verify-network.ts — deterministically resolve plan blockers B1 and B2 by
 * proving them on-chain / over the network. READ-ONLY: sends no transactions.
 *
 * B1 (devnet program ID). `@pact-network/protocol-v1-client/constants.ts` marks
 * `5jBQb7fL…` as ORPHAN_PROGRAM_ID_DEVNET_STEP_C ("MUST NOT send transactions")
 * while CLAUDE.md / README / the settler env default still treat it as the live
 * devnet deploy. The repo cannot answer which is true. This script answers it
 * from a live devnet RPC: it derives the ProtocolConfig + SettlementAuthority
 * PDAs for the candidate program ID, fetches them, asserts the accounts exist
 * and are owned by that program, decodes them, and asserts the protocol is not
 * paused and bound to the devnet USDC mint. Owner-equality alone is NOT proof
 * (a PDA's owner is the program by construction) — the decode + paused + mint
 * assertions are the liveness gate, mirroring the production check in
 * scripts/mainnet/topup-settler.ts:166-190.
 *
 * B2 (indexer host). Probes `{indexer}/api/stats` then `/health`. A 2xx is a
 * hard PASS; anything else is a non-blocking SOFT-FAIL (the on-chain refund
 * still settles regardless of indexer reachability).
 *
 * Usage:
 *   pnpm tsx verify-network.ts --program-id 5jBQb7fL… [--rpc URL] [--indexer URL] [--json]
 *   pnpm tsx verify-network.ts --program-id 5jBQb7fL… --allow-mint-mismatch
 *
 * Environment (argv wins over env):
 *   PACT_DEVNET_PROGRAM_ID   candidate program ID
 *   SOLANA_RPC_URL           devnet RPC (default https://api.devnet.solana.com)
 *   PACT_DEVNET_INDEXER_URL  indexer base URL (default https://indexer.pactnetwork.io)
 *
 * Exit codes:
 *   0  B1 PASS (B2 PASS or SOFT-FAIL) — safe to wire PROGRAM_ID_DEVNET
 *   1  B1 FAIL — devnet program genuinely dead/misbound; ops must supply a
 *      live devnet program ID (the one true external dependency)
 *   2  argument / RPC error
 */
import { Connection, PublicKey } from "@solana/web3.js";
import {
  decodeProtocolConfig,
  decodeSettlementAuthority,
  getProtocolConfigPda,
  getSettlementAuthorityPda,
  USDC_MINT_DEVNET,
} from "@pact-network/protocol-v1-client";

const DEFAULT_RPC = "https://api.devnet.solana.com";
const DEFAULT_INDEXER = "https://indexer.pactnetwork.io";
const PROBE_TIMEOUT_MS = 10_000;

interface CliArgs {
  programId: string;
  rpc: string;
  indexer: string;
  json: boolean;
  allowMintMismatch: boolean;
}

function printUsageAndExit(code: number): never {
  console.error(
    `Usage: pnpm tsx verify-network.ts --program-id <pubkey> [--rpc URL] [--indexer URL] [--json] [--allow-mint-mismatch]

Env fallbacks: PACT_DEVNET_PROGRAM_ID, SOLANA_RPC_URL (default ${DEFAULT_RPC}),
               PACT_DEVNET_INDEXER_URL (default ${DEFAULT_INDEXER})

Exit: 0 B1 PASS · 1 B1 FAIL (ops must supply a live devnet program ID) · 2 arg/RPC error`,
  );
  process.exit(code);
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    programId: process.env.PACT_DEVNET_PROGRAM_ID ?? "",
    rpc: process.env.SOLANA_RPC_URL ?? DEFAULT_RPC,
    indexer: process.env.PACT_DEVNET_INDEXER_URL ?? DEFAULT_INDEXER,
    json: false,
    allowMintMismatch: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--program-id") out.programId = argv[++i] ?? "";
    else if (a === "--rpc") out.rpc = argv[++i] ?? "";
    else if (a === "--indexer") out.indexer = argv[++i] ?? "";
    else if (a === "--json") out.json = true;
    else if (a === "--allow-mint-mismatch") out.allowMintMismatch = true;
    else if (a === "--help" || a === "-h") printUsageAndExit(0);
    else {
      console.error(`unknown argument: ${a}`);
      printUsageAndExit(2);
    }
  }
  if (!out.programId) {
    console.error("--program-id <pubkey> (or PACT_DEVNET_PROGRAM_ID) is required");
    printUsageAndExit(2);
  }
  return out;
}

function toBase58(pk: unknown): string {
  return new PublicKey(pk as never).toBase58();
}

interface B1Result {
  pass: boolean;
  programId: string;
  protocolConfigPda: string;
  settlementAuthorityPda: string;
  authority?: string;
  usdcMint?: string;
  usdcMintMatchesDevnet?: boolean;
  paused?: number;
  settlementSigner?: string;
  reason?: string;
}

async function verifyB1(args: CliArgs): Promise<B1Result> {
  let programId: PublicKey;
  try {
    programId = new PublicKey(args.programId);
  } catch {
    return {
      pass: false,
      programId: args.programId,
      protocolConfigPda: "",
      settlementAuthorityPda: "",
      reason: `invalid --program-id: ${args.programId}`,
    };
  }

  const [cfgPda] = getProtocolConfigPda(programId);
  const [saPda] = getSettlementAuthorityPda(programId);
  const base: B1Result = {
    pass: false,
    programId: programId.toBase58(),
    protocolConfigPda: cfgPda.toBase58(),
    settlementAuthorityPda: saPda.toBase58(),
  };

  const conn = new Connection(args.rpc, "confirmed");
  let cfgInfo, saInfo;
  try {
    [cfgInfo, saInfo] = await Promise.all([
      conn.getAccountInfo(cfgPda, "confirmed"),
      conn.getAccountInfo(saPda, "confirmed"),
    ]);
  } catch (err) {
    // RPC failure is not a B1 verdict — it's an environment error.
    console.error(`RPC error against ${args.rpc}: ${(err as Error).message ?? err}`);
    process.exit(2);
  }

  if (!cfgInfo) {
    return { ...base, reason: `ProtocolConfig PDA ${cfgPda.toBase58()} not found on ${args.rpc} — program not deployed/initialized here` };
  }
  if (!saInfo) {
    return { ...base, reason: `SettlementAuthority PDA ${saPda.toBase58()} not found on ${args.rpc} — program not fully initialized here` };
  }
  if (!cfgInfo.owner.equals(programId)) {
    return { ...base, reason: `ProtocolConfig PDA owned by ${cfgInfo.owner.toBase58()}, not the candidate program` };
  }
  if (!saInfo.owner.equals(programId)) {
    return { ...base, reason: `SettlementAuthority PDA owned by ${saInfo.owner.toBase58()}, not the candidate program` };
  }

  let cfg, sa;
  try {
    cfg = decodeProtocolConfig(cfgInfo.data);
    sa = decodeSettlementAuthority(saInfo.data);
  } catch (err) {
    return { ...base, reason: `account decode failed (wrong layout / not a Pact V1 program): ${(err as Error).message ?? err}` };
  }

  const authority = toBase58(cfg.authority);
  const usdcMint = toBase58(cfg.usdcMint);
  const settlementSigner = toBase58(sa.signer);
  const usdcMintMatchesDevnet = usdcMint === USDC_MINT_DEVNET.toBase58();
  const enriched: B1Result = {
    ...base,
    authority,
    usdcMint,
    usdcMintMatchesDevnet,
    paused: cfg.paused,
    settlementSigner,
  };

  if (cfg.paused !== 0) {
    return { ...enriched, reason: `program is PAUSED (ProtocolConfig.paused=${cfg.paused}) — live but not settling` };
  }
  if (!usdcMintMatchesDevnet && !args.allowMintMismatch) {
    return {
      ...enriched,
      reason:
        `ProtocolConfig.usdcMint ${usdcMint} != devnet USDC ${USDC_MINT_DEVNET.toBase58()}; ` +
        `SDK devnet ATA derivation would not match. Re-run with --allow-mint-mismatch to treat as live anyway.`,
    };
  }

  return { ...enriched, pass: true };
}

type B2Verdict = "PASS" | "SOFT-FAIL";

async function probe(url: string): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "GET", signal: ctrl.signal });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function verifyB2(indexer: string): Promise<{ verdict: B2Verdict; checked: string[] }> {
  const base = indexer.replace(/\/+$/, "");
  const stats = `${base}/api/stats`;
  const health = `${base}/health`;
  if (await probe(stats)) return { verdict: "PASS", checked: [stats] };
  if (await probe(health)) return { verdict: "PASS", checked: [stats, health] };
  return { verdict: "SOFT-FAIL", checked: [stats, health] };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const b1 = await verifyB1(args);
  const b2 = await verifyB2(args.indexer);

  if (args.json) {
    console.log(JSON.stringify({ b1, b2, rpc: args.rpc, indexer: args.indexer }, null, 2));
  } else {
    console.log("");
    console.log(`B1 — devnet program ID  (RPC: ${args.rpc})`);
    console.log(`  candidate program     = ${b1.programId}`);
    console.log(`  ProtocolConfig PDA    = ${b1.protocolConfigPda}`);
    console.log(`  SettlementAuth PDA    = ${b1.settlementAuthorityPda}`);
    if (b1.authority) console.log(`  ProtocolConfig.authority = ${b1.authority}`);
    if (b1.usdcMint)
      console.log(
        `  ProtocolConfig.usdcMint  = ${b1.usdcMint} ` +
          `(${b1.usdcMintMatchesDevnet ? "== devnet USDC" : "!= devnet USDC"})`,
      );
    if (b1.paused !== undefined) console.log(`  ProtocolConfig.paused    = ${b1.paused}`);
    if (b1.settlementSigner)
      console.log(`  SettlementAuthority.signer = ${b1.settlementSigner}  (the delegate agents Approve)`);
    console.log(`  => B1 ${b1.pass ? "PASS — program is live on this RPC" : "FAIL"}`);
    if (!b1.pass) console.log(`     reason: ${b1.reason}`);
    console.log("");
    console.log(`B2 — indexer host  (${args.indexer})`);
    console.log(`  probed: ${b2.checked.join(", ")}`);
    console.log(`  => B2 ${b2.verdict}${b2.verdict === "SOFT-FAIL" ? " — non-blocking; refunds still settle on-chain" : ""}`);
    console.log("");
  }

  if (!b1.pass) {
    console.error(
      "B1 UNRESOLVED — ops must supply a live devnet program ID. " +
        "Do NOT wire PROGRAM_ID_DEVNET / network.ts until B1 PASSes.",
    );
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
