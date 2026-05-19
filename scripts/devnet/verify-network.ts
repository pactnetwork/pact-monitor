/**
 * verify-network.ts — deterministically resolve plan blockers by proving them
 * on-chain / over the network. READ-ONLY: sends no transactions.
 *
 * Three subcommands (the first positional arg; default = `verify`):
 *
 *   verify         (default) — B1/B2 *liveness only*. Derives ProtocolConfig +
 *                  SettlementAuthority PDAs for the candidate program ID,
 *                  fetches + decodes them, asserts not-paused + devnet USDC
 *                  mint; probes the indexer host. Exit 0 = accounts decode /
 *                  1 B1 dead / 2 arg-RPC. (Unchanged behavior — local-soft-
 *                  e2e.sh relies on this being the default.)
 *                  IMPORTANT: a decode/liveness pass does NOT mean B1 is
 *                  resolved and does NOT prove `settle_batch` can execute.
 *                  The devnet binary's `declare_id!` is the mainnet id, so
 *                  settle_batch reverts InvalidSeeds on devnet regardless of
 *                  this exit code. "B1 resolved" requires the strict
 *                  CallRecord proof (`assert-refund`), not this mode.
 *
 *   probe          Step-0 strict-E2E inventory + authority gate. Everything
 *                  `verify` does, PLUS: decode Treasury, and per `--slug`
 *                  decode EndpointConfig + CoveragePool and read the pool's
 *                  USDC vault token balance. With `--expect-authority <pk>`
 *                  asserts ProtocolConfig.authority == SettlementAuthority
 *                  .signer == <pk> (the key the user will sign init/settle
 *                  with). With `--require-provisioned <slug>` hard-fails
 *                  (exit 1) unless that slug's EndpointConfig + CoveragePool
 *                  exist AND the pool vault holds >= --min-pool-lamports.
 *
 *   assert-refund  Step-8 independent on-chain proof of a REAL refund (the
 *                  Critical-1 false-pass guard: the settler pushes the
 *                  *intended* refund to the indexer, NOT the on-chain
 *                  actual_refund_lamports — a depleted pool settles
 *                  "successfully" with 0 USDC moved yet the indexer still
 *                  reports refundLamports>0, so the SDK strict assertion
 *                  green-passes). Given --call-id + --agent + --ata-pre,
 *                  derives the CallRecord PDA (same parseCallId as the
 *                  settler), asserts settlementStatus==Settled AND
 *                  actualRefundLamports>0, and asserts the agent USDC ATA
 *                  delta == actualRefund - premium. Exit 0 PASS / 1 FAIL.
 *
 * Usage:
 *   pnpm tsx verify-network.ts --program-id 5jBQb7fL… [--rpc URL] [--indexer URL] [--json]
 *   pnpm tsx verify-network.ts probe --program-id 5jBQb7fL… \
 *       --expect-authority 47Fg5J… --require-provisioned dummy [--min-pool-lamports 10000] [--json]
 *   pnpm tsx verify-network.ts assert-refund --program-id 5jBQb7fL… \
 *       --call-id <uuid|hex> --agent <pubkey> --ata-pre <lamports> [--min-refund 1] [--json]
 *
 * Environment (argv wins over env):
 *   PACT_DEVNET_PROGRAM_ID   candidate program ID
 *   SOLANA_RPC_URL           devnet RPC (default https://api.devnet.solana.com)
 *   PACT_DEVNET_INDEXER_URL  indexer base URL (default https://indexer.pactnetwork.io)
 *
 * Exit codes (all modes):
 *   0  PASS
 *   1  FAIL — B1 dead / authority mismatch / slug unprovisioned or pool
 *      underfunded / on-chain refund not real (the one true blocker class)
 *   2  argument / RPC error
 */
import { Connection, PublicKey } from "@solana/web3.js";
import {
  decodeProtocolConfig,
  decodeSettlementAuthority,
  decodeTreasury,
  decodeEndpointConfig,
  decodeCoveragePool,
  decodeCallRecord,
  deriveAssociatedTokenAccount,
  getProtocolConfigPda,
  getSettlementAuthorityPda,
  getTreasuryPda,
  getEndpointConfigPda,
  getCoveragePoolPda,
  getCallRecordPda,
  SettlementStatus,
  USDC_MINT_DEVNET,
} from "@pact-network/protocol-v1-client";

