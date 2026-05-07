/**
 * Manual deadlock-repro harness for B11 + B12.
 *
 * Why it's not a `*.spec.ts`: Prisma's deadlock + FK semantics need a real
 * Postgres — they will not surface against the in-memory mock used by
 * events.service.spec.ts. CI doesn't have PG wired up yet, so this is a
 * standalone tsx script. Future test infra can lift it into a proper
 * integration suite.
 *
 * Usage:
 *
 *   # 1. Start a throwaway Postgres.
 *   docker run -d --rm --name pact-deadlock-pg \
 *     -p 5434:5432 -e POSTGRES_PASSWORD=pact -e POSTGRES_DB=pact \
 *     postgres:16-alpine
 *
 *   # 2. Apply migrations.
 *   PG_URL="postgres://postgres:pact@localhost:5434/pact" \
 *     pnpm --filter @pact-network/db db:migrate
 *
 *   # 3. Run the harness.
 *   PG_URL="postgres://postgres:pact@localhost:5434/pact" \
 *     pnpm tsx packages/indexer/test/deadlock-repro.ts
 *
 *   # 4. Tear down.
 *   docker rm -f pact-deadlock-pg
 *
 * Expected output (post-fix):
 *
 *   [B11] brand-new agent ingest: OK (accepted=1)
 *   [B12] concurrent shared-agent ingest: OK (no deadlock)
 *
 * If either prints a stack trace mentioning `Foreign key constraint violated`
 * (B11) or `40P01` / `deadlock detected` (B12), the regression is back.
 */

import { PrismaClient } from "@pact-network/db";
import { EventsService } from "../src/events/events.service";
import { PrismaService } from "../src/prisma/prisma.service";
import type { SettlementEventDto } from "../src/events/events.dto";

function nowIso(): string {
  return new Date().toISOString();
}

function makeDto(opts: {
  signature: string;
  callId: string;
  agentPubkey: string;
  endpointSlug: string;
}): SettlementEventDto {
  return {
    signature: opts.signature,
    batchSize: 1,
    totalPremiumsLamports: "1000",
    totalRefundsLamports: "0",
    ts: nowIso(),
    calls: [
      {
        callId: opts.callId,
        agentPubkey: opts.agentPubkey,
        endpointSlug: opts.endpointSlug,
        premiumLamports: "1000",
        refundLamports: "0",
        latencyMs: 100,
        outcome: "ok",
        ts: nowIso(),
        settledAt: nowIso(),
        signature: opts.signature,
        shares: [],
      },
    ],
  };
}

async function main() {
  const prisma = new PrismaClient() as unknown as PrismaService;
  const svc = new EventsService(prisma);

  // Wipe any prior harness data so we have a true green DB.
  await (prisma as unknown as PrismaClient).$transaction([
    (prisma as unknown as PrismaClient).poolState.deleteMany({}),
    (prisma as unknown as PrismaClient).settlementRecipientShare.deleteMany({}),
    (prisma as unknown as PrismaClient).settlement.deleteMany({}),
    (prisma as unknown as PrismaClient).call.deleteMany({}),
    (prisma as unknown as PrismaClient).recipientEarnings.deleteMany({}),
    (prisma as unknown as PrismaClient).agent.deleteMany({}),
    (prisma as unknown as PrismaClient).endpoint.deleteMany({}),
  ]);

  // === B11 ===
  // Brand-new agent + endpoint, no pre-seed. Pre-fix: 500 with
  // `Foreign key constraint violated: Call_agentPubkey_fkey`.
  const b11 = await svc.ingest(
    makeDto({
      signature: "harness-b11",
      callId: "b11-call-1",
      agentPubkey: "B11Agent111111111111111111111111111111111111",
      endpointSlug: "b11-ep",
    }),
  );
  console.log(`[B11] brand-new agent ingest: OK (accepted=${b11.accepted})`);

  // === B12 ===
  // Two concurrent ingests sharing one agent and one endpoint. Pre-fix this
  // deadlocks with PG error 40P01. Post-fix the deterministic lock order
  // serializes them — both succeed.
  const sharedAgent = "B12SharedAgent11111111111111111111111111111";
  const sharedEp = "b12-shared-ep";
  // Make sure both ingests actually contend on the same Agent/Endpoint
  // rows by including BOTH in each batch (in opposite order on each side
  // to maximize the pre-fix deadlock probability).
  const dtoA: SettlementEventDto = {
    signature: "harness-b12-A",
    batchSize: 2,
    totalPremiumsLamports: "2000",
    totalRefundsLamports: "0",
    ts: nowIso(),
    calls: [
      {
        callId: "b12-A-1",
        agentPubkey: sharedAgent,
        endpointSlug: sharedEp,
        premiumLamports: "1000",
        refundLamports: "0",
        latencyMs: 100,
        outcome: "ok",
        ts: nowIso(),
        settledAt: nowIso(),
        signature: "harness-b12-A",
        shares: [],
      },
      {
        callId: "b12-A-2",
        agentPubkey: "B12OtherAgent11111111111111111111111111111111",
        endpointSlug: "b12-other-ep",
        premiumLamports: "1000",
        refundLamports: "0",
        latencyMs: 100,
        outcome: "ok",
        ts: nowIso(),
        settledAt: nowIso(),
        signature: "harness-b12-A",
        shares: [],
      },
    ],
  };
  const dtoB: SettlementEventDto = {
    signature: "harness-b12-B",
    batchSize: 2,
    totalPremiumsLamports: "2000",
    totalRefundsLamports: "0",
    ts: nowIso(),
    calls: [
      // Same agent + endpoint as A but listed first to invert order — this
      // is what historically tripped the pre-fix deadlock.
      {
        callId: "b12-B-1",
        agentPubkey: "B12OtherAgent11111111111111111111111111111111",
        endpointSlug: "b12-other-ep",
        premiumLamports: "1000",
        refundLamports: "0",
        latencyMs: 100,
        outcome: "ok",
        ts: nowIso(),
        settledAt: nowIso(),
        signature: "harness-b12-B",
        shares: [],
      },
      {
        callId: "b12-B-2",
        agentPubkey: sharedAgent,
        endpointSlug: sharedEp,
        premiumLamports: "1000",
        refundLamports: "0",
        latencyMs: 100,
        outcome: "ok",
        ts: nowIso(),
        settledAt: nowIso(),
        signature: "harness-b12-B",
        shares: [],
      },
    ],
  };

  const [resA, resB] = await Promise.all([svc.ingest(dtoA), svc.ingest(dtoB)]);
  if (resA.accepted !== 2 || resB.accepted !== 2) {
    throw new Error(
      `[B12] expected accepted=2 on both, got A=${resA.accepted} B=${resB.accepted}`,
    );
  }
  console.log("[B12] concurrent shared-agent ingest: OK (no deadlock)");

  await (prisma as unknown as PrismaClient).$disconnect();
}

main().catch((err) => {
  console.error("HARNESS FAILED:", err);
  process.exit(1);
});
