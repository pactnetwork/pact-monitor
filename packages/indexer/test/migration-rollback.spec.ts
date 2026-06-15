/**
 * WP-MN-03a T3: migration-rollback.spec.ts
 *
 * CI test for composite PK + backfill behavior introduced by the
 * 20260520000000_add_network_column migration.
 *
 * Requires DATABASE_URL / PG_URL pointing to a Postgres test DB with all
 * three migrations applied (CI provides this; locally use the docker-compose
 * postgres started by `docker compose -f docker-compose.dev.yml up -d`).
 *
 * Each test is self-contained: it inserts rows, asserts, then cleans up.
 * Tests do NOT depend on each other's data.
 */

import { PrismaClient } from "@pact-network/db";

// Minimal Endpoint fixture — all required fields.
function endpointFixture(network: string, slug: string) {
  return {
    network,
    slug,
    flatPremiumLamports: BigInt(1000),
    percentBps: 50,
    slaLatencyMs: 5000,
    imputedCostLamports: BigInt(5000),
    exposureCapPerHourLamports: BigInt(1_000_000),
    paused: false,
    upstreamBase: "https://example.com",
    displayName: "Test Endpoint",
    registeredAt: new Date(),
    lastUpdated: new Date(),
  };
}

// Minimal Agent fixture.
function agentFixture(pubkey: string) {
  return {
    pubkey,
    createdAt: new Date(),
  };
}

// Minimal Call fixture referencing (network, endpointSlug) and agentPubkey.
function callFixture(
  network: string,
  callId: string,
  agentPubkey: string,
  endpointSlug: string,
) {
  return {
    network,
    callId,
    agentPubkey,
    endpointSlug,
    premiumLamports: BigInt(1000),
    refundLamports: BigInt(0),
    latencyMs: 100,
    breach: false,
    ts: new Date(),
    settledAt: new Date(),
    signature: "sig" + callId,
  };
}

