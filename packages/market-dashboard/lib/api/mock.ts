import type { Stats, CallEvent, Endpoint, AgentHistory } from "./types";

// Fixture data for all mock API responses.
// TODO(wave2-integration): replace all exports below with real fetches to indexer URLs.

const AGENTS = [
  "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
  "3h1zGmCwsRf4HRDiZzqHQDuZHyJxeRpW4oKwYt5nV6pE",
  "GqnohFahAX5EMmxNbTxAFPJBvnkVnL7W8tNiD3Zx2PKa",
];

const ENDPOINTS: Endpoint[] = [
  {
    id: "helius",
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
    isActive: true,
  },
  {
    id: "birdeye",
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
    isActive: true,
  },
  {
    id: "jupiter",
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
    isActive: true,
  },
];

function mockCall(i: number): CallEvent {
  const endpoint = ENDPOINTS[i % ENDPOINTS.length];
  const status = i % 17 === 0 ? "timeout" : i % 23 === 0 ? "error" : "ok";
  const refund = status !== "ok" ? endpoint.flatFee : 0;
  const ts = new Date(Date.now() - i * 42_000).toISOString();
  return {
    id: `call-${1000 + i}`,
    agentPubkey: AGENTS[i % AGENTS.length],
    endpointUrl: endpoint.url,
    endpointName: endpoint.name,
    premium: endpoint.flatFee,
    refund,
    latencyMs: status === "timeout" ? endpoint.slaMs + 200 : Math.floor(100 + Math.random() * 600),
    status,
    ts,
  };
}

const MOCK_CALLS: CallEvent[] = Array.from({ length: 50 }, (_, i) => mockCall(i));

export async function fetchStats(): Promise<Stats> {
  return {
    totalPremiums: 5_559_600,
    totalRefunds: 158_500,
    callsInsured: 15_318,
    poolBalance: 10_000_000_000,
    activeEndpoints: ENDPOINTS.length,
    activeAgents: AGENTS.length,
  };
}

export async function fetchCalls(limit = 50): Promise<CallEvent[]> {
  return MOCK_CALLS.slice(0, limit);
}

export async function fetchEndpoints(): Promise<Endpoint[]> {
  return ENDPOINTS;
}

export async function fetchAgent(pubkey: string): Promise<AgentHistory> {
  const agentCalls = MOCK_CALLS.filter((c) => c.agentPubkey === pubkey).slice(0, 20);
  const totalPremiumsPaid = agentCalls.reduce((s, c) => s + c.premium, 0);
  const totalRefundsClaimed = agentCalls.reduce((s, c) => s + c.refund, 0);
  return {
    agent: {
      pubkey,
      balance: 5_000_000,
      pendingRefund: agentCalls.find((c) => c.refund > 0) ? agentCalls.find((c) => c.refund > 0)!.refund : 0,
      totalPremiumsPaid,
      totalRefundsClaimed,
      callCount: agentCalls.length,
      lastActivity: agentCalls[0]?.ts ?? null,
    },
    recentCalls: agentCalls,
  };
}
