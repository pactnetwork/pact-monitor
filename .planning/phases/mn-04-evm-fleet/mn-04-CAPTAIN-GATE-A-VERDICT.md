# WP-MN-04 — Captain Gate A Verdict

- **Date:** 2026-05-20
- **Captain:** Tu (out-of-office); verdict issued by **captain-proxy**
- **Verdict:** **APPROVED for Gate A — PAUSED for explicit Tu authorization before T1 begins.**

This is the first WP in the MN track that touches **production-shape infrastructure** (Google Secret Manager, Cloud Run env, an on-chain `SETTLER_ROLE` grant on Arc Testnet). Tu's standing rule — "auto-drive unless it really touches production" — kicks in here. Captain-proxy authored Gate A; T1 execution waits.

---

## Captain-proxy checks

1. **D6 reorg/finality policy doc exists.** `docs/evm/2026-05-20-reorg-policy.md`. Covers per-VM finality semantics, Arc `finalityBlocks=64` decision + rationale (16–32s wait at 250–500ms block time, conservative for first boot), EIP-1559 primary + legacy gasPrice fallback gas strategy, `(network, callId)` idempotency change supersedes `signature`, settler EOA secret model with rotation procedure, manual reorg-rollback CLI. **This is the hard Gate A entry gate from phased plan §7 — satisfied.**

2. **Topology unchanged from WP-MN-03b.** Multi-network-per-service: one settler/indexer/proxy, each `Map<network, ChainAdapter>`. WP-MN-04 just adds `arc-testnet → EvmAdapter` to that map. No new fleet shape. WP-MN-03b plumbing is the load-bearing piece.

3. **EvmAdapter surface enumerated per `ChainAdapter` method.** RESEARCH §3 maps each method to concrete viem + `@pact-network/protocol-evm-v1-client` primitives:
   - `readEndpointConfigs` → `getContractEvents(EndpointRegistered)` + `multicall(endpoints(slug))`.
   - `submitSettleBatch` → `encodeSettleBatch` + `sendTransaction` + D6 §5.1 wait-loop verbatim.
   - `checkAgentEligibility` → ERC-20 `balanceOf` + `allowance` via multicall.
   - `tailSettlementEvents` (optional, for D6 §5.2 hard-reorg reconcile) → `getContractEvents(CallSettled, fromFinalized)` async iterator.

4. **Indexer dedup change is one specific code site.** `EventsService.ingest` changes `findUnique(network, signature, callId)` to `findFirst(network, callId)`. Schema PK stays — storage vs. dedup keys decoupled. D6 §4 verbatim.

5. **Per-VM secret-loader extension is non-invasive.** Solana back-compat preserved (`SETTLEMENT_AUTHORITY_KEY` legacy env honored). New env per network: `PACT_SETTLER_KEYPAIR_<NETWORK>` (or Secret Manager resource path). Returns discriminated union `{vm:'solana', keypair} | {vm:'evm', account, address}`. AdaptersService consumes per-network.

6. **`chains.json` fill plan locks D6 numbers.** `arc-testnet.finalityBlocks=64`, `blockTimeMs=500`, plus `rpcUrl` and `deploymentBlock` (Tu-provided in T1). `ChainDescriptor` interface extends with three new OPTIONAL fields; Solana entries leave them undefined.

7. **Reorg-rollback module is operator-CLI-only.** Per D6 §5.2: WP-MN-04 ships `ReorgService.runReconcile()` + `reorg:rollback` CLI + read-only `settlement_reorg_audit` Prisma view. NO auto-cron daemon. Audit view is **local-docker-only** per Tu's directive; production migration is a separate ops step.

8. **6-task sub-breakdown well-sized.** T1 chains.json + ChainDescriptor; T2 EvmAdapter + contract conformance; T3 indexer dedup + reorg module; T4 secret-loader per-VM + AdaptersService EVM construction; T5 e2e unit test with mocked viem; T6 provisioning runbook + Gate B (Tu-executable). T1..T5 atomic; T6 is the runbook.

9. **Risk register addresses every plan-level concern.** R1 (D6) RESOLVED before T1. R2 (finality) MITIGATED (conservative 64-block default). R3 (cold start) INHERITED from Solana posture. Plus 3 new RESEARCH-surfaced risks (R4 pagination, R5 EIP-1559 refusal, R6 role grant), each with concrete mitigation.

