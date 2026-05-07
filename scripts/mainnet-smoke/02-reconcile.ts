/**
 * 02-reconcile.ts — verify on-chain settlements match what the indexer
 * recorded for the 10 calls fired in 01.
 *
 * Steps:
 *
 *   A) Per-endpoint pool reconciliation. For each of the 5 mainnet slugs:
 *      - Read on-chain `CoveragePool.current_balance` via getAccountInfo +
 *        decodeCoveragePool (commitment=`confirmed`).
 *      - Read indexer `GET /api/endpoints/:slug` -> `pool.currentBalanceLamports`.
 *      - Diff. They MUST match — the indexer is supposed to track on-chain
 *        balance exactly. (Unlike smoke-tier2, there's no seed amount to
 *        back out; mainnet pools were funded by real top_up_coverage_pool txs
 *        that the indexer also indexed.)
 *
 *   B) Treasury reconciliation:
 *      - Read on-chain Treasury USDC vault SPL Token balance.
 *      - Read indexer `GET /api/stats` -> treasury earned snapshot.
 *      - Diff. (Note: GET /api/stats reports lifetime earnings; reconciler
 *        prints both values so the operator can sanity-check, but failure
 *        is per-call/per-pool, not per-treasury — see README.)
 *
 *   C) Per-call reconciliation. For each callId we recorded in 01:
 *      - GET /api/calls/:id on the indexer.
 *      - Verify breach matches expectedOutcome (latency/server/network -> breach=true,
 *        ok -> breach=false).
 *      - Verify breachReason matches the expected classifier outcome string.
 *      - Verify endpointSlug matches.
 *
 * Exit codes:
 *   0 = every per-pool diff = 0 AND every per-call check passes.
 *   1 = anything mismatched. Prints a per-row breakdown so the operator can
 *       investigate without grepping logs.
 */
import axios from "axios";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  decodeCoveragePool,
  decodeTreasury,
  getCoveragePoolPda,
  getTreasuryPda,
} from "@pact-network/protocol-v1-client";
import { loadConfig, MAINNET_ENDPOINT_SLUGS } from "./lib/config";
import { patchState, readState, type CallOutcome } from "./lib/state";

interface PoolRow {
  slug: string;
  onchainBalance: bigint;
  indexerBalance: bigint;
  match: boolean;
}

interface CallCheckRow {
  callId: string;
  slug: string;
  expected: CallOutcome;
  found: boolean;
  indexerSlug: string | null;
  indexerBreach: boolean | null;
  indexerBreachReason: string | null;
  pass: boolean;
  reason?: string;
}

const EXPECTED_BREACH_REASON: Record<CallOutcome, string | null> = {
  ok: null,
  latency: "latency_breach",
  server_error: "server_error",
  network_error: "network_error",
};

async function reconcilePool(
  conn: Connection,
  programId: PublicKey,
  slug: string,
  indexerUrl: string,
): Promise<PoolRow> {
  const [poolPda] = getCoveragePoolPda(programId, slug);
  const acct = await conn.getAccountInfo(poolPda, "confirmed");
  if (!acct) {
    return {
      slug,
      onchainBalance: 0n,
      indexerBalance: 0n,
      match: false,
    };
  }
  const pool = decodeCoveragePool(acct.data);
  let indexerBalance = 0n;
  try {
    const r = await axios.get(`${indexerUrl}/api/endpoints/${slug}`, {
      timeout: 10_000,
    });
    const balStr = r.data?.pool?.currentBalanceLamports;
    indexerBalance = balStr ? BigInt(balStr) : 0n;
  } catch (e) {
    void e;
  }
  return {
    slug,
    onchainBalance: pool.currentBalance,
    indexerBalance,
    match: pool.currentBalance === indexerBalance,
  };
}

function decodeSplTokenAmount(data: Buffer | Uint8Array): bigint {
  const view = new DataView(
    data.buffer,
    "byteOffset" in data ? data.byteOffset : 0,
    data.byteLength,
  );
  return view.getBigUint64(64, true);
}

async function reconcileTreasury(
  conn: Connection,
  programId: PublicKey,
  indexerUrl: string,
): Promise<{ onchain: bigint; indexer: bigint }> {
  const [treasuryPda] = getTreasuryPda(programId);
  const tAcct = await conn.getAccountInfo(treasuryPda, "confirmed");
  if (!tAcct) return { onchain: 0n, indexer: 0n };
  const t = decodeTreasury(tAcct.data);
  const vaultAcct = await conn.getAccountInfo(
    new PublicKey(t.usdcVault),
    "confirmed",
  );
  const onchain = vaultAcct ? decodeSplTokenAmount(vaultAcct.data) : 0n;

  let indexer = 0n;
  try {
    const r = await axios.get(`${indexerUrl}/api/stats`, { timeout: 10_000 });
    // Stats response shape (per indexer/stats.service.ts): treasuryEarnedLamports
    // is a decimal string. Older builds use treasuryEarned. Try both.
    const data = r.data as Record<string, unknown>;
    const raw =
      (data["treasuryEarnedLamports"] as string | undefined) ??
      (data["treasuryEarned"] as string | undefined) ??
      "0";
    indexer = BigInt(raw);
  } catch (e) {
    void e;
  }
  return { onchain, indexer };
}

