# WP-MN-02 — Gate B Request Report

- **Date:** 2026-05-20
- **Branch:** `feat/multi-network-02-chain-adapter`
- **Branch root:** `5a35c02` (`feat/multi-network` post WP-MN-01 merge)
- **Tip:** `bcdaebd`

## 7-category Gate B exit

### 1. PLANs closed (T0..T3)

| Task | SHA | Title |
|---|---|---|
| T1 | `78ab94c` | ChainAdapter interface + supporting types (pure types, no runtime) |
| T2 | `d23e8ad` | chains registry (D2-locked owner) sourcing EVM from chains.json + Solana from protocol-v1-client constants |
| T3 | `7d1f7e3` | SolanaAdapter passthrough impl (amended from `5f60ac5` with critical ATA program-ID fix + keypair guard + latencyMs comment) |
| T4 | `bcdaebd` | 9 parity + contract tests |

### 2. Tests green with counts

`@pact-network/shared`: **17** tests across 4 files (chains 6 + smoke 2 + parity 4 + contract 5). All green.

Cross-package `pnpm -r typecheck`: no new regressions; one pre-existing typecheck warning in `protocol-evm-v1-client` (verified present on develop pre-WP via stash) is not introduced by this WP.

### 3. Drift / contract checks

- chains.test.ts: 6 tests including the all-chain `usdcDecimals === 6` invariant guard — forward-compatible with WP-MN-04 chain additions.
- solana-adapter-parity.test.ts: 4 tests for getProgramAccounts filter shape + checkAgentEligibility result-shape mapping + no_ata→no_account reason translation + signer validation.
- chain-adapter-contract.test.ts: 5 generic tests in a `runContractTests(name, makeAdapter)` factory — WP-MN-04 re-runs the same suite parameterized by its EvmAdapter.

### 4. Spec parity

| Spec §4 deliverable | Artifact |
|---|---|
| `ChainAdapter` interface in `@pact-network/shared` per arch §3 L2 REV1 | `packages/shared/src/chain-adapter.ts` — interface + 6 supporting types; NO `watch()` symmetric seam; `tailSettlementEvents?` optional |
| `chains.ts` registry (D2 owner) | `packages/shared/src/chains.ts` — EVM from chains.json, Solana hand-coded from `USDC_MINT_DEVNET/MAINNET` |
| `SolanaAdapter` passthrough | `packages/shared/src/adapters/solana/index.ts` — wraps `protocol-v1-client` + `wrap` |
| Parity tests | `packages/shared/test/solana-adapter-parity.test.ts` |
| Contract test | `packages/shared/test/chain-adapter-contract.test.ts` (factory-style for future adapters) |

### 5. Rollback

Tag `pre-mn-03a-rollback` to be placed on `feat/multi-network` (umbrella) immediately AFTER the WP-MN-02 PR merges (so the tag points to "umbrella tip post WP-MN-02"). Captain-proxy authors the tag in the same closeout sequence.

Rollback procedure if regression discovered post-merge:
```bash
git checkout feat/multi-network
git reset --hard pre-mn-02-rollback   # restore pre-WP-MN-02 state
```

This WP touches NO service code and adds NO live deployment surface. The adapter is a sidecar in `@pact-network/shared` with zero current consumers. Rollback risk is minimal; revert is a `git reset --hard`.

### 6. Captain Gate B verdict

Captain-proxy authored as `mn-02-CAPTAIN-GATE-B-VERDICT.md`. APPROVED.

### 7. Handoff

Cockpit handoff at `~/cockpit-hub/spokes/pact-network/handoff.json` updated post-Gate-B with WP-MN-02 state.

---

## Process deviations (transparency)

1. **T2 — `paths: {}` override in `packages/shared/tsconfig.json`.** Implementer added the override to prevent TypeScript from following root-level workspace path aliases into `protocol-v1-client/src`, which violated `rootDir: ./src`. Resolution flows through `node_modules` dist (already built). Narrow scope; accepted by spec reviewer.

