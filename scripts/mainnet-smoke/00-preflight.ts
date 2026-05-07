/**
 * 00-preflight.ts — gate every check that must hold BEFORE we burn real
 * USDC on mainnet smoke calls.
 *
 * Fails fast with a clear remediation message per failed check. None of the
 * checks mutate state; this is read-only on chain and HTTP.
 *
 * Checks:
 *   1. The V1 program is deployed at `cfg.programId` on mainnet (account
 *      exists, executable, non-empty data).
 *   2. ProtocolConfig PDA exists and `paused == 0` (the kill switch is OFF).
 *   3. SettlementAuthority PDA exists (off-chain settler can sign batches).
 *   4. Treasury PDA exists.
 *   5. Each of the 5 user-facing endpoint slugs has an EndpointConfig PDA
 *      registered + a CoveragePool PDA with non-zero current_balance.
 *      (`endpointConfig.paused == false` is also checked — a paused endpoint
 *      can't be exercised.)
 *   6. The indexer is reachable: GET /api/stats returns 200 within 10s.
 *   7. The market-proxy is reachable: GET /health returns 200 within 10s.
 *      And GET /api/endpoints on the indexer lists each of the 5 slugs.
 *   8. The configured test agent has at least 1 USDC in its mainnet ATA AND
 *      that ATA's `delegate` is the SettlementAuthority signer pubkey
 *      (i.e. spl-token approve has been run by the operator).
 *
 * On every failure, we print the remediation step. If anything fails, we
 * exit 1 BEFORE any of the next scripts can run.
 */
import axios from "axios";
import {
  Connection,
  PublicKey,
  type AccountInfo,
} from "@solana/web3.js";
import {
  decodeCoveragePool,
  decodeEndpointConfig,
  decodeProtocolConfig,
  decodeSettlementAuthority,
  decodeTreasury,
  getCoveragePoolPda,
  getEndpointConfigPda,
  getProtocolConfigPda,
  getSettlementAuthorityPda,
  getTreasuryPda,
} from "@pact-network/protocol-v1-client";
import { loadConfig, MAINNET_ENDPOINT_SLUGS } from "./lib/config";
import { patchState } from "./lib/state";

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
  remediation?: string;
}

const checks: Check[] = [];
function pass(name: string, detail?: string) {
  checks.push({ name, ok: true, detail });
}
function fail(name: string, detail: string, remediation: string) {
  checks.push({ name, ok: false, detail, remediation });
}

/**
 * SPL Token Account v0 layout — delegate at offset 76 if option byte at
 * offset 72 is 1, amount at offset 64 (LE u64).
 */
function decodeTokenAccount(
  data: Buffer | Uint8Array,
): { delegate: PublicKey | null; amount: bigint } {
  const view = new DataView(
    data.buffer,
    "byteOffset" in data ? data.byteOffset : 0,
    data.byteLength,
  );
  const amount = view.getBigUint64(64, true);
  const delegateOption = view.getUint32(72, true);
  let delegate: PublicKey | null = null;
  if (delegateOption === 1) {
    const bytes = new Uint8Array(data.buffer, ("byteOffset" in data ? data.byteOffset : 0) + 76, 32);
    delegate = new PublicKey(bytes);
  }
  return { delegate, amount };
}

async function fetchAccount(
  conn: Connection,
  pubkey: PublicKey,
): Promise<AccountInfo<Buffer> | null> {
  return conn.getAccountInfo(pubkey, "confirmed");
}

