# WP-MN-04 — `EvmAdapter` real impl + first non-Solana fleet (Arc Testnet) — CONTEXT

- **Track:** Multi-Network refactor (MN), fifth WP — the **first live multi-VM fleet**.
- **Branch:** `feat/multi-network-04-evm-fleet` (off `feat/multi-network@d093945` after WP-MN-03b merge).
- **Captain:** Tu (out-of-office); captain-proxy authors Gate A; **execution PAUSES for explicit Tu authorization** before T1.
- **Date opened:** 2026-05-20

## Why a different texture from WP-MN-01..03b

WP-MN-01..03b refactored existing code paths and ran against existing infra. WP-MN-04 **provisions new infrastructure**:

- One new Cloud Run revision per service with EVM config layered in (`PACT_ENABLED_NETWORKS=solana-devnet,arc-testnet`).
- The Arc settler EOA private key stored as a Cloud Run env value (Phase 1, Tu-doable). Promotion to Google Secret Manager (`pact-settler-arc-testnet`) is a **Phase 2 Rick-owned follow-up** because Tu does not currently hold GCP IAM permission to create Secret Manager secrets. Code is identical in both phases — the settler's loader detects the `projects/...` prefix and routes accordingly. D6 §6 / RESEARCH §5 lock this two-phase model.
- One new Arc Testnet RPC endpoint (currently `rpcUrl: null` in `chains.json`).
- One Tu-signed on-chain admin tx granting `SETTLER_ROLE` to the new settler EOA on the deployed `PactSettler` (`0xe461CE50ef53BFC10945B101FB94b11Ec5eB591f`).

Tu's standing "auto-drive unless it really touches production" rule kicks in here: this DOES touch production-shape infrastructure (Cloud Run env, on-chain role grant). Captain-proxy stops at Gate A.

## Purpose

Replace the WP-MN-03b `EvmAdapterStub` (which throws "not implemented") with a real `EvmAdapter` that wraps `@pact-network/protocol-evm-v1-client` (viem) and stand up the Arc Testnet fleet end-to-end. Headline acceptance: `PACT_ENABLED_NETWORKS=solana-devnet,arc-testnet` on all three services; an agent call against an arc-testnet-registered endpoint debits premium on Arc USDC, settles on `PactSettler`, gets ingested by the indexer with `network='arc-testnet'`, and shows in the read API.

## Topology lock (carried from WP-MN-03b)

Multi-network-per-service: one settler, one indexer, one market-proxy — each holding `Map<network, ChainAdapter>` keyed by network. WP-MN-04 just adds `arc-testnet → EvmAdapter` to that Map. No new fleet shape; the WP-MN-03b plumbing is the load-bearing piece.

## Upstream artifacts (READ FIRST)

1. **D6 reorg/finality policy** — `docs/evm/2026-05-20-reorg-policy.md`. **Hard Gate A entry artifact.** All §3/§4/§5 algorithms in this WP reference it verbatim.
2. **Off-chain spec §2.5 (per-VM auth)** + **§2.6 (reorg/finality/idempotency)** + **§3.2 §4.2 §5.2 (chain-coupled seams)** — `docs/evm/2026-05-19-multi-network-offchain-services-spec.md` on `docs/multi-network-design`.
3. **Architecture spec §3 L2 (`ChainAdapter`)** + **§3 L3 (chain-agnostic services)** + **§6 (DB schema)** — `docs/evm/2026-05-19-multi-network-architecture-spec.md`.
4. **Phased plan §7 (WP-MN-04 deliverables, sub-tasks, Gate A entry, Gate B exit, risks)** — `docs/superpowers/specs/2026-05-20-multi-network-phased-plan-design.md`.
5. **WP-MN-03b carry-forwards** — `.planning/phases/mn-03b-services-swap/mn-03b-REPORT-gateB.md` §"Carry forward to WP-MN-04 RESEARCH":
   - EvmAdapter real impl replaces EvmAdapterStub.
   - D6 reorg policy gate.
   - Arc fleet stand-up (Cloud Run + Secret Manager).
   - `PACT_ENABLED_NETWORKS=solana-devnet,arc-testnet` end-to-end smoke.
   - Cleanup WP after 1 week stable (separate WP, NOT in 04 scope).
