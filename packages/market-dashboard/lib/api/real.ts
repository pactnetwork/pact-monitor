/**
 * Real data layer — fetches from the Pact Network indexer's public read API.
 *
 * Activated by `lib/api/index.ts` whenever `NEXT_PUBLIC_INDEXER_URL` is set.
 * Each function below is the production sibling of the same export in `mock.ts`
 * and maps the indexer's wire shape onto the dashboard's `lib/api/types.ts`.
 *
 * Indexer routes consumed (see `packages/indexer/src/...`):
 *
 *   GET /api/stats                        -> stats.service NetworkStats
 *   GET /api/endpoints                    -> Prisma Endpoint[]
 *   GET /api/endpoints/:slug              -> Prisma Endpoint
 *   GET /api/agents/:pubkey               -> Prisma Agent
 *   GET /api/agents/:pubkey/calls?limit=N -> Prisma Call[]
 *   GET /api/calls/:id                    -> Prisma Call
 *
 * All routes are public reads on the indexer. No auth headers.
 *
 * Wire-shape gaps (vs the mock contract) and how we close them:
 *
 * - The indexer does NOT expose a global `/api/calls?limit=N` listing — there
 *   is no recent-calls firehose route on develop. `fetchCalls()` therefore
 *   returns an empty array against the real indexer; the homepage renders
 *   without crashing but shows no recent events. Tracking issue: B-followup.
 *
 * - Per-endpoint live aggregates (`calls24h`, `failures24h`, `avgLatencyMs`,
 *   `poolBalance`, `feeRecipients`, `poolRetainedBps`) are not currently
 *   served by `GET /api/endpoints`. We surface zeros / empty splits so the
 *   page renders; backfill comes when the indexer joins PoolState +
 *   RecipientEarnings into the endpoint payload (Step D follow-up).
 *
 * - `fetchCall(id)` cannot enumerate `recipientShares` from the indexer's
 *   single-call route today — that data lives on the joined Settlement row.
 *   Returned as `undefined` until the indexer materialises the breakdown.
 */

import type {
  Stats,
  CallEvent,
  Endpoint,
  AgentHistory,
  RecipientEarnings,
} from "./types";

/**
 * Resolve the indexer base URL at call time. Each fetcher checks this — if it
 * is unset we throw, since `lib/api/index.ts` only routes to this module after
 * confirming the env is set. Re-checking here makes the failure mode loud
 * during local debugging.
 */
function indexerBase(): string {
  const url = process.env.NEXT_PUBLIC_INDEXER_URL;
  if (!url) {
    throw new Error(
      "NEXT_PUBLIC_INDEXER_URL is not set — lib/api/real.ts called without an indexer URL"
    );
  }
  return url.replace(/\/+$/, "");
}