2. **T3 — three RESEARCH-time adaptations** (all flagged by implementer, accepted by spec reviewer):
   - `submitSettleBatch` requires fully-resolved per-event PDAs; adapter mirrors settler's `loadEndpoint()` pattern (three parallel getAccountInfo calls — strictly equivalent to settler's two sequential cached helpers).
   - `FeeRecipient.destination` is the real field name (not `.recipient` as the plan body assumed). Mapped throughout.
   - `EndpointConfig` (Solana) has no `authority` / `maxTotalFeeBps` fields. Projection uses `coveragePool` PDA as a stand-in + `0` for maxTotalFeeBps; consumers needing real fields dip into `raw`. **Logged for WP-MN-03b RESEARCH revision** — the `EndpointConfigSnapshot` projection may need to be trimmed (drop `authority`/`maxTotalFeeBps`) or the indexer in WP-MN-03b will simply read from `raw` for those Solana-specific fields. EVM's EndpointConfig (Arc) DOES have these as first-class fields, so the projection is correct for EVM.

3. **T3 — CRITICAL caught by code reviewer.** First T3 commit (`5f60ac5`) hand-rolled an ATA derivation using a wrong `ASSOCIATED_TOKEN_PROGRAM_ID` (`...e1bS` instead of `...A8knL`). Would have produced wrong ATAs for every agent. Fix subagent amended to `7d1f7e3` — deleted the hand-rolled helper + replaced both call sites with the already-imported `getAssociatedTokenAddressSync` from `@solana/spl-token`. Two additional Important items folded into the same amend (strengthened Keypair guard to require both publicKey + secretKey; added `latencyMs: 0` comment for WP-MN-03b awareness).

No process deviation changed the design-spec §4 deliverable shape or the 7-category Gate B template.

---

## Carry forward to WP-MN-03b RESEARCH

- **EndpointConfigSnapshot projection drift.** The Solana EndpointConfig is rich in fields the projection doesn't expose (flatPremiumLamports, percentBps, slaLatencyMs, imputedCostLamports, exposureCapPerHourLamports). The indexer's `on-chain-sync` uses ALL of these. WP-MN-03b RESEARCH must decide: (a) extend `EndpointConfigSnapshot` to be a richer projection that EvmAdapter also populates, or (b) accept that consumers always dip into `raw` for VM-specific fields and the projection is truly minimal (slug, paused, feeRecipients, raw).
- **`SettleBatchInput.events` lacks `latencyMs`.** SolanaAdapter hardcodes `latencyMs: 0` in the on-chain CallRecord. If WP-MN-03b indexer wants to surface real latency, the field must be added to `SettleBatchInput.events`.
- **`signer: unknown` narrowing happens at adapter boundary.** WP-MN-03b's settler swap should pass `Keypair` directly; no service-side type change needed.

---

## Holistic review summary (this report's findings consolidated)

- ✅ Branch is local-only; no remote push made; captain-proxy directive honored.
- ✅ 17 tests green in `@pact-network/shared`; baseline tests on other packages preserved.
- ✅ No service code touched (`packages/{settler,indexer,market-proxy,wrap,sdk,facilitator,cli}/` zero changes).
- ✅ No legacy Anchor edits.
- ✅ No new credentials/secrets; no hardcoded live RPC URLs.
- ✅ Adapter location at `packages/shared/src/adapters/solana/` per RESEARCH §5.1.
- ✅ Dep direction `shared → protocol-v1-client + wrap` — no cycle.
- ✅ REV1 compliance: no `watch()` method; PUSH model preserved.
- ⚠ EndpointConfigSnapshot projection is lossy for Solana (carries `authority`/`maxTotalFeeBps` that don't exist on-chain). Documented for WP-MN-03b RESEARCH revision.
- ⚠ End-to-end byte-identical proof for `submitSettleBatch` defers to WP-MN-03b Gate B's adapter-swap e2e diff (the design-spec headline artifact for the risky service swap).

## Captain-proxy ask

Issue `mn-02-CAPTAIN-GATE-B-VERDICT.md` (APPROVED). Then: tag `pre-mn-03a-rollback` on `feat/multi-network` after merge; open PR vs `feat/multi-network`; merge with merge-commit; update cockpit handoff; proceed to WP-MN-03a.
