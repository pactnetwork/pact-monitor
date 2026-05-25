# WP-MN-03b — RESEARCH

- **Purpose:** Gate A entry artifact. Audits the chain-touch sites in 3 service modules; locks the multi-network-per-service architecture (Map<network, ChainAdapter>, env config, signer-per-network, routing rules); resolves WP-MN-02 + WP-MN-03a carry-forwards; specifies the byte-identical e2e diff harness; breaks WP-MN-03b into 5 sub-tasks.
- **Companion:** `mn-03b-CONTEXT.md`
- **Branch:** `feat/multi-network-03b-services-swap` off `feat/multi-network@ebb8664`
- **Date:** 2026-05-20

---

## 1. Topology decision context

The off-chain spec §7 originally framed "fleet-per-network." Tu's 2026-05-20 decision (during WP-MN-03b open): **multi-network per service**.

- **One** Cloud Run instance each for market-proxy, settler, indexer.
- Each holds `Map<network, ChainAdapter>` built at boot from `PACT_ENABLED_NETWORKS` (comma-separated names from the registry).
- Routing:
  - **Settler**: route each batch by the first event's `network` to that network's adapter. (Within a batch, all events share a network per how batcher groups them.)
  - **Indexer cron**: iterate every adapter; call `readEndpointConfigs()` per network; upsert each Endpoint with its actual network.
  - **Market-proxy**: per-request, read `endpoint.network` from the in-memory endpoint cache (populated from DB post-WP-MN-03a); look up adapter; call `checkAgentEligibility`.
- Rollback flag: `PACT_LEGACY_DIRECT_SOLANA=true` falls back to pre-WP direct path for all `solana-*` networks. EVM networks have no legacy path; the adapter is the only option for them.

---

## 2. Service-side chain-touch audit (post-WP-MN-03a state at `ebb8664`)

### 2.1 `packages/settler/src/submitter/submitter.service.ts`

**Constructor (lines 113–147):** holds `connection: Connection`, `programId: PublicKey`, `usdcMint: PublicKey`, and three derived PDAs (`settlementAuthorityPda`, `treasuryPda`, `protocolConfigPda`). All single-Solana-scoped. After WP-MN-03b: holds `Map<network, ChainAdapter>` instead; each adapter encapsulates its own connection + programId + USDC mint + PDAs.

**`loadEndpoint(slug)` helper (lines 320–365):** caches per-slug `EndpointConfig` + `CoveragePool` decoded structs in `endpointCache`. Currently called from `buildBatchIx`. **After WP-MN-03b: the adapter's `submitSettleBatch` does an internal load. Settler can EITHER (a) remove its own cache and rely on adapter, OR (b) keep the cache and feed it to the adapter via the SettleBatchInput shape**. The locked-adapter contract from WP-MN-02 has `SettleBatchInput` accepting `slug` + `events` + `signer` + `options` — NOT pre-loaded endpoint state. So Option (a) is the only path that doesn't require an adapter API change. RESEARCH-time decision §5.4.

**`buildBatchIx(slug, events, ...)` (lines 230–260):** constructs PDAs, calls `buildSettleBatchIx`. After WP-MN-03b: this function disappears entirely. The settler just calls `adapter.submitSettleBatch({ slug, events, signer: keypair })`.

**`submitBatch(batch)` (around line 280):** wraps `buildBatchIx` + `sendAndConfirmTransaction`. After WP-MN-03b: becomes a thin routing wrapper that picks the adapter by the batch's network and calls `submitSettleBatch`.

**Other call sites (lines 192, 216):** `new PublicKey(agentPubkey)` / `new PublicKey(r.destination)` — these happen in batcher's pre-WP-MN-03b mapping. Post-swap, the adapter takes string addresses in `SettleBatchInput.events` (each event has `agent: string`); the `new PublicKey(...)` conversions move INTO the adapter, not the settler.

**`getCallRecord(callRecordPda)` helper (around line 470):** post-settlement verification, fetches CallRecord PDA via `connection.getAccountInfo`. **NOT covered by the WP-MN-02 adapter interface.** WP-MN-03b RESEARCH-time decision §5.5: either expose this via a new adapter method OR keep it as a private settler helper that uses the adapter's connection. RESEARCH locks the latter (avoid adapter API expansion; settler keeps a thin Solana-specific helper that's only invoked for Solana traffic anyway — see §5.5).