/** GET helper. Throws on non-2xx. Server-side and client-side compatible. */
async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${indexerBase()}${path}`, {
    // SSR: don't cache aggressively — the indexer already owns a 5s cache.
    // Client side: same. Next.js re-validates per the page's `revalidate`.
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(
      `indexer ${path} returned ${res.status} ${res.statusText}`
    );
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Wire types (mirror the indexer responses; intentionally strings for BigInt
// because Prisma serialises BigInt as string and `NetworkStats` does the same).
// ---------------------------------------------------------------------------

interface IndexerNetworkStats {
  totalPools: number;
  totalCoverageLamports: string;
  totalPremiumsCollected: string;
  totalRefundsPaid: string;
  totalTreasuryEarned: string;
  topIntegrators: Array<{
    recipientPubkey: string;
    recipientKind: number;
    lifetimeEarnedLamports: string;
  }>;
  totalCalls: number;
  totalBreaches: number;
  totalPremiumsLamports: string;
  totalRefundsLamports: string;
  breachRateBps: number;
  poolBalanceLamports: string;
  totalDepositsLamports: string;
  endpointCount: number;
  agentCount: number;
  updatedAt: string;
}

interface IndexerEndpoint {
  slug: string;
  flatPremiumLamports: string;
  percentBps: number;
  slaLatencyMs: number;
  imputedCostLamports: string;
  exposureCapPerHourLamports: string;
  paused: boolean;
  upstreamBase: string;
  displayName: string;
  logoUrl: string | null;
  registeredAt: string;
  lastUpdated: string;
}

interface IndexerAgent {
  pubkey: string;
  displayName: string | null;
  totalPremiumsLamports: string;
  totalRefundsLamports: string;
  callCount: string;
  lastCallAt: string | null;
  createdAt: string;
}

interface IndexerCall {
  callId: string;
  agentPubkey: string;
  endpointSlug: string;
  premiumLamports: string;
  refundLamports: string;
  latencyMs: number;
  breach: boolean;
  breachReason: string | null;
  source: string | null;
  ts: string;
  settledAt: string;
  signature: string;
}

// ---------------------------------------------------------------------------
// Mappers — wire shape -> dashboard types.
// ---------------------------------------------------------------------------

/** FeeRecipientKind enum (mirrors the on-chain encoding). */
function recipientKindToString(
  kind: number
): "treasury" | "affiliate_ata" | "affiliate_pda" {
  if (kind === 0) return "treasury";
  if (kind === 1) return "affiliate_ata";
  if (kind === 2) return "affiliate_pda";
  // Unknown future kinds — render as affiliate_ata so the table doesn't crash.
  return "affiliate_ata";
}

/** Parse a BigInt-as-string field into a JS number. */
function bigIntStrToNumber(value: string | undefined | null): number {
  if (!value) return 0;
  // Number coercion — fine for current USDC base-unit volumes (well under 2^53).
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function mapStats(wire: IndexerNetworkStats): Stats {
  const topRecipients: RecipientEarnings[] = wire.topIntegrators.map((r) => ({
    destination: r.recipientPubkey,
    kind: recipientKindToString(r.recipientKind),
    label:
      r.recipientKind === 0
        ? "Treasury"
        : `Integrator ${r.recipientPubkey.slice(0, 4)}…${r.recipientPubkey.slice(-4)}`,
    totalEarned: bigIntStrToNumber(r.lifetimeEarnedLamports),
  }));

  return {
    totalPremiums: bigIntStrToNumber(wire.totalPremiumsCollected),
    totalRefunds: bigIntStrToNumber(wire.totalRefundsPaid),
    callsInsured: wire.totalCalls,
    poolBalanceAggregate: bigIntStrToNumber(wire.totalCoverageLamports),
    treasuryEarned: bigIntStrToNumber(wire.totalTreasuryEarned),
    activeEndpoints: wire.endpointCount,
    activeAgents: wire.agentCount,
    topRecipients,
  };
}

function mapEndpoint(wire: IndexerEndpoint): Endpoint {
  // The indexer does not currently fold per-endpoint PoolState aggregates
  // (calls24h, poolBalance, feeRecipients) into this payload. Emit zeros and
  // empty splits so the page renders; the dashboard's Endpoints table tolerates
  // missing values gracefully.
  return {
    id: wire.slug,
    slug: wire.slug,
    url: wire.upstreamBase,
    name: wire.displayName,
    flatFee: bigIntStrToNumber(wire.flatPremiumLamports),
    percentFee: wire.percentBps,
    slaMs: wire.slaLatencyMs,
    calls24h: 0,
    failures24h: 0,
    failureRate24h: 0,
    avgLatencyMs: 0,
    totalPremiums: 0,
    totalRefunds: 0,
    poolBalance: 0,
    feeRecipients: [],
    poolRetainedBps: 10_000,
    isActive: !wire.paused,
  };
}

function mapCall(wire: IndexerCall, endpointName?: string): CallEvent {
  const status: CallEvent["status"] = !wire.breach
    ? "ok"
    : wire.breachReason === "timeout"
      ? "timeout"
      : "error";
  return {
    id: wire.callId,
    agentPubkey: wire.agentPubkey,
    endpointSlug: wire.endpointSlug,
    endpointName: endpointName ?? wire.endpointSlug,
    premium: bigIntStrToNumber(wire.premiumLamports),
    refund: bigIntStrToNumber(wire.refundLamports),
    latencyMs: wire.latencyMs,
    status,
    // recipientShares + poolRetained are not surfaced by the per-call route
    // yet — left undefined so the SettlementSplit table is hidden.
    ts: wire.ts,
  };
}

// ---------------------------------------------------------------------------
// Public surface — same exports as `./mock`.
// ---------------------------------------------------------------------------

export async function fetchStats(): Promise<Stats> {
  const wire = await getJson<IndexerNetworkStats>("/api/stats");
  return mapStats(wire);
}

export async function fetchCalls(_limit = 50): Promise<CallEvent[]> {
  // Indexer does not currently expose a global recent-calls firehose route.
  // Returning [] keeps the homepage from crashing; the "Recent Events" table
  // simply renders empty until the route lands.
  return [];
}

export async function fetchCall(id: string): Promise<CallEvent | null> {
  try {
    const wire = await getJson<IndexerCall>(`/api/calls/${encodeURIComponent(id)}`);
    return mapCall(wire);
  } catch {
    return null;
  }
}

export async function fetchEndpoints(): Promise<Endpoint[]> {
  const wire = await getJson<IndexerEndpoint[]>("/api/endpoints");
  return wire.map(mapEndpoint);
}

export async function fetchAgent(pubkey: string): Promise<AgentHistory> {
  // Two queries: the agent row + a slice of recent calls.
  let agentRow: IndexerAgent | null = null;
  let callRows: IndexerCall[] = [];

  try {
    agentRow = await getJson<IndexerAgent>(
      `/api/agents/${encodeURIComponent(pubkey)}`
    );
  } catch {
    // Agent not yet seen by the indexer — fall through with totals == 0 so the
    // page renders the same "neutral / loading" snapshot the mock returns.
  }

  try {
    callRows = await getJson<IndexerCall[]>(
      `/api/agents/${encodeURIComponent(pubkey)}/calls?limit=20`
    );
  } catch {
    callRows = [];
  }

  return {
    agent: {
      pubkey,
      // On-chain insurable state (balance + allowance) is read by the client
      // hook; SSR returns zeros + neutral reason so the panel renders neutral
      // until the client poll lands. Mirrors the mock fetchAgent contract.
      ataBalance: 0,
      allowance: 0,
      eligible: false,
      reason: "loading",
      totalPremiumsPaid: bigIntStrToNumber(agentRow?.totalPremiumsLamports),
      totalRefundsReceived: bigIntStrToNumber(agentRow?.totalRefundsLamports),
      callCount: bigIntStrToNumber(agentRow?.callCount),
      lastActivity: agentRow?.lastCallAt ?? null,
    },
    recentCalls: callRows.map((c) => mapCall(c)),
  };
}