const DEFAULT_RPC = "https://api.devnet.solana.com";
const DEFAULT_INDEXER = "https://indexer.pactnetwork.io";
const PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_MIN_POOL_LAMPORTS = 10_000n; // imputed_cost for `dummy`

type Mode = "verify" | "probe" | "assert-refund" | "ata-balance";

interface CliArgs {
  mode: Mode;
  programId: string;
  rpc: string;
  indexer: string;
  json: boolean;
  allowMintMismatch: boolean;
  // probe
  slugs: string[];
  expectAuthority?: string;
  requireProvisioned?: string;
  minPoolLamports: bigint;
  // assert-refund
  callId?: string;
  agent?: string;
  ataPre?: bigint;
  minRefund: bigint;
}

function printUsageAndExit(code: number): never {
  console.error(
    `Usage:
  verify-network.ts [verify] --program-id <pk> [--rpc URL] [--indexer URL] [--json] [--allow-mint-mismatch]
  verify-network.ts probe --program-id <pk> [--slug s]... [--expect-authority <pk>]
                          [--require-provisioned <slug>] [--min-pool-lamports N] [--rpc URL] [--json]
  verify-network.ts assert-refund --program-id <pk> --call-id <uuid|hex> --agent <pk>
                          --ata-pre <lamports> [--min-refund N] [--rpc URL] [--json]

Env fallbacks: PACT_DEVNET_PROGRAM_ID, SOLANA_RPC_URL (default ${DEFAULT_RPC}),
               PACT_DEVNET_INDEXER_URL (default ${DEFAULT_INDEXER})

Exit: 0 PASS · 1 FAIL (the blocker) · 2 arg/RPC error`,
  );
  process.exit(code);
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    mode: "verify",
    programId: process.env.PACT_DEVNET_PROGRAM_ID ?? "",
    rpc: process.env.SOLANA_RPC_URL ?? DEFAULT_RPC,
    indexer: process.env.PACT_DEVNET_INDEXER_URL ?? DEFAULT_INDEXER,
    json: false,
    allowMintMismatch: false,
    slugs: [],
    minPoolLamports: DEFAULT_MIN_POOL_LAMPORTS,
    minRefund: 1n,
  };
  let i = 0;
  // First positional (no leading "-") selects the mode; default `verify`
  // keeps the legacy CLI that local-soft-e2e.sh + the package script call.
  if (argv[0] && !argv[0].startsWith("-")) {
    const m = argv[0];
    if (
      m === "verify" ||
      m === "probe" ||
      m === "assert-refund" ||
      m === "ata-balance"
    ) {
      out.mode = m;
      i = 1;
    } else {
      console.error(`unknown subcommand: ${m}`);
      printUsageAndExit(2);
    }
  }
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--program-id") out.programId = argv[++i] ?? "";
    else if (a === "--rpc") out.rpc = argv[++i] ?? "";
    else if (a === "--indexer") out.indexer = argv[++i] ?? "";
    else if (a === "--json") out.json = true;
    else if (a === "--allow-mint-mismatch") out.allowMintMismatch = true;
    else if (a === "--slug") out.slugs.push(argv[++i] ?? "");
    else if (a === "--expect-authority") out.expectAuthority = argv[++i] ?? "";
    else if (a === "--require-provisioned")
      out.requireProvisioned = argv[++i] ?? "";
    else if (a === "--min-pool-lamports")
      out.minPoolLamports = BigInt(argv[++i] ?? "0");
    else if (a === "--call-id") out.callId = argv[++i] ?? "";
    else if (a === "--agent") out.agent = argv[++i] ?? "";
    else if (a === "--ata-pre") out.ataPre = BigInt(argv[++i] ?? "0");
    else if (a === "--min-refund") out.minRefund = BigInt(argv[++i] ?? "1");
    else if (a === "--help" || a === "-h") printUsageAndExit(0);
    else {
      console.error(`unknown argument: ${a}`);
      printUsageAndExit(2);
    }
  }
  if (!out.programId) {
    console.error(
      "--program-id <pubkey> (or PACT_DEVNET_PROGRAM_ID) is required",
    );
    printUsageAndExit(2);
  }
  if (out.mode === "assert-refund") {
    if (!out.callId || !out.agent || out.ataPre === undefined) {
      console.error(
        "assert-refund requires --call-id, --agent and --ata-pre",
      );
      printUsageAndExit(2);
    }
  }
  if (out.mode === "ata-balance" && !out.agent) {
    console.error("ata-balance requires --agent");
    printUsageAndExit(2);
  }
  return out;
}

