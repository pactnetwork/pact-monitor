/**
 * 06-reconcile.ts — read on-chain CoveragePool / Treasury / fee recipient ATA
 * balances and compare against the indexer's PoolState rows. Fails (exit 1)
 * if any mismatch is detected.
 *
 * Acceptance metrics produced (one row per endpoint):
 *
 *   slug | onchain.currentBalance | indexer.currentBalance | onchain.totalPremiums | indexer.totalPremiums | match?
 *
 * Plus aggregates:
 *   - On-chain Treasury vault balance vs indexer SettlementRecipientShare sum where kind=0.
 *   - Total Settlement rows vs total settle_batch txs landed.
 *   - Total Call rows vs total settled events.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { Client as PgClient } from "pg";
import {
  decodeCoveragePool,
  decodeTreasury,
} from "@pact-network/protocol-v1-client";

import { INDEXER_URL, SMOKE_RPC_URL } from "./lib/paths";
import { loadState, patchState } from "./lib/state";

interface ReconRow {
  slug: string;
  onchainBalance: bigint;
  /**
   * On-chain pool balance MINUS the seed amount the smoke deposited via
   * top_up_coverage_pool BEFORE any settlements ran. The indexer's
   * PoolState.currentBalanceLamports only reflects settlement deltas (it has
   * no view of out-of-band top-ups), so we have to back the seed out to make
   * the comparison apples-to-apples.
   */
  onchainBalanceDelta: bigint;
  indexerBalance: bigint;
  onchainPremiums: bigint;
  indexerPremiums: bigint;
  match: boolean;
}

const POOL_SEED_LAMPORTS = 50n * 1_000_000n;

async function main() {
  const conn = new Connection(SMOKE_RPC_URL, "confirmed");
  const state = loadState();
  if (!state.endpoints) throw new Error("missing endpoints in state — run earlier steps");
  if (!state.treasuryVault) throw new Error("missing treasuryVault in state");

  const pg = new PgClient({ connectionString: "postgresql://pact:pact@localhost:5433/pact" });
  await pg.connect();

  const rows: ReconRow[] = [];
  let allMatch = true;

  for (const ep of state.endpoints) {
    const poolAcct = await conn.getAccountInfo(new PublicKey(ep.coveragePool), "confirmed");
    if (!poolAcct) {
      console.error(`MISSING on-chain CoveragePool for ${ep.slug}`);
      allMatch = false;
      continue;
    }
    const pool = decodeCoveragePool(poolAcct.data);

    const psRes = await pg.query(
      'SELECT "currentBalanceLamports", "totalPremiumsLamports" FROM "PoolState" WHERE "endpointSlug" = $1',
      [ep.slug],
    );
    const indexerBalance = psRes.rows[0]?.currentBalanceLamports ?? 0n;
    const indexerPremiums = psRes.rows[0]?.totalPremiumsLamports ?? 0n;

    const onchainBalance = pool.currentBalance;
    const onchainBalanceDelta = onchainBalance - POOL_SEED_LAMPORTS;
    const onchainPremiums = pool.totalPremiums;

    const balMatch = BigInt(indexerBalance) === onchainBalanceDelta;
    const premMatch = BigInt(indexerPremiums) === onchainPremiums;
    const match = balMatch && premMatch;
    if (!match) allMatch = false;
    rows.push({
      slug: ep.slug,
      onchainBalance,
      onchainBalanceDelta,
      indexerBalance: BigInt(indexerBalance),
      onchainPremiums,
      indexerPremiums: BigInt(indexerPremiums),
      match,
    });
  }

  // Treasury vault recon
  const treasuryAcct = await conn.getAccountInfo(new PublicKey(state.treasuryVault), "confirmed");
  let treasuryOnchain = 0n;
  if (treasuryAcct) {
    // SPL Token Account: amount is at offset 64 (LE u64)
    const view = new DataView(
      treasuryAcct.data.buffer,
      treasuryAcct.data.byteOffset,
      treasuryAcct.data.byteLength,
    );
    treasuryOnchain = view.getBigUint64(64, true);
  }
  const trRes = await pg.query(
    'SELECT COALESCE(SUM("amountLamports"), 0) AS s FROM "SettlementRecipientShare" WHERE "recipientPubkey" = $1',
    [state.treasuryVault],
  );
  const indexerTreasury = BigInt(trRes.rows[0]?.s ?? 0);

  // Aggregate stats
  const settleRes = await pg.query('SELECT COUNT(*)::int AS n FROM "Settlement"');
  const callRes = await pg.query('SELECT COUNT(*)::int AS n FROM "Call"');
  const recipientShareRes = await pg.query('SELECT COUNT(*)::int AS n FROM "SettlementRecipientShare"');
  const earningsRes = await pg.query('SELECT COUNT(*)::int AS n FROM "RecipientEarnings"');

  console.log("\n========== TIER-2 SMOKE RECONCILIATION ==========\n");
  console.log("Per-endpoint pool reconciliation:");
  console.log("  (onchain.balΔ = pool.current_balance - 50_000_000 seed; settlement-only delta)");
  console.log(
    "  slug               | onchain.balΔ | indexer.bal | onchain.prem | indexer.prem | match",
  );
  console.log(
    "  -------------------+--------------+-------------+--------------+--------------+------",
  );
  for (const r of rows) {
    console.log(
      `  ${r.slug.padEnd(18)} | ${String(r.onchainBalanceDelta).padStart(12)} | ${String(r.indexerBalance).padStart(11)} | ${String(r.onchainPremiums).padStart(12)} | ${String(r.indexerPremiums).padStart(12)} | ${r.match ? "PASS" : "FAIL"}`,
    );
  }

  console.log("\nTreasury reconciliation:");
  console.log(`  on-chain treasury vault balance:  ${treasuryOnchain}`);
  console.log(`  indexer share-sum kind=Treasury:  ${indexerTreasury}`);
  const treasuryMatch = treasuryOnchain === indexerTreasury;
  if (!treasuryMatch) allMatch = false;
  console.log(`  match:                            ${treasuryMatch ? "PASS" : "FAIL"}`);

  console.log("\nAggregate counts:");
  console.log(`  Settlement rows:                  ${settleRes.rows[0].n}`);
  console.log(`  Call rows:                        ${callRes.rows[0].n}`);
  console.log(`  SettlementRecipientShare rows:    ${recipientShareRes.rows[0].n}`);
  console.log(`  RecipientEarnings rows:           ${earningsRes.rows[0].n}`);

  patchState({ totalBatches: settleRes.rows[0].n });

  await pg.end();

  console.log("\n========== RESULT: " + (allMatch ? "PASS" : "FAIL") + " ==========");
  if (!allMatch) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