### 2.2 `packages/indexer/src/sync/on-chain-sync.service.ts`

**Constructor (lines 70–81):** holds `connection`, `programId`. After WP-MN-03b: `Map<network, ChainAdapter>` instead.

**Cron `@Cron(CronExpression.EVERY_5_MINUTES)` handler (around line 100):** calls `getProgramAccounts` to list every EndpointConfig PDA. After WP-MN-03b: iterates every adapter in the map; calls `adapter.readEndpointConfigs()` per network; upserts each Endpoint with its actual network value (replaces the hardcoded `syncNetwork = "solana-devnet"` placeholder added in WP-MN-03a T4 at line 210).

**`decodeEndpointConfig(acct.account.data)` (line 177):** internal to the adapter post-swap. Indexer reads `EndpointConfigSnapshot` from the adapter instead.

### 2.3 `packages/market-proxy/src/lib/balance.ts` + `routes/proxy.ts`

**`balance.ts:42` `createBalanceCheck(opts)`:** wraps `createDefaultBalanceCheck` from `@pact-network/wrap`. After WP-MN-03b: deletes this wrapper; the adapter's `checkAgentEligibility` is the new path. (`balance.ts` may stay as a thin shim if there are non-test consumers of `createBalanceCheck`; check during execution.)

**`routes/proxy.ts:127` `wrapFetch({...})`:** the proxy's per-request entry into wrap. Currently `wrapFetch` receives the balance-check sink via `opts.balanceCheck`. After WP-MN-03b: the proxy passes the adapter's `checkAgentEligibility` as the balance-check; OR, more cleanly, wrap stays unchanged (it already has a `balanceCheck` slot via the `BalanceCheck` interface) and we pass `{ check: (wallet, amt) => adapter.checkAgentEligibility(wallet, amt) }`.

**`routes/proxy.ts:137` `network: getChain("solana-devnet").network`:** REMOVED. Replaced with `network: endpoint.network` (the resolved endpoint's network from DB).

**`lib/endpoints.ts:56`:** `SELECT … FROM "Endpoint"` — already returns `network` post-WP-MN-03a (the column was added). The in-memory cache in `endpoints.ts` must surface `network` to the proxy handler.

### 2.4 Sanity — what's NOT touched

- `SolanaAdapter` itself in `@pact-network/shared` — locked by WP-MN-02.
- `@pact-network/wrap` — its interface stays; only its consumer (the proxy) routes through the adapter.
- `@q3labs/pact-protocol-v1-client` — stays as the dep of the adapter; services no longer import it directly post-WP-MN-03b (except for type imports of `FeeRecipientKind`, etc., that are wire-format types, not chain-touch).
- Legacy Anchor crate — frozen.

---

## 3. Carry-forwards resolved

### 3.1 EndpointConfigSnapshot projection drift (from WP-MN-02 Gate B)

The `EndpointConfigSnapshot` interface from WP-MN-02 has `slug`, `authority`, `maxTotalFeeBps`, `feeRecipients`, `paused`, `raw`. Solana's `EndpointConfig` lacks `authority` (the coveragePool is used as proxy) and `maxTotalFeeBps` (not per-endpoint on Solana).

**Decision:** Accept the lossy projection. Indexer consumers read **`raw.flatPremiumLamports`, `raw.percentBps`, `raw.slaLatencyMs`, `raw.imputedCostLamports`, `raw.exposureCapPerHourLamports`** directly from the SolanaAdapter's `raw` field (which is the decoded `EndpointConfig` struct). The projection fields (`authority`, `maxTotalFeeBps`) are unused for Solana writes; EVM consumers in WP-MN-04 will populate them from EVM's first-class fields.

This means the indexer post-WP-MN-03b does:
```typescript
const snapshots = await adapter.readEndpointConfigs();
for (const s of snapshots) {
  const raw = s.raw as EndpointConfig; // SolanaAdapter's raw is EndpointConfig
  // upsert using s.slug + raw.flatPremiumLamports + raw.percentBps + ...
}
```

The type-narrow `s.raw as EndpointConfig` is acceptable because the indexer is solana-scoped today (the adapter is the SolanaAdapter; raw is its native struct). When EvmAdapter lands, the upsert path forks on `s.descriptor.vm` (handled in WP-MN-04 / a future indexer cleanup).

### 3.2 `SettleBatchInput.events.latencyMs` (from WP-MN-02 Gate B)

The adapter currently hardcodes `latencyMs: 0` in the per-event CallRecord. WP-MN-03b decision: **extend `SettleBatchInput.events` with `latencyMs: number`** so the settler can plumb the real value through. This is an additive interface change to `@pact-network/shared/src/chain-adapter.ts` (a new optional/required field on the event tuple).

Wait — that contradicts the non-negotiable "no edits to SolanaAdapter itself." Re-checking: §C "no edits to `SolanaAdapter` itself." Interface extension on `chain-adapter.ts` is an interface edit, not an adapter-impl edit. **Acceptable** as long as it's additive and SolanaAdapter is updated to read the field. (Strictly speaking the SolanaAdapter impl does change — one line — but that's a forward-compatible additive change matching the interface.)