6. **`@pact-network/protocol-evm-v1-client`** module map — `packages/protocol-evm-v1-client/src/{constants,addresses,encode,errors,helpers,state}.ts`. Already viem-shaped. Arc Testnet deployed addresses already baked into `addresses.ts:DEPLOYMENTS`:
   - registry `0x056BAC33546b5b51B8CF6f332379651f715B889C`
   - pool `0xa6135d9C6BFA0F256B9DeBa10d76C7698329aFdE`
   - settler `0xe461CE50ef53BFC10945B101FB94b11Ec5eB591f`
   - USDC `0x3600000000000000000000000000000000000000`

## In scope

### Adapter implementation (1 module)

`packages/shared/src/adapters/evm/index.ts` — replace `EvmAdapterStub` with `EvmAdapter implements ChainAdapter`. Methods:

| `ChainAdapter` method | EvmAdapter impl |
|---|---|
| `readEndpointConfigs()` | viem `getLogs({ event: EndpointRegistered, fromBlock: deploymentBlock })` → unique slugs → `multicall` of `registry.endpoints(slug)` → `decodeEndpointConfig`. |
| `submitSettleBatch(input)` | `encodeSettleBatch(events)` → `walletClient.sendTransaction({ to: settlerAddr, data, ...gas })` → wait-loop per D6 §5.1 → return `{ txId: receipt.transactionHash, perEvent: [...] }`. |
| `checkAgentEligibility(agent, requiredBaseUnits)` | viem `readContract({ abi: ERC20, address: usdc, fn: 'balanceOf', args: [agent] })` + `readContract({ abi: ERC20, address: usdc, fn: 'allowance', args: [agent, settlerAddr] })`. Map shape to `EligibilityCheckResult`. |
| `tailSettlementEvents?(opts)` | OPTIONAL — `viem.watchContractEvent` (or `getLogs` for the reconcile cron) for `CallSettled` events post-finality. Used for D6 §5.2 hard-reorg detection. WP-MN-04 ships impl; cron daemon optional. |

### Chains.json fill

`packages/program-evm/protocol-evm-v1/config/chains.json` — fill the three currently-null fields for `arc-testnet`:
- `rpcUrl`: Tu provides (Secret Manager or env-only — see RESEARCH §5).
- `blockTimeMs`: `500` (D6 §2).
- `finalityBlocks`: `64` (D6 §2).

### Service Adapter Map registration

`packages/{settler,indexer}/src/adapters/adapters.service.ts` + `packages/market-proxy/src/lib/context.ts buildAdapterMap()` — when `PACT_ENABLED_NETWORKS` contains `arc-testnet`, construct the real `EvmAdapter` (not the stub), load the EVM signer from Secret Manager, register in the Map.

### Settler EVM signer wiring

`packages/settler/src/submitter/submitter.service.ts` — the EVM branch of `submit()` needs a viem `WalletClient` per EVM network. The settler's existing `secret-loader` extends to load `pact-settler-<network>` for any `vm: 'evm'` network. Signer rotation procedure per D6 §6.

### Indexer dedup + reorg-rollback

`packages/indexer/src/events/events.service.ts` — change ingest lookup from `(signature, callId)` to `(network, callId)` per D6 §4. Schema already supports this (WP-MN-03a).

