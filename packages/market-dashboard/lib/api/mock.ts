/**
 * Mock data layer for the dashboard.
 *
 * Each function below corresponds 1:1 with an indexer endpoint that the Step D
 * #59 work is wiring up. See MOCK_API.md for the swap targets.
 */
import type {
  Stats,
  CallEvent,
  Endpoint,
  AgentHistory,
  FeeRecipientSummary,
  RecipientEarnings,
  SettlementRecipientShare,
} from "./types";

const AGENTS = [
  "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
  "3h1zGmCwsRf4HRDiZzqHQDuZHyJxeRpW4oKwYt5nV6pE",
  "GqnohFahAX5EMmxNbTxAFPJBvnkVnL7W8tNiD3Zx2PKa",
];

const TREASURY_VAULT = "TreasuryVau1tMockBase58000000000000000000000";
const HELIUS_AFFILIATE = "AffH3liusM0ckATAxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const JUPITER_AFFILIATE = "AffJupiterM0ckATAxxxxxxxxxxxxxxxxxxxxxxxxxx";

function feeRecipientSummary(
  treasuryBps: number,
  affiliate?: { destination: string; bps: number; label: string }
): { fees: FeeRecipientSummary[]; retainedBps: number } {
  const fees: FeeRecipientSummary[] = [
    {
      kind: "treasury",
      destination: TREASURY_VAULT,
      bps: treasuryBps,
      label: `Treasury ${(treasuryBps / 100).toFixed(0)}%`,
    },
  ];
  if (affiliate) {
    fees.push({
      kind: "affiliate_ata",
      destination: affiliate.destination,
      bps: affiliate.bps,
      label: affiliate.label,
    });
  }
  const sum = fees.reduce((s, f) => s + f.bps, 0);
  return { fees, retainedBps: 10_000 - sum };
}

const ENDPOINTS: Endpoint[] = (() => {
  const helius = feeRecipientSummary(1000, {
    destination: HELIUS_AFFILIATE,
    bps: 500,
    label: "Helius Affiliate 5%",
  });
  const birdeye = feeRecipientSummary(1000);
  const jupiter = feeRecipientSummary(1000, {
    destination: JUPITER_AFFILIATE,
    bps: 500,
    label: "Jupiter Affiliate 5%",
  });

  return [
    {
      id: "helius",
      slug: "helius",
      url: "https://mainnet.helius-rpc.com",
      name: "Helius RPC",
      flatFee: 500,
      percentFee: 0,
      slaMs: 1200,
      calls24h: 4821,
      failures24h: 14,
      failureRate24h: 0.0029,
      avgLatencyMs: 310,
      totalPremiums: 2_410_500,
      totalRefunds: 7_000,
      poolBalance: 4_120_400,
      feeRecipients: helius.fees,
      poolRetainedBps: helius.retainedBps,
      isActive: true,
    },
    {
      id: "birdeye",
      slug: "birdeye",
      url: "https://public-api.birdeye.so",
      name: "Birdeye API",
      flatFee: 300,
      percentFee: 0,
      slaMs: 800,
      calls24h: 3107,
      failures24h: 62,
      failureRate24h: 0.02,
      avgLatencyMs: 480,
      totalPremiums: 932_100,
      totalRefunds: 18_600,
      poolBalance: 821_300,
      feeRecipients: birdeye.fees,
      poolRetainedBps: birdeye.retainedBps,
      isActive: true,
    },
    {
      id: "jupiter",
      slug: "jupiter",
      url: "https://quote-api.jup.ag",
      name: "Jupiter Quote API",
      flatFee: 300,
      percentFee: 0,
      slaMs: 600,
      calls24h: 7390,
      failures24h: 443,
      failureRate24h: 0.06,
      avgLatencyMs: 920,
      totalPremiums: 2_217_000,
      totalRefunds: 132_900,
      poolBalance: 1_753_400,
      feeRecipients: jupiter.fees,
      poolRetainedBps: jupiter.retainedBps,
      isActive: true,
    },
  ];
})();

function recipientShares(endpoint: Endpoint, premium: number): {
  shares: SettlementRecipientShare[];
  retained: number;
} {
  const shares: SettlementRecipientShare[] = endpoint.feeRecipients.map((r) => ({
    destination: r.destination,
    kind: r.kind,
    bps: r.bps,
    amount: Math.floor((premium * r.bps) / 10_000),
  }));
  const taken = shares.reduce((s, x) => s + x.amount, 0);
  return { shares, retained: premium - taken };
}