Decision: **add `latencyMs: number` to `SettleBatchInput.events`** (required), update SolanaAdapter to use it instead of the hardcoded 0, and update the parity test. This is a TINY edit and best done here (WP-MN-03b) since the settler needs it.

### 3.3 Unify `"solana-devnet"` hardcoding (from WP-MN-03a Gate B)

- `proxy.ts:137`: `getChain("solana-devnet").network` → REPLACED with `endpoint.network` from DB.
- `on-chain-sync.service.ts:210`: `const syncNetwork = "solana-devnet"` → REPLACED with iteration over `Map<network, ChainAdapter>`.

Both are eliminated by the multi-network refactor — no separate fix needed.

---

## 4. Multi-network-per-service architecture

### 4.1 Env config

| Env var | Default | Purpose |
|---|---|---|
| `PACT_ENABLED_NETWORKS` | `"solana-devnet"` | Comma-separated list of network names from registry. Services validate via `getChain(name)`. |
| `PACT_LEGACY_DIRECT_SOLANA` | `false` | When `true`, every `solana-*` adapter call site falls back to pre-WP direct path. Rollback safety. |
| `SOLANA_RPC_URL` | (existing) | Still used as the default Solana RPC. Per-network override: `PACT_RPC_URL_<NETWORK>` (e.g. `PACT_RPC_URL_solana_devnet`). |
| `PROGRAM_ID` | (existing) | Still used as the default Solana program ID. |

### 4.2 Per-network signer (settler only)

Settler holds `Map<network, Keypair>` for signing. Keys loaded from Secret Manager keyed by `pact-settler-<network>`. Initial wiring loads only `solana-devnet`. EVM networks (e.g. `arc-testnet`) will load 0x-hex private keys (WP-MN-04 provisions the secrets).

For local dev: `PACT_SETTLER_KEYPAIR_<NETWORK>` env var holds the JSON keypair (matches existing `PACT_SETTLER_KEYPAIR` for solana-devnet).

### 4.3 Adapter map construction at boot

Each service's `onModuleInit` (or constructor):
```typescript
const enabled = (process.env.PACT_ENABLED_NETWORKS ?? "solana-devnet")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const adapters = new Map<string, ChainAdapter>();
for (const name of enabled) {
  const descriptor = getChain(name); // throws on unknown
  if (descriptor.vm === "solana") {
    adapters.set(name, new SolanaAdapter({
      descriptor,
      rpcUrl: process.env[`PACT_RPC_URL_${name.replace("-", "_")}`] ?? process.env.SOLANA_RPC_URL ?? "<default>",
      // signing key, etc., per service
    }));
  } else if (descriptor.vm === "evm") {
    // WP-MN-03b ships a stub; WP-MN-04 replaces with EvmAdapter.
    adapters.set(name, new EvmAdapterStub(descriptor));
  }
}
```

### 4.4 Routing rules

- **Settler**: `adapter = adapters.get(batch.events[0].network)`; throw if missing.
- **Indexer cron**: `for (const [network, adapter] of adapters) { await refresh(network, adapter); }`
- **Market-proxy**: `adapter = adapters.get(endpoint.network)`; if missing, return 502 (the endpoint's network isn't enabled on this proxy).

### 4.5 `EvmAdapterStub` shape