`packages/indexer/src/reorg/` — new module with reconcile-tail consumer (D6 §5.2) and operator CLI `reorg:rollback`. Reads `tailSettlementEvents` from EvmAdapter. Audit view migration: read-only `settlement_reorg_audit` view in Prisma schema (local-docker-only per Tu's directive; production migration is a separate ops step).

### Market-proxy ERC-20 balance read

Already covered by `EvmAdapter.checkAgentEligibility`. No proxy-side changes beyond the adapter Map registration above.

### Tests

- **Adapter contract conformance** — `packages/shared/test/evm-adapter-contract.test.ts` re-runs the same shape tests as `solana-adapter-contract.test.ts` against `EvmAdapter`. Asserts all required methods present + reject on `descriptor.vm !== 'evm'`.
- **EvmAdapter unit tests** — mocked `publicClient`/`walletClient` (viem `createPublicClient({ transport: custom })`). Covers: settle-batch wait-loop (depth threshold), gas estimation fallback path, revert-reason decoding, balance/allowance dispatch.
- **Indexer dedup change** — replays a finalized event under a different `signature` (simulating an EVM reorg-replay scenario); asserts second ingest returns 200 idempotent and DB has ONE row, not two.
- **Multi-network smoke** — settler boots with `PACT_ENABLED_NETWORKS=solana-devnet,arc-testnet`; both adapters instantiate; a synthetic SettlementEvent with `network='arc-testnet'` routes to EvmAdapter and (in unit test) succeeds with stubbed RPC.
- **End-to-end on Arc Testnet** — gated behind the Tu-authorized fleet-boot step. Defined as a runbook, not an automated test (live testnet RPC + spend). Acceptance: agent call → premium debit → settle → indexer row → read API.

## Out of scope

- **0G, Base, mainnet, or any chain other than Arc Testnet** — WP-MN-04 ships ONE EVM network. Adding a second is "edit `chains.json` + grant role + secret + Cloud Run env" — but each new chain needs its own `finalityBlocks` decision per D6 §7.
- **Mainnet flip for Solana** — separate audit-gated cycle per `docs/audits/2026-05-05-mainnet-readiness.md`.
- **Removal of `PACT_LEGACY_DIRECT_SOLANA` flag + legacy paths** — WP-MN-03b ships the flag; cleanup is a separate WP "1 week after WP-MN-04 Gate B" per plan-level PR-R6.
- **Auto-rollback daemon for hard reorgs** — D6 §5.2 explicitly: manual operator CLI only in WP-MN-04. Auto deferred 6 months.
- **EIP-4361 (SIWE) ops-signature verify** — D6 §6 locks EIP-191 personal-sign for v1.
- **Edits to deployed Arc contracts** — frozen. Use the WP-EVM-07-verified deployment.
- **Edits to the legacy Anchor crate** — frozen.
- **Production DB migration of `OperatorAllowlist.walletPubkey VARCHAR(44) → VARCHAR(64)`** — schema change applies to local docker only per Tu's directive; production deploy is a separate ops step.

## Non-negotiables

1. **D6 reorg/finality policy is the source of truth.** Any RESEARCH or implementation detail that contradicts it is wrong and amends to match.
2. **No production-DB write from this WP.** Local docker postgres only.
3. **No remote pushes during execution.** Branch pushes for PRs happen at Gate B close.
4. **No edits to the deployed Arc contracts.** The on-chain `SETTLER_ROLE` grant is the only on-chain action; it's Tu-signed, not captain-proxy-signed.
5. **No edits to the legacy Anchor crate.**
6. **Live Solana traffic must NOT regress.** Solana settlement continues to work whether `arc-testnet` is enabled or not. The existing test suite is the proof.
7. **The Cloud Run env update + Secret Manager secret + on-chain role grant are PRE-T1 prerequisites that Tu owns.** Captain-proxy ships the code; Tu ships the fleet.

## Gate-A entry criteria

Satisfied by this CONTEXT + the companion `mn-04-RESEARCH.md` + the D6 policy doc:

- [x] WP-MN-03b Gate B closed and merged (commit `d093945`).
- [x] D6 reorg/finality policy doc written: `docs/evm/2026-05-20-reorg-policy.md`.
- [x] D6 covers: per-VM finality semantics, Arc `finalityBlocks=64` decision + rationale, EIP-1559 gas strategy, `(network, callId)` idempotency change, settler EOA secret model, manual reorg-rollback procedure.
- [x] EvmAdapter surface enumerated per `ChainAdapter` method (CONTEXT §"Adapter implementation" + RESEARCH §3).
- [x] Settler EOA key rotation procedure documented (D6 §6).
- [x] Gas estimation strategy decided (D6 §3: EIP-1559 primary, legacy fallback, +20% maxFeePerGas, +30% gasLimit).
- [x] `finalityBlocks=64` for Arc Testnet decided (D6 §2).
- [x] WP-MN-03b carry-forwards addressed in RESEARCH.
- [ ] Captain VERDICT APPROVED — pending Tu authorization before T1 executes.

## Captain expectations of Gate-A verdict

Captain (or proxy) reads `mn-04-RESEARCH.md` and `docs/evm/2026-05-20-reorg-policy.md` and confirms:

- Every `ChainAdapter` method has a concrete viem mapping in RESEARCH §3.
- The settler wait-loop algorithm matches D6 §5.1 exactly.
- The indexer dedup change is one specific code site (`EventsService.ingest`) and the migration impact is documented.
- The reorg-rollback CLI scope is operator-tool-only (no daemon), per D6 §5.2.
- The Cloud Run + Secret Manager provisioning plan lists every secret name, env var, and role grant — Tu can execute it as a checklist.
- The end-to-end smoke acceptance criteria are testable (the runbook).
- No production-DB write is implied by any task.
- The 6-task sub-breakdown (T1..T6) is well-sized and ordered.