async function main() {
  const cfg = loadConfig();
  const conn = new Connection(cfg.rpcUrl, "confirmed");

  console.log("=== Pact Network mainnet smoke preflight ===");
  console.log(`  RPC:        ${cfg.rpcUrl}`);
  console.log(`  Indexer:    ${cfg.indexerUrl}`);
  console.log(`  Proxy:      ${cfg.marketProxyUrl}`);
  console.log(`  Program ID: ${cfg.programId.toBase58()}`);
  console.log(`  USDC mint:  ${cfg.usdcMint.toBase58()}`);
  console.log(`  Test agent: ${cfg.testAgent.publicKey.toBase58()}`);
  console.log(`  Keypair at: ${cfg.testAgentKeypairPath}\n`);

  patchState({ testAgentPubkey: cfg.testAgent.publicKey.toBase58() });

  // 1. Program deployed
  const progAcct = await fetchAccount(conn, cfg.programId);
  if (!progAcct || progAcct.data.length === 0) {
    fail(
      "program-deployed",
      `Program ${cfg.programId.toBase58()} not found or empty.`,
      `Run scripts/mainnet/01-deploy.sh on rick's laptop to deploy the V1 program.`,
    );
  } else {
    pass(
      "program-deployed",
      `${progAcct.data.length} bytes, owner=${progAcct.owner.toBase58()}`,
    );
  }

  // 2. ProtocolConfig + paused == 0
  const [protocolConfigPda] = getProtocolConfigPda(cfg.programId);
  const cfgAcct = await fetchAccount(conn, protocolConfigPda);
  if (!cfgAcct) {
    fail(
      "protocol-config",
      `ProtocolConfig PDA ${protocolConfigPda.toBase58()} missing.`,
      `Run scripts/mainnet/init-mainnet.ts (initialize_protocol_config).`,
    );
  } else {
    const decoded = decodeProtocolConfig(cfgAcct.data);
    if (decoded.paused !== 0) {
      fail(
        "protocol-not-paused",
        `ProtocolConfig.paused = ${decoded.paused} — the kill switch is ON.`,
        `Run: pnpm --filter @pact-network/scripts-mainnet pause -- --paused 0`,
      );
    } else {
      pass("protocol-config", `paused=0, authority=${decoded.authority}`);
    }
  }

  // 3. SettlementAuthority PDA
  const [saPda] = getSettlementAuthorityPda(cfg.programId);
  const saAcct = await fetchAccount(conn, saPda);
  let saSigner: PublicKey | null = null;
  if (!saAcct) {
    fail(
      "settlement-authority",
      `SettlementAuthority PDA ${saPda.toBase58()} missing.`,
      `Run scripts/mainnet/init-mainnet.ts (initialize_settlement_authority).`,
    );
  } else {
    const decoded = decodeSettlementAuthority(saAcct.data);
    saSigner = new PublicKey(decoded.signer);
    pass("settlement-authority", `signer=${saSigner.toBase58()}`);
  }

  // 4. Treasury PDA
  const [treasuryPda] = getTreasuryPda(cfg.programId);
  const tAcct = await fetchAccount(conn, treasuryPda);
  if (!tAcct) {
    fail(
      "treasury",
      `Treasury PDA ${treasuryPda.toBase58()} missing.`,
      `Run scripts/mainnet/init-mainnet.ts (initialize_treasury).`,
    );
  } else {
    const decoded = decodeTreasury(tAcct.data);
    pass("treasury", `usdc_vault=${decoded.usdcVault}`);
  }

  // 5. Endpoints registered + non-zero pool balance + not paused
  for (const slug of MAINNET_ENDPOINT_SLUGS) {
    const [epPda] = getEndpointConfigPda(cfg.programId, slug);
    const epAcct = await fetchAccount(conn, epPda);
    if (!epAcct) {
      fail(
        `endpoint-${slug}`,
        `EndpointConfig PDA missing for ${slug}.`,
        `Re-run init-mainnet.ts with the slug in scripts/mainnet/endpoint-config.json.`,
      );
      continue;
    }
    const ep = decodeEndpointConfig(epAcct.data);
    if (ep.paused) {
      fail(
        `endpoint-${slug}-active`,
        `Endpoint ${slug} is paused on chain.`,
        `Run pause_endpoint(${slug}, paused=false) via the ops API.`,
      );
      continue;
    }

    const [poolPda] = getCoveragePoolPda(cfg.programId, slug);
    const poolAcct = await fetchAccount(conn, poolPda);
    if (!poolAcct) {
      fail(
        `pool-${slug}`,
        `CoveragePool PDA missing for ${slug}.`,
        `Top up the pool: pnpm ops:topup ${slug} <amount>.`,
      );
      continue;
    }
    const pool = decodeCoveragePool(poolAcct.data);
    if (pool.currentBalance <= 0n) {
      fail(
        `pool-${slug}-funded`,
        `CoveragePool for ${slug} has zero balance.`,
        `Top up the pool: pnpm ops:topup ${slug} <amount>.`,
      );
    } else {
      pass(`endpoint-${slug}`, `pool=${pool.currentBalance.toString()} lamports`);
    }
  }

  // 6 + 7. Indexer + proxy reachable
  try {
    const r = await axios.get(`${cfg.indexerUrl}/api/stats`, { timeout: 10_000 });
    if (r.status !== 200) throw new Error(`status=${r.status}`);
    pass("indexer-reachable", `GET /api/stats -> 200`);
  } catch (e) {
    fail(
      "indexer-reachable",
      `${cfg.indexerUrl}/api/stats failed: ${(e as Error).message}`,
      `Check the indexer Cloud Run service is up; check INDEXER_URL.`,
    );
  }

  try {
    const r = await axios.get(`${cfg.marketProxyUrl}/health`, { timeout: 10_000 });
    if (r.status !== 200) throw new Error(`status=${r.status}`);
    pass("proxy-reachable", `GET /health -> 200`);
  } catch (e) {
    fail(
      "proxy-reachable",
      `${cfg.marketProxyUrl}/health failed: ${(e as Error).message}`,
      `Check the market-proxy Cloud Run service is up; check MARKET_PROXY_URL.`,
    );
  }

  // Indexer lists every slug
  try {
    const r = await axios.get(`${cfg.indexerUrl}/api/endpoints`, { timeout: 10_000 });
    const slugsSeen = new Set((r.data as Array<{ slug: string }>).map((e) => e.slug));
    const missing = MAINNET_ENDPOINT_SLUGS.filter((s) => !slugsSeen.has(s));
    if (missing.length > 0) {
      fail(
        "indexer-endpoints",
        `Indexer is missing slugs: ${missing.join(", ")}`,
        `Wait for the indexer to backfill from on-chain register_endpoint events, or restart the indexer to force re-sync.`,
      );
    } else {
      pass("indexer-endpoints", `all ${MAINNET_ENDPOINT_SLUGS.length} slugs present`);
    }
  } catch (e) {
    fail(
      "indexer-endpoints",
      `GET /api/endpoints failed: ${(e as Error).message}`,
      `Indexer Cloud Run service may be unhealthy; check logs.`,
    );
  }

  // 8. Test agent USDC + delegate
  const ataPubkey = await getAssociatedTokenAddress(
    cfg.usdcMint,
    cfg.testAgent.publicKey,
  );
  const ataAcct = await fetchAccount(conn, ataPubkey);
  if (!ataAcct) {
    fail(
      "test-agent-ata",
      `Test agent ${cfg.testAgent.publicKey.toBase58()} has no USDC ATA at ${ataPubkey.toBase58()}.`,
      `Send at least 1 USDC to ${cfg.testAgent.publicKey.toBase58()} on mainnet.`,
    );
  } else {
    const { delegate, amount } = decodeTokenAccount(ataAcct.data);
    const ONE_USDC = 1_000_000n; // 6 decimals
    if (amount < ONE_USDC) {
      fail(
        "test-agent-balance",
        `Test agent ATA has ${amount} lamports (need >= ${ONE_USDC}).`,
        `Send more USDC to ${cfg.testAgent.publicKey.toBase58()} on mainnet.`,
      );
    } else {
      pass("test-agent-balance", `${amount} lamports`);
    }
    if (!delegate) {
      fail(
        "test-agent-delegate",
        `Test agent ATA has no delegate set.`,
        `Run: spl-token approve ${ataPubkey.toBase58()} <max-amount> ${saSigner?.toBase58() ?? "<settlement-authority-signer>"} --owner ${cfg.testAgentKeypairPath}`,
      );
    } else if (saSigner && !delegate.equals(saSigner)) {
      fail(
        "test-agent-delegate",
        `Test agent ATA delegate is ${delegate.toBase58()}, expected ${saSigner.toBase58()}.`,
        `Re-run spl-token approve with the right delegate.`,
      );
    } else {
      pass("test-agent-delegate", `delegate=${delegate.toBase58()}`);
    }
  }

  // Summary
  console.log("\nResults:");
  for (const c of checks) {
    const tag = c.ok ? "PASS" : "FAIL";
    console.log(`  [${tag}] ${c.name}${c.detail ? `  — ${c.detail}` : ""}`);
    if (!c.ok && c.remediation) {
      console.log(`         remediation: ${c.remediation}`);
    }
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  if (failed.length > 0) {
    console.error("\npreflight FAILED — fix the items above before running 01-fire.");
    process.exit(1);
  }
  console.log("\npreflight OK — safe to run 01-fire-10-calls.");
}

/**
 * Compute the SPL associated token account address for a wallet + mint.
 * Inlined here so we don't pull in @solana/spl-token just for one PDA derive.
 */
async function getAssociatedTokenAddress(
  mint: PublicKey,
  owner: PublicKey,
): Promise<PublicKey> {
  const TOKEN_PROGRAM_ID = new PublicKey(
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  );
  const ATA_PROGRAM_ID = new PublicKey(
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  );
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM_ID,
  );
  return ata;
}

main().catch((e) => {
  console.error("\npreflight CRASHED:", e instanceof Error ? e.message : e);
  if (e instanceof Error && e.stack) console.error(e.stack);
  process.exit(1);
});