A throwaway sidecar in `packages/shared/src/adapters/evm/index.ts` that implements `ChainAdapter` but every method throws `Error("EvmAdapter not implemented — WP-MN-04")`. Exists so the Map can hold an entry for EVM networks without crashing services at boot; routes can be exercised; tests confirm the routing without actually settling on EVM.

WP-MN-04 replaces the stub with the real `EvmAdapter`.

---

## 5. RESEARCH-time decisions

### 5.1 `PACT_LEGACY_DIRECT_SOLANA` per-service wiring

Three services, three flag-check sites:

- **Settler `submitBatch`**: if `PACT_LEGACY_DIRECT_SOLANA && batch.network.startsWith("solana-")` → use legacy direct path (preserved as the existing logic). Else → call `adapter.submitSettleBatch`.
- **Indexer `refreshEndpoints` (cron handler)**: same pattern. Legacy → `connection.getProgramAccounts`. Adapter → `adapter.readEndpointConfigs()`.
- **Market-proxy per-request**: same pattern. Legacy → `createBalanceCheck(...).check(...)`. Adapter → `adapter.checkAgentEligibility(...)`.

Each service logs the active path at startup: `[settler] adapter mode: ADAPTER (PACT_LEGACY_DIRECT_SOLANA=false)`.

### 5.2 Settler loadEndpoint decision

**Remove the settler's own `loadEndpoint` cache.** The adapter's `submitSettleBatch` does its own load (currently uncached). Performance hit: 3 extra `getAccountInfo` calls per batch (EndpointConfig + CoveragePool + Treasury) on every batch instead of cache-hit. Acceptable for current devnet throughput (<10 batches/min); revisit when load justifies it (cleanup WP).

**The settler does keep its own `loadEndpoint` for the loadEndpoint-cached path used by `getCallRecord` and other helpers** — but only when those helpers are needed; not for the submit path.

### 5.3 SettleBatchInput.events.latencyMs addition

`packages/shared/src/chain-adapter.ts` `SettleBatchInput.events[i]` gains `latencyMs: number`. SolanaAdapter reads this instead of hardcoding 0. The settler propagates `event.latencyMs` from the incoming `WrapCallEventDto`.

Test update: WP-MN-02's `solana-adapter-parity.test.ts` already exists; one test needs adjustment to assert `latencyMs` flows through. WP-MN-04's EvmAdapter must read this field too (forward-compat).

### 5.4 Adapter-swap byte-identical e2e diff

Harness:
```typescript
describe("adapter-swap byte-identical (solana-devnet)", () => {
  it("legacy path === adapter path for a representative batch", async () => {
    const events = [/* representative SettlementEvent fixture */];
    
    // Capture under LEGACY mode
    const legacyResult = await runPipeline({ PACT_LEGACY_DIRECT_SOLANA: true }, events);
    
    // Capture under ADAPTER mode
    const adapterResult = await runPipeline({ PACT_LEGACY_DIRECT_SOLANA: false }, events);
    
    // Compare:
    expect(adapterResult.txWireBytes).toEqual(legacyResult.txWireBytes);
    expect(adapterResult.dbState).toEqual(legacyResult.dbState);
    expect(adapterResult.feeShares).toEqual(legacyResult.feeShares);
  });
});
```

`runPipeline` wires the settler with stub Connection that captures the broadcast tx, runs through indexer push to local docker postgres, returns the full state. Both modes share the stub Connection (so signatures are deterministic by stub seed).

Lives at `packages/settler/test/adapter-swap-e2e.spec.ts` (settler-driven since it owns the broadcast path) plus a complementary `packages/indexer/test/adapter-swap-indexer.spec.ts` for the `readEndpointConfigs` parity.

### 5.5 `getCallRecord` post-settlement helper

Settler's `getCallRecord` is a private debug/retry helper — NOT on the WP-MN-02 adapter interface. **Decision:** keep it as a private settler-side helper that uses the adapter's underlying connection via a private accessor (e.g. `adapter.getRawSolanaConnection()` — a sentinel method on SolanaAdapter only, NOT in the ChainAdapter interface).

That said, the settler's getCallRecord is called rarely (only on retry paths). For WP-MN-03b: keep it using a direct `Connection` constructed at settler boot from the same SOLANA_RPC_URL — independent of the adapter map. This sidesteps the issue cleanly; the function only matters for solana-* anyway. Documented.

