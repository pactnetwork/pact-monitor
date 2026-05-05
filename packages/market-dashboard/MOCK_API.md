Mock API

lib/api/mock.ts supplies all data consumed by page components. When Wave 1D indexer ships, update lib/api/index.ts to re-export real HTTP fetchers pointed at NEXT_PUBLIC_INDEXER_URL instead of the mock functions.

Endpoints mocked

  fetchStats()       -> /api/stats
  fetchCalls(limit)  -> /api/calls?limit=N&order=ts.desc
  fetchEndpoints()   -> /api/endpoints
  fetchAgent(pubkey) -> /api/agents/:pubkey

Each mock is annotated // TODO(wave2-integration) where a real fetch should replace it.

Env vars (set on Vercel preview)

  NEXT_PUBLIC_SOLANA_RPC    Solana RPC endpoint (default: devnet)
  NEXT_PUBLIC_PROGRAM_ID    Pact Market program ID (default: system program stub)
  NEXT_PUBLIC_INDEXER_URL   Indexer base URL (not yet used — reserved for wave2)
  NEXT_PUBLIC_PROXY_URL     Proxy base URL (not yet used — reserved for wave2)