function toBase58(pk: unknown): string {
  return new PublicKey(pk as never).toBase58();
}

/**
 * Same as the settler's parseCallId (submitter.service.ts:515): accept a
 * UUID-style or 32-hex callId, emit the exact 16 bytes the on-chain handler
 * keyed the CallRecord PDA with. Must stay byte-identical or the derived PDA
 * is wrong and the proof silently "not found".
 */
function parseCallId(callId: string): Uint8Array {
  const hex = callId.replace(/-/g, "");
  if (hex.length !== 32) {
    throw new Error(`callId must be 16 bytes (32 hex chars); got "${callId}"`);
  }
  const out = new Uint8Array(16);
  for (let n = 0; n < 16; n++) {
    out[n] = parseInt(hex.slice(n * 2, n * 2 + 2), 16);
  }
  return out;
}

async function tokenBalanceLamports(
  conn: Connection,
  ata: PublicKey,
): Promise<bigint | null> {
  try {
    const b = await conn.getTokenAccountBalance(ata, "confirmed");
    return BigInt(b.value.amount);
  } catch {
    return null; // account does not exist yet
  }
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

async function verifyB1(conn: Connection, args: CliArgs): Promise<B1Result> {
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

  let cfgInfo, saInfo;
  try {
    [cfgInfo, saInfo] = await Promise.all([
      conn.getAccountInfo(cfgPda, "confirmed"),
      conn.getAccountInfo(saPda, "confirmed"),
    ]);
  } catch (err) {
    console.error(
      `RPC error against ${args.rpc}: ${(err as Error).message ?? err}`,
    );
    process.exit(2);
  }

  if (!cfgInfo) {
    return {
      ...base,
      reason: `ProtocolConfig PDA ${cfgPda.toBase58()} not found on ${args.rpc} — program not deployed/initialized here`,
    };
  }
  if (!saInfo) {
    return {
      ...base,
      reason: `SettlementAuthority PDA ${saPda.toBase58()} not found on ${args.rpc} — program not fully initialized here`,
    };
  }
  if (!cfgInfo.owner.equals(programId)) {
    return {
      ...base,
      reason: `ProtocolConfig PDA owned by ${cfgInfo.owner.toBase58()}, not the candidate program`,
    };
  }
  if (!saInfo.owner.equals(programId)) {
    return {
      ...base,
      reason: `SettlementAuthority PDA owned by ${saInfo.owner.toBase58()}, not the candidate program`,
    };
  }

  let cfg, sa;
  try {
    cfg = decodeProtocolConfig(cfgInfo.data);
    sa = decodeSettlementAuthority(saInfo.data);
  } catch (err) {
    return {
      ...base,
      reason: `account decode failed (wrong layout / not a Pact V1 program): ${(err as Error).message ?? err}`,
    };
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
    return {
      ...enriched,
      reason: `program is PAUSED (ProtocolConfig.paused=${cfg.paused}) — live but not settling`,
    };
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

async function probeUrl(url: string): Promise<boolean> {
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

async function verifyB2(
  indexer: string,
): Promise<{ verdict: B2Verdict; checked: string[] }> {
  const base = indexer.replace(/\/+$/, "");
  const stats = `${base}/api/stats`;
  const health = `${base}/health`;
  if (await probeUrl(stats)) return { verdict: "PASS", checked: [stats] };
  if (await probeUrl(health))
    return { verdict: "PASS", checked: [stats, health] };
  return { verdict: "SOFT-FAIL", checked: [stats, health] };
}

interface EndpointInventory {
  slug: string;
  endpointConfigPda: string;
  endpointConfigExists: boolean;
  paused?: boolean;
  flatPremiumLamports?: string;
  imputedCostLamports?: string;
  slaLatencyMs?: number;
  coveragePoolPda: string;
  coveragePoolExists: boolean;
  poolVault?: string;
  poolVaultBalance?: string;
  poolCurrentBalance?: string;
}

async function inventoryEndpoint(
  conn: Connection,
  programId: PublicKey,
  slug: string,
): Promise<EndpointInventory> {
  const [ecPda] = getEndpointConfigPda(programId, slug);
  const [cpPda] = getCoveragePoolPda(programId, slug);
  const inv: EndpointInventory = {
    slug,
    endpointConfigPda: ecPda.toBase58(),
    endpointConfigExists: false,
    coveragePoolPda: cpPda.toBase58(),
    coveragePoolExists: false,
  };
  const [ecInfo, cpInfo] = await Promise.all([
    conn.getAccountInfo(ecPda, "confirmed"),
    conn.getAccountInfo(cpPda, "confirmed"),
  ]);
  if (ecInfo) {
    try {
      const ec = decodeEndpointConfig(ecInfo.data);
      inv.endpointConfigExists = true;
      inv.paused = ec.paused;
      inv.flatPremiumLamports = ec.flatPremiumLamports.toString();
      inv.imputedCostLamports = ec.imputedCostLamports.toString();
      inv.slaLatencyMs = ec.slaLatencyMs;
    } catch {
      /* present but undecodable — leave exists=false */
    }
  }
  if (cpInfo) {
    try {
      const cp = decodeCoveragePool(cpInfo.data);
      inv.coveragePoolExists = true;
      inv.poolCurrentBalance = cp.currentBalance.toString();
      const vault = new PublicKey(cp.usdcVault as never);
      inv.poolVault = vault.toBase58();
      const bal = await tokenBalanceLamports(conn, vault);
      inv.poolVaultBalance = bal === null ? "n/a" : bal.toString();
    } catch {
      /* present but undecodable */
    }
  }
  return inv;
}

async function runProbe(conn: Connection, args: CliArgs): Promise<number> {
  const b1 = await verifyB1(conn, args);
  const programId = new PublicKey(args.programId);

  // Treasury
  const [tPda] = getTreasuryPda(programId);
  const tInfo = await conn.getAccountInfo(tPda, "confirmed");
  let treasury: {
    pda: string;
    initialized: boolean;
    authority?: string;
    vault?: string;
    vaultBalance?: string;
  } = { pda: tPda.toBase58(), initialized: false };
  if (tInfo) {
    try {
      const t = decodeTreasury(tInfo.data);
      const vault = new PublicKey(t.usdcVault as never);
      const vbal = await tokenBalanceLamports(conn, vault);
      treasury = {
        pda: tPda.toBase58(),
        initialized: true,
        authority: toBase58(t.authority),
        vault: vault.toBase58(),
        vaultBalance: vbal === null ? "n/a" : vbal.toString(),
      };
    } catch {
      /* undecodable */
    }
  }

  const slugs = args.slugs.length ? args.slugs : ["dummy", "helius"];
  const endpoints: EndpointInventory[] = [];
  for (const s of slugs) endpoints.push(await inventoryEndpoint(conn, programId, s));

  // Authority gate: ProtocolConfig.authority == SettlementAuthority.signer
  // == the key the user will sign init-devnet/settler with.
  const failures: string[] = [];
  if (!b1.pass) failures.push(`B1 FAIL: ${b1.reason}`);
  if (b1.authority && b1.settlementSigner && b1.authority !== b1.settlementSigner) {
    failures.push(
      `ProtocolConfig.authority (${b1.authority}) != SettlementAuthority.signer (${b1.settlementSigner}) — split authority; init-devnet and settler need different keys`,
    );
  }
  if (args.expectAuthority) {
    if (b1.authority !== args.expectAuthority) {
      failures.push(
        `--expect-authority ${args.expectAuthority} != on-chain ProtocolConfig.authority ${b1.authority}`,
      );
    }
    if (b1.settlementSigner !== args.expectAuthority) {
      failures.push(
        `--expect-authority ${args.expectAuthority} != on-chain SettlementAuthority.signer ${b1.settlementSigner}`,
      );
    }
  }
  if (args.requireProvisioned) {
    const inv = endpoints.find((e) => e.slug === args.requireProvisioned);
    if (!inv || !inv.endpointConfigExists || !inv.coveragePoolExists) {
      failures.push(
        `--require-provisioned ${args.requireProvisioned}: EndpointConfig/CoveragePool not on-chain — run init-devnet first`,
      );
    } else {
      const vb =
        inv.poolVaultBalance && inv.poolVaultBalance !== "n/a"
          ? BigInt(inv.poolVaultBalance)
          : -1n;
      if (vb < args.minPoolLamports) {
        failures.push(
          `--require-provisioned ${args.requireProvisioned}: pool vault ${inv.poolVault} balance ${inv.poolVaultBalance} < required ${args.minPoolLamports} — fund the pool vault (refunds are paid from it)`,
        );
      }
    }
  }

  const result = {
    mode: "probe",
    rpc: args.rpc,
    b1,
    treasury,
    endpoints,
    expectAuthority: args.expectAuthority ?? null,
    requireProvisioned: args.requireProvisioned ?? null,
    minPoolLamports: args.minPoolLamports.toString(),
    pass: failures.length === 0,
    failures,
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("");
    console.log(`probe — RPC ${args.rpc}`);
    console.log(`  program            = ${b1.programId}`);
    console.log(`  ProtocolConfig.authority   = ${b1.authority ?? "?"}`);
    console.log(`  SettlementAuthority.signer = ${b1.settlementSigner ?? "?"}`);
    console.log(`  ProtocolConfig.paused      = ${b1.paused ?? "?"}`);
    console.log(
      `  Treasury           = ${treasury.initialized ? `OK vault=${treasury.vault} bal=${treasury.vaultBalance}` : "NOT INITIALIZED (init-devnet will create it)"}`,
    );
    for (const e of endpoints) {
      console.log(
        `  endpoint[${e.slug}]   EC=${e.endpointConfigExists ? "yes" : "NO"} pool=${e.coveragePoolExists ? "yes" : "NO"}` +
          (e.coveragePoolExists
            ? ` vault=${e.poolVault} vaultBal=${e.poolVaultBalance} (flatPremium=${e.flatPremiumLamports} imputedCost=${e.imputedCostLamports})`
            : ""),
      );
    }
    console.log(
      `  => probe ${result.pass ? "PASS" : "FAIL"}${result.pass ? "" : "\n     - " + failures.join("\n     - ")}`,
    );
    console.log("");
  }
  return result.pass ? 0 : 1;
}

async function runAssertRefund(
  conn: Connection,
  args: CliArgs,
): Promise<number> {
  const programId = new PublicKey(args.programId);
  let agent: PublicKey;
  try {
    agent = new PublicKey(args.agent as string);
  } catch {
    console.error(`invalid --agent: ${args.agent}`);
    return 2;
  }

  let callIdBytes: Uint8Array;
  try {
    callIdBytes = parseCallId(args.callId as string);
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }

  // USDC mint = on-chain ProtocolConfig.usdcMint (devnet USDC), the same mint
  // the SDK/agent ATA was derived against.
  const [cfgPda] = getProtocolConfigPda(programId);
  const cfgInfo = await conn.getAccountInfo(cfgPda, "confirmed");
  let usdcMint = USDC_MINT_DEVNET;
  if (cfgInfo) {
    try {
      usdcMint = new PublicKey(decodeProtocolConfig(cfgInfo.data).usdcMint as never);
    } catch {
      /* fall back to devnet USDC */
    }
  }
  const ata = deriveAssociatedTokenAccount(agent, usdcMint);

  const [crPda] = getCallRecordPda(programId, callIdBytes);
  const crInfo = await conn.getAccountInfo(crPda, "confirmed");
  const failures: string[] = [];

  let cr:
    | {
        settlementStatus: SettlementStatus;
        premiumLamports: bigint;
        refundLamports: bigint;
        actualRefundLamports: bigint;
        breach: boolean;
      }
    | undefined;
  if (!crInfo) {
    failures.push(
      `CallRecord PDA ${crPda.toBase58()} not found — settle_batch never ran for callId ${args.callId} (settler did not consume/submit, or pool/key wrong)`,
    );
  } else {
    try {
      cr = decodeCallRecord(crInfo.data);
    } catch (err) {
      failures.push(`CallRecord decode failed: ${(err as Error).message}`);
    }
  }

  const statusName = (s: SettlementStatus): string =>
    SettlementStatus[s] ?? `unknown(${s})`;

  if (cr) {
    if (cr.settlementStatus !== SettlementStatus.Settled) {
      failures.push(
        `settlementStatus = ${statusName(cr.settlementStatus)} (NOT Settled) — settle_batch "succeeded" on-chain but moved no/partial USDC; this is the false-pass the SDK assertion alone cannot see`,
      );
    }
    if (cr.actualRefundLamports < args.minRefund) {
      failures.push(
        `actualRefundLamports = ${cr.actualRefundLamports} < required ${args.minRefund} — no real USDC refund occurred`,
      );
    }
  }

  const ataPost = await tokenBalanceLamports(conn, ata);
  let ataDelta: bigint | null = null;
  if (ataPost !== null) {
    ataDelta = ataPost - (args.ataPre as bigint);
  }
  if (cr && ataPost !== null) {
    const expectedDelta = cr.actualRefundLamports - cr.premiumLamports;
    if (ataDelta !== expectedDelta) {
      failures.push(
        `agent ATA delta ${ataDelta} != actualRefund(${cr.actualRefundLamports}) - premium(${cr.premiumLamports}) = ${expectedDelta} — on-chain token movement does not match the settled CallRecord`,
      );
    }
  } else if (ataPost === null) {
    failures.push(`agent USDC ATA ${ata.toBase58()} not found post-settle`);
  }

  const result = {
    mode: "assert-refund",
    rpc: args.rpc,
    callId: args.callId,
    agent: agent.toBase58(),
    agentAta: ata.toBase58(),
    callRecordPda: crPda.toBase58(),
    settlementStatus: cr ? statusName(cr.settlementStatus) : null,
    breach: cr ? cr.breach : null,
    premiumLamports: cr ? cr.premiumLamports.toString() : null,
    refundLamports: cr ? cr.refundLamports.toString() : null,
    actualRefundLamports: cr ? cr.actualRefundLamports.toString() : null,
    ataPre: (args.ataPre as bigint).toString(),
    ataPost: ataPost === null ? null : ataPost.toString(),
    ataDelta: ataDelta === null ? null : ataDelta.toString(),
    pass: failures.length === 0,
    failures,
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("");
    console.log(`assert-refund — RPC ${args.rpc}`);
    console.log(`  callId          = ${args.callId}`);
    console.log(`  CallRecord PDA  = ${crPda.toBase58()}`);
    console.log(`  agent / ATA     = ${agent.toBase58()} / ${ata.toBase58()}`);
    console.log(`  settlementStatus= ${result.settlementStatus}`);
    console.log(
      `  premium/refund/ACTUAL = ${result.premiumLamports} / ${result.refundLamports} / ${result.actualRefundLamports}`,
    );
    console.log(
      `  agent ATA pre/post/delta = ${result.ataPre} / ${result.ataPost} / ${result.ataDelta}`,
    );
    console.log(
      `  => assert-refund ${result.pass ? "PASS — real on-chain refund proven" : "FAIL"}${result.pass ? "" : "\n     - " + failures.join("\n     - ")}`,
    );
    console.log("");
  }
  return result.pass ? 0 : 1;
}

/**
 * Print ONLY the agent USDC ATA balance (lamports) to stdout so the
 * orchestrator can capture the pre-call balance via $(...). Same ATA
 * derivation as assert-refund — they must agree. Missing ATA => "0".
 */
async function runAtaBalance(
  conn: Connection,
  args: CliArgs,
): Promise<number> {
  const programId = new PublicKey(args.programId);
  let agent: PublicKey;
  try {
    agent = new PublicKey(args.agent as string);
  } catch {
    console.error(`invalid --agent: ${args.agent}`);
    return 2;
  }
  const [cfgPda] = getProtocolConfigPda(programId);
  const cfgInfo = await conn.getAccountInfo(cfgPda, "confirmed");
  let usdcMint = USDC_MINT_DEVNET;
  if (cfgInfo) {
    try {
      usdcMint = new PublicKey(
        decodeProtocolConfig(cfgInfo.data).usdcMint as never,
      );
    } catch {
      /* fall back to devnet USDC */
    }
  }
  const ata = deriveAssociatedTokenAccount(agent, usdcMint);
  const bal = await tokenBalanceLamports(conn, ata);
  console.error(`agent ATA ${ata.toBase58()} balance = ${bal ?? 0} lamports`);
  console.log((bal ?? 0n).toString());
  return 0;
}

async function runVerify(conn: Connection, args: CliArgs): Promise<number> {
  const b1 = await verifyB1(conn, args);
  const b2 = await verifyB2(args.indexer);

  if (args.json) {
    console.log(
      JSON.stringify(
        { b1, b2, rpc: args.rpc, indexer: args.indexer },
        null,
        2,
      ),
    );
  } else {
    console.log("");
    console.log(`B1 — devnet program ID  (RPC: ${args.rpc})`);
    console.log(`  candidate program     = ${b1.programId}`);
    console.log(`  ProtocolConfig PDA    = ${b1.protocolConfigPda}`);
    console.log(`  SettlementAuth PDA    = ${b1.settlementAuthorityPda}`);
    if (b1.authority)
      console.log(`  ProtocolConfig.authority = ${b1.authority}`);
    if (b1.usdcMint)
      console.log(
        `  ProtocolConfig.usdcMint  = ${b1.usdcMint} ` +
          `(${b1.usdcMintMatchesDevnet ? "== devnet USDC" : "!= devnet USDC"})`,
      );
    if (b1.paused !== undefined)
      console.log(`  ProtocolConfig.paused    = ${b1.paused}`);
    if (b1.settlementSigner)
      console.log(
        `  SettlementAuthority.signer = ${b1.settlementSigner}  (the delegate agents Approve)`,
      );
    console.log(
      `  => B1 ${b1.pass ? "LIVENESS PASS — accounts decode on this RPC" : "FAIL"}`,
    );
    if (b1.pass) {
      console.log(
        `     NOTE: liveness only. This does NOT prove settle_batch can run.\n` +
          `     The devnet binary's declare_id! is the mainnet id, so\n` +
          `     settle_batch reverts InvalidSeeds on devnet. B1 is NOT\n` +
          `     resolved until the strict CallRecord proof (assert-refund)\n` +
          `     passes against a declare_id-matching redeploy.`,
      );
    }
    if (!b1.pass) console.log(`     reason: ${b1.reason}`);
    console.log("");
    console.log(`B2 — indexer host  (${args.indexer})`);
    console.log(`  probed: ${b2.checked.join(", ")}`);
    console.log(
      `  => B2 ${b2.verdict}${b2.verdict === "SOFT-FAIL" ? " — non-blocking; refunds still settle on-chain" : ""}`,
    );
    console.log("");
  }

  if (!b1.pass) {
    console.error(
      "B1 FAIL — no live devnet program at this ID. Note: even a liveness " +
        "PASS does not resolve B1; B1 is resolved only when the strict " +
        "CallRecord proof (assert-refund) passes against a redeploy whose " +
        "declare_id! == its deploy address. Do NOT ship PROGRAM_ID_DEVNET " +
        "as the network.ts devnet default until then.",
    );
    return 1;
  }
  return 0;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const conn = new Connection(args.rpc, "confirmed");
  let code: number;
  if (args.mode === "probe") code = await runProbe(conn, args);
  else if (args.mode === "assert-refund")
    code = await runAssertRefund(conn, args);
  else if (args.mode === "ata-balance")
    code = await runAtaBalance(conn, args);
  else code = await runVerify(conn, args);
  process.exit(code);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