function mockCall(i: number): CallEvent {
  const endpoint = ENDPOINTS[i % ENDPOINTS.length];
  const status: CallEvent["status"] =
    i % 17 === 0 ? "timeout" : i % 23 === 0 ? "error" : "ok";
  const refund = status !== "ok" ? endpoint.flatFee : 0;
  const ts = new Date(Date.now() - i * 42_000).toISOString();
  const premium = endpoint.flatFee;
  const { shares, retained } = recipientShares(endpoint, premium);
  return {
    id: `call-${1000 + i}`,
    agentPubkey: AGENTS[i % AGENTS.length],
    endpointSlug: endpoint.slug,
    endpointName: endpoint.name,
    premium,
    refund,
    latencyMs:
      status === "timeout"
        ? endpoint.slaMs + 200
        : Math.floor(100 + ((i * 37) % 600)),
    status,
    recipientShares: shares,
    poolRetained: retained,
    ts,
  };
}

const MOCK_CALLS: CallEvent[] = Array.from({ length: 50 }, (_, i) => mockCall(i));

const MOCK_TOP_RECIPIENTS: RecipientEarnings[] = [
  {
    destination: TREASURY_VAULT,
    kind: "treasury",
    label: "Treasury",
    totalEarned: 555_960,
  },
  {
    destination: JUPITER_AFFILIATE,
    kind: "affiliate_ata",
    label: "Jupiter Affiliate",
    totalEarned: 110_850,
  },
  {
    destination: HELIUS_AFFILIATE,
    kind: "affiliate_ata",
    label: "Helius Affiliate",
    totalEarned: 120_525,
  },
];

export async function fetchStats(): Promise<Stats> {
  const totalPremiums = MOCK_CALLS.reduce((s, c) => s + c.premium, 0) * 100;
  const totalRefunds = MOCK_CALLS.reduce((s, c) => s + c.refund, 0) * 100;
  const poolBalanceAggregate = ENDPOINTS.reduce((s, e) => s + e.poolBalance, 0);
  const treasuryEarned = MOCK_TOP_RECIPIENTS.find((r) => r.kind === "treasury")
    ?.totalEarned ?? 0;
  return {
    totalPremiums,
    totalRefunds,
    callsInsured: 15_318,
    poolBalanceAggregate,
    treasuryEarned,
    activeEndpoints: ENDPOINTS.length,
    activeAgents: AGENTS.length,
    topRecipients: MOCK_TOP_RECIPIENTS,
  };
}

export async function fetchCalls(limit = 50): Promise<CallEvent[]> {
  return MOCK_CALLS.slice(0, limit);
}

export async function fetchCall(id: string): Promise<CallEvent | null> {
  return MOCK_CALLS.find((c) => c.id === id) ?? null;
}

export async function fetchEndpoints(): Promise<Endpoint[]> {
  return ENDPOINTS;
}

export async function fetchAgent(pubkey: string): Promise<AgentHistory> {
  const agentCalls = MOCK_CALLS.filter((c) => c.agentPubkey === pubkey).slice(
    0,
    20
  );
  const totalPremiumsPaid = agentCalls.reduce((s, c) => s + c.premium, 0);
  const totalRefundsReceived = agentCalls.reduce((s, c) => s + c.refund, 0);

  // Server-side mock: do NOT paint every wallet as eligible/active. Real
  // insurable state is read by `useAgentInsurableState` on the client via
  // `getAgentInsurableState` from `@pact-network/protocol-v1-client`. The SSR
  // pass returns a "loading" snapshot so the panel renders neutral until the
  // client poll lands the truth. (Painting eligible:true here briefly shows
  // every wallet as active — credibility risk in a live demo.)
  const ataBalance = 0;
  const allowance = 0;
  const eligible = false;

  return {
    agent: {
      pubkey,
      ataBalance,
      allowance,
      eligible,
      reason: "loading",
      totalPremiumsPaid,
      totalRefundsReceived,
      callCount: agentCalls.length,
      lastActivity: agentCalls[0]?.ts ?? null,
    },
    recentCalls: agentCalls,
  };
}