10. **Carry-forwards from WP-MN-03b resolved.** EvmAdapter real impl replaces stub (T2). `EndpointConfigSnapshot.authority` + `maxTotalFeeBps` populated on EVM (RESEARCH §3.1 — closes WP-MN-02 carry-forward for EVM side). `loadEndpoint` cache duplication remains deferred to cleanup WP.

---

## What captain-proxy WILL execute (with Tu authorization)

T1..T5. All atomic code changes against local docker postgres; no remote pushes during execution; subagent-driven-development cadence with two-stage review per task. Estimated 5 tasks × (implementer + spec-reviewer + code-reviewer) ≈ same texture as WP-MN-03b.

## What captain-proxy WILL NOT execute

T6 (fleet boot runbook). This is Tu's checklist (D6 §6 / RESEARCH §8 Phase 1):

1. Generate Arc EOA + fund with testnet gas (Tu owns the private key).
2. `cast send PactSettler.grantRole(SETTLER_ROLE, <addr>)` from Tu's admin EOA on Arc Testnet.
3. Cloud Run revision env updates × 3 services. **`PACT_SETTLER_KEYPAIR_ARC_TESTNET` value is the raw `0x`-hex private key** — no Secret Manager path. (Tu lacks GCP Secret Manager permissions; Rick swaps to a `projects/...` path in a Phase 2 follow-up, no code change needed.)
4. Roll revisions; verify boot logs.
5. Run the end-to-end smoke (register endpoint → top up pool → agent call → indexer row → read API).

Captain-proxy CANNOT do these because:
- Step 1: private-key custody is a Tu decision.
- Step 2: requires Tu's admin EOA signature.
- Steps 3–4: Cloud Run is Tu's deployment surface.
- Step 5: real testnet spend.

**Phase 2 (Rick, post-WP-MN-04, NOT blocking Gate B):** `gcloud secrets create pact-settler-arc-testnet` + add version with the same hex + swap Cloud Run env value from raw hex to the resource path. Code path identical; only the env value changes.

---

## Open questions — ALL LOCKED 2026-05-20

| # | Tu answer |
|---|---|
| 1 | RPC URL — default (`ARC_TESTNET_RPC_URL` from `.env`, public, committed) |
| 2 | Deploy block — **42953139** (from broadcast log) |
| 3 | Settler EOA — reuse `DEPLOYER_PRIVATE_KEY` from `.env`, addr `0x777d569bd3b0a2de007097a3d7e1687c5e5eb859`. Arc Testnet only. |
| 4 | Same key as #3 — one self-grant `grantRole(SETTLER_ROLE, 0x777d56...)` tx in T6 step 1 |
| 5 | Cloud Run min-instances = `1` (default, match Solana) |
| 6 | `PACT_LEGACY_DIRECT_SOLANA=false` on all 3 services day 1 — Option A, adapter on both networks |

RESEARCH §6 / §8 / §13 amended to lock these. **No remaining blockers. T1 may begin.**

---

## Standing instructions

- Implementer is `superpowers:writing-plans` → 6 PLAN sections at `docs/superpowers/plans/2026-05-20-wp-mn-04-evm-fleet.md` → `superpowers:subagent-driven-development` for T1..T5.
- **NO remote pushes** until Gate B closes.
- **Tu owns T6** end-to-end; captain-proxy hands off after T5 with Gate-B-ready branch + the T6 runbook ready to follow.
- Tag `pre-mn-05-rollback` on `feat/multi-network` immediately after WP-MN-04 Gate B + merge.
- Pause-and-escalate on any RESEARCH-contradicting finding (especially: adapter interface needs a new method, D6 algorithm doesn't compile, RPC node refuses both EIP-1559 and legacy gasPrice).

---

## Verdict

**APPROVED.** Captain-proxy paused awaiting Tu authorization on the 6 open questions and explicit go-ahead for T1 to begin.

**Suggested Tu reply if proceeding with defaults:** "go, defaults on all 6". Then captain-proxy answers any RPC-URL/deploy-block placeholders with values you provide and starts T1.
