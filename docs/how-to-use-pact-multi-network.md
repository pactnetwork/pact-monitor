# How to use Pact (multi-network) — simple guide

## What Pact does, in one line

Pact insures API calls. You put a provider's API behind the Pact proxy; an agent calls it through the proxy; each call debits a tiny USDC premium; if the call fails its SLA (too slow, a 5xx, or a network error), the agent is automatically refunded on-chain.

## What is new

The same flow now works on Solana and on EVM chains (Arc Testnet today) at the same time, from one deployment. The agent just uses the wallet that matches the endpoint's chain — a Solana wallet for a Solana endpoint, an Ethereum (0x) wallet for an EVM endpoint. Everything else (auth, balance check, premium debit, refund) routes to the right chain automatically based on the endpoint.

## There are two roles

### Role 1 — Operator: register an endpoint (once per provider)

This makes a provider insurable. You set its pricing: the flat premium, the percent fee, the SLA latency, and the fee split (how much stays in the pool vs goes to treasury/integrator).

- Solana endpoint: register on the Solana program (devnet program is `5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5`; mainnet program is `5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc`).
- EVM / Arc endpoint: register on the Arc registry with `cast send <PactRegistry> registerEndpoint(...)`. (A CLI/dashboard flow for EVM is not built yet; for now it is a direct contract call.)

Once registered, the endpoint shows up in the read API and is ready to insure.

### Role 2 — Agent: make an insured call (every request)

1. Hold USDC on the endpoint's chain and approve Pact to debit it:
   - Solana: an SPL token approval on your USDC account.
   - EVM / Arc: an ERC-20 `approve` to the Pact pool contract.
2. Send your normal API request to the Pact proxy instead of straight to the provider:
   - `https://market.pactnetwork.io/v1/<slug>/<the-provider-path>`
   - `<slug>` is the endpoint name, e.g. `helius`, `jupiter`, `birdeye`.
3. Attach the signed auth headers:
   - `x-pact-agent` — your wallet address (a Solana pubkey, or a `0x` Ethereum address)
   - `x-pact-timestamp`, `x-pact-nonce`, `x-pact-project`
   - `x-pact-signature` — sign this exact text:
     `v1\n<METHOD>\n<PATH>\n<TIMESTAMP>\n<NONCE>\n<BODY_HASH>`
     - Solana wallet: Ed25519 sign, signature in bs58.
     - Ethereum wallet: EIP-191 personal_sign, signature in `0x` hex.

The proxy verifies your signature, checks your balance and allowance, debits the premium, forwards the call to the real provider, and if the response breaches the SLA, refunds you automatically on-chain.

The only multi-network thing you do as an agent: use the wallet type that matches the endpoint's chain. A `0x` wallet on a Solana endpoint (or vice versa) is rejected.

## Try it read-only first (no cost, no wallet needed)

- List insured endpoints and their network:
  `GET https://indexer.pactnetwork.io/api/endpoints`
- See an agent's insurable snapshot:
  `GET https://market.pactnetwork.io/v1/agents/<your-address>`

## Current state (so expectations are right)

- Solana mainnet is live with 7 endpoints (pay-default, elfa, jupiter, fal, dummy, helius, birdeye).
- Solana devnet has 2 endpoints (helius, dummy).
- Arc Testnet is wired and the read/auth/settle code works, but no endpoint is registered yet — register one (operator step) before any Arc call will work.

---

# Architecture and design decisions (for technical review)

## How multi-network works

- One abstraction: `ChainAdapter` in `@pact-network/shared`, implemented by `SolanaAdapter` and `EvmAdapter`. Every service (settler, indexer, market-proxy) consumes adapters, never a chain SDK directly.
- The network registry (`shared/src/chains.ts`) is the single source of truth for which networks exist. Solana entries are hand-coded; EVM entries come from `program-evm/protocol-evm-v1/config/chains.json`. `getChain(name)` returns a `ChainDescriptor` (vm, chainId, usdcMint, rpcUrl, finalityBlocks, ...).
- Each service bootstraps adapters by looping `PACT_ENABLED_NETWORKS` and building one adapter per network into a map. Requests and batches route to the right adapter by the endpoint's `network`. So "which networks a deployment serves" is pure config — the same Docker image runs any topology.

## Settle path (the half that was broken and is now fixed)

