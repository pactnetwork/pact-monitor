/**
 * Public data-access surface for the dashboard.
 *
 * Switches between the in-memory `./mock` fixture and the real indexer-backed
 * `./real` fetchers based on `NEXT_PUBLIC_INDEXER_URL`:
 *
 *   - unset  → use mocks (local dev, Vercel previews without an indexer URL)
 *   - set    → fetch from `${NEXT_PUBLIC_INDEXER_URL}/api/...`
 *
 * The env is read at module-load time. Next.js inlines `NEXT_PUBLIC_*` values
 * at build, so toggling between mock and real requires a rebuild — by design.
 *
 * See `./real.ts` for wire-shape gaps; the homepage renders cleanly under
 * either backend.
 */
import * as mockApi from "./mock";
import * as realApi from "./real";

const useReal = !!process.env.NEXT_PUBLIC_INDEXER_URL;

export const fetchStats = useReal ? realApi.fetchStats : mockApi.fetchStats;
export const fetchCalls = useReal ? realApi.fetchCalls : mockApi.fetchCalls;
export const fetchCall = useReal ? realApi.fetchCall : mockApi.fetchCall;
export const fetchEndpoints = useReal
  ? realApi.fetchEndpoints
  : mockApi.fetchEndpoints;
export const fetchAgent = useReal ? realApi.fetchAgent : mockApi.fetchAgent;

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