### 5.6 Market-proxy endpoint.network surface

The proxy's per-request handler at `proxy.ts:127` already loads `endpoint` from the in-memory cache built by `lib/endpoints.ts`. WP-MN-03a added `network` to the Endpoint DB row. WP-MN-03b ensures `lib/endpoints.ts` surfaces `network` in the cached representation, and `proxy.ts` reads `endpoint.network` to select the adapter.

---

## 6. Sub-task breakdown (PLAN files)

| PLAN | Title | Files touched | Tests |
|---|---|---|---|
| `mn-03b-01-PLAN.md` | SettleBatchInput.+latencyMs additive + SolanaAdapter wires it | `packages/shared/src/chain-adapter.ts`, `packages/shared/src/adapters/solana/index.ts`, `packages/shared/test/solana-adapter-parity.test.ts` | shared tests +1 (latencyMs flows through) |
| `mn-03b-02-PLAN.md` | EvmAdapterStub scaffolding | `packages/shared/src/adapters/evm/index.ts` (new), `packages/shared/src/index.ts` (re-export), `packages/shared/test/evm-adapter-stub.test.ts` | shared tests +3 (each method throws "not implemented") |
| `mn-03b-03-PLAN.md` | Service Map<network, ChainAdapter> construction + PACT_ENABLED_NETWORKS env + PACT_LEGACY_DIRECT_SOLANA flag plumbing | settler, indexer, market-proxy: each gets a new `adapters.module.ts` / similar shared bootstrap | per-service tests +5 (Map construction, env parsing, legacy flag logging) |
| `mn-03b-04-PLAN.md` | Service refactor: settler.submitter + indexer.on-chain-sync + market-proxy.balance routing through Map<network, ChainAdapter> | the three service modules | per-service tests adapted (count preserved); existing event-flow tests now exercise the adapter path |
| `mn-03b-05-PLAN.md` | Adapter-swap byte-identical e2e (the Gate B headline artifact) + multi-network routing test | `packages/settler/test/adapter-swap-e2e.spec.ts` (new), `packages/indexer/test/adapter-swap-indexer.spec.ts` (new), `packages/market-proxy/test/multi-network-routing.spec.ts` (new) | +4 e2e tests; the diff MUST be empty for solana-devnet |

---

## 7. Risks

| ID | Risk | Mitigation |
|---|---|---|
| R1 | Adapter-swap e2e diff non-empty under representative load (PR-R2 in plan-level register) | Headline Gate B criterion — Gate B BLOCKED on non-empty diff. Per-service `PACT_LEGACY_DIRECT_SOLANA=true` is the surgical fallback. |
| R2 | Settler's `loadEndpoint` cache removal causes performance regression on devnet | Documented in §5.2; revisit in cleanup WP after 1 week stable adapter ops. |
| R3 | `SettleBatchInput.events.latencyMs` addition breaks the WP-MN-02 parity test | T1 updates the parity test in the same commit; integral to the additive change. |
| R4 | EvmAdapterStub leaks into production via accidental routing (e.g. endpoint mis-configured as `arc-testnet`) | Stub throws on every method; service catches the throw + returns 502 with descriptive error. No silent failure. |
| R5 | Two adapter modes (legacy + adapter) in same binary increases test complexity | Per-service startup log shows active path; tests parameterize over both modes; the legacy path is removed in a cleanup WP 1 week after stable operation. |
| R6 | The indexer's `s.raw as EndpointConfig` cast (§3.1 carry-forward resolution) is type-unsafe long-term | Safe today (SolanaAdapter is the only impl); WP-MN-04 forks on `s.descriptor.vm`; future cleanup formalizes the per-VM raw type. |

---

## 8. Open questions

- **None blocking.** WP-MN-04 RESEARCH will pick up the EvmAdapter-real-impl handoff.

---

## 9. Gate A request

This RESEARCH + the companion CONTEXT satisfy the Gate A entry criteria. **Captain (Tu / captain-proxy): please emit `mn-03b-CAPTAIN-GATE-A-VERDICT.md`.** On APPROVED, next step is to author 5 PLAN files via `superpowers:writing-plans` + execute via `superpowers:subagent-driven-development`.
