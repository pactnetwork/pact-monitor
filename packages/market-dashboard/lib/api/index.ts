/**
 * Public data-access surface for the dashboard.
 *
 * Currently re-exports the in-memory mock until the indexer's Step D #59 work
 * lands real HTTP endpoints. Swap targets are documented in MOCK_API.md.
 */
export { fetchStats, fetchCalls, fetchCall, fetchEndpoints, fetchAgent } from "./mock";
export type {
  Stats,
  CallEvent,
  Endpoint,
  AgentHistory,
  AgentInsurableSnapshot,
  FeeRecipientSummary,
  RecipientEarnings,
  SettlementRecipientShare,
} from "./types";