async function reconcileCall(
  callId: string,
  expected: CallOutcome,
  expectedSlug: string,
  indexerUrl: string,
): Promise<CallCheckRow> {
  if (!callId) {
    return {
      callId: "(missing)",
      slug: expectedSlug,
      expected,
      found: false,
      indexerSlug: null,
      indexerBreach: null,
      indexerBreachReason: null,
      pass: false,
      reason: "no callId returned by proxy (X-Pact-Call-Id header missing)",
    };
  }

  let resp;
  try {
    resp = await axios.get(`${indexerUrl}/api/calls/${callId}`, {
      timeout: 10_000,
      validateStatus: () => true,
    });
  } catch (e) {
    return {
      callId,
      slug: expectedSlug,
      expected,
      found: false,
      indexerSlug: null,
      indexerBreach: null,
      indexerBreachReason: null,
      pass: false,
      reason: `indexer fetch failed: ${(e as Error).message}`,
    };
  }
  if (resp.status === 404) {
    return {
      callId,
      slug: expectedSlug,
      expected,
      found: false,
      indexerSlug: null,
      indexerBreach: null,
      indexerBreachReason: null,
      pass: false,
      reason: "indexer 404 — settlement has not landed yet",
    };
  }
  if (resp.status !== 200) {
    return {
      callId,
      slug: expectedSlug,
      expected,
      found: false,
      indexerSlug: null,
      indexerBreach: null,
      indexerBreachReason: null,
      pass: false,
      reason: `indexer returned status=${resp.status}`,
    };
  }

  const data = resp.data as {
    callId: string;
    endpointSlug: string;
    breach: boolean;
    breachReason: string | null;
  };
  const expectedReason = EXPECTED_BREACH_REASON[expected];
  const expectedBreach = expectedReason !== null;

  const slugOk = data.endpointSlug === expectedSlug;
  const breachOk = data.breach === expectedBreach;
  const reasonOk =
    expectedReason === null
      ? data.breachReason === null
      : data.breachReason === expectedReason;
  const pass = slugOk && breachOk && reasonOk;

  return {
    callId,
    slug: expectedSlug,
    expected,
    found: true,
    indexerSlug: data.endpointSlug,
    indexerBreach: data.breach,
    indexerBreachReason: data.breachReason,
    pass,
    reason: pass
      ? undefined
      : `slug=${data.endpointSlug} breach=${data.breach} reason=${data.breachReason ?? "null"}`,
  };
}

async function main() {
  const cfg = loadConfig();
  const conn = new Connection(cfg.rpcUrl, "confirmed");
  const state = readState();

  console.log(`=== Pact Network mainnet smoke reconcile ===`);
  console.log(`  RPC:     ${cfg.rpcUrl}`);
  console.log(`  Indexer: ${cfg.indexerUrl}\n`);

  if (!state.calls || state.calls.length === 0) {
    throw new Error("No fired calls in state. Run 01-fire-10-calls first.");
  }

  // A) Per-pool recon
  const poolRows: PoolRow[] = [];
  for (const slug of MAINNET_ENDPOINT_SLUGS) {
    const row = await reconcilePool(conn, cfg.programId, slug, cfg.indexerUrl);
    poolRows.push(row);
  }

  console.log("Per-endpoint pool reconciliation:");
  console.log(
    "  slug      | onchain.bal     | indexer.bal     | match",
  );
  console.log(
    "  ----------+-----------------+-----------------+------",
  );
  let allPoolsMatch = true;
  for (const r of poolRows) {
    if (!r.match) allPoolsMatch = false;
    console.log(
      `  ${r.slug.padEnd(9)} | ${String(r.onchainBalance).padStart(15)} | ${String(r.indexerBalance).padStart(15)} | ${r.match ? "PASS" : "FAIL"}`,
    );
  }

  // B) Treasury recon (informational; not a hard fail)
  const t = await reconcileTreasury(conn, cfg.programId, cfg.indexerUrl);
  console.log(`\nTreasury reconciliation:`);
  console.log(`  on-chain treasury vault balance:  ${t.onchain}`);
  console.log(`  indexer treasury earned (cum.):   ${t.indexer}`);
  if (t.onchain !== t.indexer) {
    console.log(
      `  note: lifetime treasury vs indexer-cumulative may differ if any` +
        ` operator-side withdraw or fee-recipient rotation has happened. Investigate manually if delta > a few` +
        ` lamports.`,
    );
  }

  // C) Per-call recon
  console.log(`\nPer-call reconciliation (${state.calls.length} calls):`);
  const callRows: CallCheckRow[] = [];
  for (const c of state.calls) {
    const row = await reconcileCall(
      c.callId,
      c.expectedOutcome,
      c.slug,
      cfg.indexerUrl,
    );
    callRows.push(row);
    console.log(
      `  ${row.slug.padEnd(9)} ${row.expected.padEnd(14)} ${row.pass ? "PASS" : "FAIL"} ${row.callId.slice(0, 12)}` +
        (row.reason ? `  — ${row.reason}` : ""),
    );
  }

  const allCallsMatch = callRows.every((r) => r.pass);
  patchState({ reconciledAt: new Date().toISOString() });

  console.log("\n=========================================");
  console.log(`Pools:   ${allPoolsMatch ? "PASS" : "FAIL"}`);
  console.log(`Calls:   ${allCallsMatch ? "PASS" : "FAIL"}`);
  console.log(`Overall: ${allPoolsMatch && allCallsMatch ? "PASS" : "FAIL"}`);

  if (!allPoolsMatch || !allCallsMatch) process.exit(1);
}

main().catch((e) => {
  console.error("\nRECONCILE FAILED:", e instanceof Error ? e.message : e);
  if (e instanceof Error && e.stack) console.error(e.stack);
  process.exit(1);
});
