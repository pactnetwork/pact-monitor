# Mock API

`lib/api/mock.ts` supplies all data consumed by page components when no
indexer is wired. The shapes mirror the indexer responses produced by Step D
#59 (per-endpoint PoolState aggregates and SettlementRecipientShare records).

`lib/api/index.ts` now switches between mock and real automatically:

- `NEXT_PUBLIC_INDEXER_URL` unset → use `./mock` (local dev, Vercel preview)
- `NEXT_PUBLIC_INDEXER_URL` set   → use `./real` (hits the indexer)

`./real` maps the indexer's wire shape onto `lib/api/types.ts`. See the
file header for current wire-shape gaps (missing per-endpoint aggregates,
no global `/api/calls` firehose route, no per-call recipient-share breakdown).

## Endpoints mocked → real swap targets

| Mock function          | Real route                     | Returns                                                         |
|------------------------|--------------------------------|-----------------------------------------------------------------|
| `fetchStats()`         | `GET /api/stats`               | `Stats` — aggregate across all CoveragePools + treasury earned + top integrators |
| `fetchCalls(limit)`    | `GET /api/calls?limit=N&order=ts.desc` | `CallEvent[]` (each with optional `recipientShares`)         |
| `fetchCall(id)`        | `GET /api/calls/:id`           | Single `CallEvent` with full `recipientShares` + `poolRetained` |
| `fetchEndpoints()`     | `GET /api/endpoints`           | `Endpoint[]` with `poolBalance` + `feeRecipients` + `poolRetainedBps` |
| `fetchAgent(pubkey)`   | `GET /api/agents/:pubkey`      | `AgentHistory` — insurable snapshot + recent calls               |

The mock module also provides deterministic `topRecipients` data feeding the
overview page's "Top Integrators" table.

## On-chain data sources

Live agent insurable state (balance + allowance) is NOT served by the indexer.
The dashboard reads it directly via Solana RPC using
`getAgentInsurableState` from `@pact-network/protocol-v1-client`. The
`useAgentInsurableState` hook handles polling.

The indexer feeds the following SettlementRecipientShare-shaped fields used by
`/calls/[id]`:

```ts
SettlementRecipientShare {
  destination: string;
  kind: "treasury" | "affiliate_ata" | "affiliate_pda";
  bps: number;
  amount: number;
}
```

## Env vars (set on Vercel preview)

| Var                       | Default                              | Used by |
|---------------------------|--------------------------------------|---------|
| `NEXT_PUBLIC_SOLANA_RPC`  | `https://api.devnet.solana.com`     | `lib/solana.ts` (RPC client) |
| `NEXT_PUBLIC_INDEXER_URL` | unset (mock used)                    | `lib/api/index.ts` (when wired) |
| `NEXT_PUBLIC_PROXY_URL`   | unset                                | reserved — wave 2 |

The deployed program ID is now baked into `@pact-network/protocol-v1-client`
(canonical devnet `5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5`). Override via
the SDK if needed; the dashboard does not hold a separate `NEXT_PUBLIC_PROGRAM_ID`.