- Flow: settler `submitViaAdapter` -> `adapter.submitSettleBatch` -> EVM `encodeSettleBatch` calldata (or Solana instruction) -> on-chain -> settler pushes to the indexer -> indexer writes network-keyed rows.
- Per-event data travels in `SettleBatchInput.events[]` as VM-neutral fields: callId, agent, premium, `refundBaseUnits`, `eventTimestamp`, breach, fee-recipient hint. Both adapters encode these exact values. The original failures were all the same class: the adapter synthesizing a value instead of carrying the real one (refund encoded as premium; timestamp encoded as `Date.now()` instead of the wrapped-call time). Fixed by threading the real value end-to-end.

## Auth (per-VM)

- The proxy selects the signature scheme by the agent key format: a `0x` address verifies via secp256k1 / EIP-191; a bs58 pubkey via Ed25519. The canonical signed payload is identical across VMs (`v1\nMETHOD\nPATH\nTIMESTAMP\nNONCE\nBODY_HASH`).
- A cross-mode guard rejects an agent whose VM does not match the endpoint's network (wired via `getEndpointNetwork`: slug -> registry -> network). So a `0x` agent on a Solana endpoint (or vice versa) is 401.

## Accounting (indexer)

- Every table is network-keyed by composite PK: `Settlement @@id([network, signature])`, `Call @@id([network, callId])`, `PoolState @@id([network, endpointSlug])`, recipient shares and earnings likewise. Two chains can never collide on a row.
- One batch resolves to a single network; a payload whose per-call network diverges from the batch network is rejected (400, zero rows). Recipient-share idempotency is scoped by `(network, settlementSig)`.

## Concurrent multi-EVM (one fleet, many EVM chains)

- Deployment addresses resolve per chain with precedence: `PACT_EVM_<KIND>_<NETWORK>` env -> legacy global `PACT_EVM_<KIND>` -> baked `DEPLOYMENTS[chainId]`. Running two EVM chains in one instance requires the per-chain keys (or baked addresses); the global keys cannot disambiguate two chains.
- The settler flush dispatches per-`(network, slug)` group concurrently with failure isolation (`Promise.allSettled`), so one chain's slow finality wait cannot head-of-line-block another chain's settlement.
- The indexer config-sync resumes from a per-network cursor (`SyncCursor` table) instead of re-walking from `deploymentBlock` every tick — cost stops scaling with chain height.
- The settler boots EVM-only (no `SOLANA_RPC_URL` / `SETTLEMENT_AUTHORITY_KEY`) by gating all Solana providers on whether a `solana-*` network is enabled — this is what makes a dedicated single-chain settler possible.

## Deployment topology

- Default: one settler + one indexer + one proxy serving all enabled networks. Cheapest (fewest always-on instances).
- Scale by exception: give a hot chain its own settler (same image, single-network env). Proxy and indexer scale horizontally; the settler is the isolation boundary.

## Key decisions and gotchas

- Solana program IDs: the client default `PROGRAM_ID` is the mainnet program `5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc` (live, 7 endpoints). Devnet state is on `5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5`, so a devnet deployment must override the program — a default-constructed adapter reads mainnet. Pre-existing drift, currently masked by `PACT_LEGACY_DIRECT_SOLANA=true`; fix before the cleanup work flips that flag false.
- Arc protocol addresses are baked into the client for chain 5042002; no env needed for Arc.
- EVM endpoint registration has no CLI/dashboard yet — Arc endpoints are registered via `cast send <PactRegistry> registerEndpoint(...)`.
- F3 idempotency is network-scoped via the existing `@@index([network, settlementSig])`; a hard composite-uniqueness DB constraint was deferred (schema migration, not required for correctness here).
- EVM signer (Phase 1) accepts a raw 0x-hex key only; a Secret Manager resource-path string is not yet supported (inject the secret as the env var value).

## Verification done

- Two independent review passes (internal goal-backward review + Codex), both SHIP.
- Full suites green: settler 111, shared 41, indexer 100 (incl `migration-rollback` against a real Postgres), protocol-evm-v1-client 53.
- EVM-only settler boot verified live (`node dist/main.js`, no Solana env, `/health` 200). `SyncCursor` migration applied clean to a real Postgres (no drift).
- Live read smokes: Solana mainnet (7 endpoints) and devnet (2 endpoints) read path + balance/allowance; Arc Testnet read connectivity (registry empty pending endpoint registration).
- Not yet exercised against reality: a live write/settle on either chain (needs a registered endpoint + gas + the settler signer) — this is the first-deploy validation step.