describe("WP-MN-03a migration — composite PK + backfill behavior", () => {
  const prisma = new PrismaClient({
    datasources: {
      db: {
        url:
          process.env.PG_URL ??
          process.env.DATABASE_URL ??
          "postgresql://pact:pact@localhost:5433/pact",
      },
    },
  });

  // Seed constants — use unique prefixes to avoid cross-test collisions.
  const AGENT_PK = "TestAgent11111111111111111111111111111111111";
  const AGENT_PK2 = "TestAgent22222222222222222222222222222222222";

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("composite PK prevents same-callId duplicate within solana-devnet", async () => {
    const network = "solana-devnet";
    const slug = "test-dup-ep";
    const callId = "dup-call-id-001";

    // Setup: create prerequisite Endpoint + Agent.
    await prisma.endpoint.upsert({
      where: { network_slug: { network, slug } },
      create: endpointFixture(network, slug),
      update: {},
    });
    await prisma.agent.upsert({
      where: { pubkey: AGENT_PK },
      create: agentFixture(AGENT_PK),
      update: {},
    });

    // First insert — should succeed.
    await prisma.call.create({ data: callFixture(network, callId, AGENT_PK, slug) });

    // Second insert with same (network, callId) — must throw P2002.
    let threwP2002 = false;
    try {
      await prisma.call.create({ data: callFixture(network, callId, AGENT_PK, slug) });
    } catch (e: any) {
      if (e?.code === "P2002") threwP2002 = true;
      else throw e;
    }
    expect(threwP2002).toBe(true);

    // Cleanup.
    await prisma.call.delete({ where: { network_callId: { network, callId } } });
    await prisma.endpoint.delete({ where: { network_slug: { network, slug } } });
  });

  it("composite PK allows same callId across different networks", async () => {
    const slugA = "test-xnet-ep-a";
    const slugB = "test-xnet-ep-b";
    const callId = "shared-call-001";
    const netA = "solana-devnet";
    const netB = "arc-testnet";

    // Setup: create Endpoint on both networks and an Agent.
    await prisma.endpoint.upsert({
      where: { network_slug: { network: netA, slug: slugA } },
      create: endpointFixture(netA, slugA),
      update: {},
    });
    await prisma.endpoint.upsert({
      where: { network_slug: { network: netB, slug: slugB } },
      create: endpointFixture(netB, slugB),
      update: {},
    });
    await prisma.agent.upsert({
      where: { pubkey: AGENT_PK2 },
      create: agentFixture(AGENT_PK2),
      update: {},
    });

    // Insert same callId on both networks — both must succeed.
    await prisma.call.create({
      data: callFixture(netA, callId, AGENT_PK2, slugA),
    });
    await prisma.call.create({
      data: callFixture(netB, callId, AGENT_PK2, slugB),
    });

    // Verify both rows exist.
    const rows = await prisma.call.findMany({
      where: { callId },
    });
    expect(rows).toHaveLength(2);
    const networks = rows.map((r) => r.network).sort();
    expect(networks).toEqual([netB, netA].sort());

    // Cleanup.
    await prisma.call.delete({ where: { network_callId: { network: netA, callId } } });
    await prisma.call.delete({ where: { network_callId: { network: netB, callId } } });
    await prisma.endpoint.delete({ where: { network_slug: { network: netA, slug: slugA } } });
    await prisma.endpoint.delete({ where: { network_slug: { network: netB, slug: slugB } } });
  });

  it("foreign keys updated to composite — Call.endpoint references (network, slug)", async () => {
    const slug = "test-fk-ep";
    const netGood = "solana-devnet";
    const netBad = "arc-testnet";
    const callId = "fk-call-001";

    // Create Endpoint only on netGood.
    await prisma.endpoint.upsert({
      where: { network_slug: { network: netGood, slug } },
      create: endpointFixture(netGood, slug),
      update: {},
    });
    await prisma.agent.upsert({
      where: { pubkey: AGENT_PK },
      create: agentFixture(AGENT_PK),
      update: {},
    });

    // Inserting a Call with (network=netBad, endpointSlug=slug) must fail FK
    // because Endpoint (arc-testnet, test-fk-ep) does NOT exist.
    let threwFk = false;
    try {
      await prisma.call.create({
        data: callFixture(netBad, callId, AGENT_PK, slug),
      });
    } catch (e: any) {
      // P2003 = FK constraint violation; P2002 would be PK — we expect P2003.
      if (e?.code === "P2003") threwFk = true;
      else throw e;
    }
    expect(threwFk).toBe(true);

    // Cleanup.
    await prisma.endpoint.delete({ where: { network_slug: { network: netGood, slug } } });
  });

  it("default network='solana-devnet' applies to insert without explicit network", async () => {
    const slug = "test-default-ep";
    const callId = "default-net-call-001";

    // Create Endpoint WITHOUT specifying network — relies on DB default.
    // Prisma requires all non-nullable fields in create, but network has a
    // @default in the schema, so Prisma omits it from the required fields.
    // We must explicitly pass it since the Prisma generated type for @@id
    // compound keys requires network. Use the explicit default value.
    const network = "solana-devnet";

    await prisma.endpoint.upsert({
      where: { network_slug: { network, slug } },
      create: endpointFixture(network, slug),
      update: {},
    });
    await prisma.agent.upsert({
      where: { pubkey: AGENT_PK },
      create: agentFixture(AGENT_PK),
      update: {},
    });

    // Create Call without specifying network — Prisma uses the schema @default.
    const { network: network_key, ...fixtureWithoutNetwork } = callFixture(
      network,
      callId,
      AGENT_PK,
      slug,
    );
    // Prisma create for a composite-PK model where network has @default
    // should accept the object without network.
    // TypeScript will flag this — we cast to any to test the DB-default path.
    const created = await (prisma.call.create as any)({
      data: fixtureWithoutNetwork,
    });

    // The row read back should have network='solana-devnet' applied by Postgres.
    const row = await prisma.call.findUnique({
      where: { network_callId: { network, callId } },
    });
    expect(row).not.toBeNull();
    expect(row!.network).toBe("solana-devnet");

    // Cleanup.
    await prisma.call.delete({ where: { network_callId: { network, callId } } });
    await prisma.endpoint.delete({ where: { network_slug: { network, slug } } });
  });
});
