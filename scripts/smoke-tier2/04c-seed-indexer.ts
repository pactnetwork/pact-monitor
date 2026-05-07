/**
 * 04c-seed-indexer.ts — pre-seed Endpoint + Agent rows in the indexer DB.
 *
 * The indexer's `EventsService.ingest` requires `Endpoint` and `Agent` rows to
 * exist before a `Call` row can be inserted (Call.agentPubkey → Agent FK +
 * Call.endpointSlug → Endpoint FK). Production seeds these via a backfill /
 * webhook / manual ops endpoint. The smoke harness owns its own data, so we
 * insert them here from the on-chain state captured by 02-init-protocol.ts.
 *
 * IMPORTANT: This is a B11 finding — the indexer's `events.service.ts` will
 * 500 every settle batch with `Call_agentPubkey_fkey violated` if endpoints /
 * agents are not pre-seeded. Either:
 *   (a) the indexer should auto-create Agent rows in `tryInsertCall` (it
 *       currently only upserts Agent counters AFTER the call insert), or
 *   (b) the settler should push an Agent / Endpoint registration event before
 *       its first Call.
 *
 * Documented in the smoke run report.
 */
import { Client as PgClient } from "pg";
import { ENDPOINTS } from "./lib/paths";
import { loadState } from "./lib/state";

async function main() {
  const state = loadState();
  if (!state.endpoints || !state.agents) {
    throw new Error("missing state — run 02 + 03 first");
  }

  const pg = new PgClient({ connectionString: "postgresql://pact:pact@localhost:5433/pact" });
  await pg.connect();

  const now = new Date();

  // Endpoints
  for (const ep of ENDPOINTS) {
    await pg.query(
      `INSERT INTO "Endpoint" (
        "slug",
        "flatPremiumLamports", "percentBps", "slaLatencyMs",
        "imputedCostLamports", "exposureCapPerHourLamports",
        "paused", "upstreamBase", "displayName",
        "registeredAt", "lastUpdated"
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT ("slug") DO NOTHING`,
      [
        ep.slug,
        Number(ep.flatPremium),
        ep.percentBps,
        ep.sla,
        10_000,
        100_000_000,
        false,
        `https://smoke-${ep.slug}.test`,
        ep.slug,
        now,
        now,
      ],
    );
  }

  // Agents
  for (const agent of state.agents) {
    await pg.query(
      `INSERT INTO "Agent" (
        "pubkey", "displayName",
        "totalPremiumsLamports", "totalRefundsLamports",
        "callCount", "createdAt"
      ) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT ("pubkey") DO NOTHING`,
      [agent.pubkey, `smoke-agent-${agent.index}`, 0, 0, 0, now],
    );
  }

  // Sanity
  const epCount = (await pg.query('SELECT COUNT(*)::int AS n FROM "Endpoint"')).rows[0].n;
  const agentCount = (await pg.query('SELECT COUNT(*)::int AS n FROM "Agent"')).rows[0].n;
  console.log(`Seeded ${epCount} endpoint rows + ${agentCount} agent rows`);

  await pg.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
