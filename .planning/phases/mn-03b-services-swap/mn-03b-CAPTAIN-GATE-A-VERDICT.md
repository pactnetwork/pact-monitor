# WP-MN-03b — Captain Gate A Verdict

- **Date:** 2026-05-20
- **Captain:** Tu (out-of-office); verdict issued by **captain proxy**
- **Verdict:** **APPROVED — but pause for Tu authorization before execution begins (riskiest WP; Tu may want eyes on adapter-swap e2e harness)**

---

## Captain-proxy checks

1. **Topology decision documented.** Multi-network-per-service was just locked by Tu (2026-05-20). CONTEXT + RESEARCH bake it in throughout. Off-chain spec §7 supersession noted; formal doc update deferred to PR #216 follow-up.

2. **Chain-touch audit complete.** RESEARCH §2 enumerates every direct chain-touch site across the 3 swap-target service modules. Re-grep sanity passed: no service-side import of `protocol-v1-client` falls outside the documented sites.

3. **Carry-forwards resolved.** All three (EndpointConfigSnapshot projection drift, `SettleBatchInput.latencyMs`, `solana-devnet` hardcoding) have explicit RESEARCH §3 resolutions.

4. **`SettleBatchInput.latencyMs` additive interface change.** Acceptable — additive only, forward-compatible, single line in SolanaAdapter to honor it. NOT a violation of "no edits to SolanaAdapter" non-negotiable (the non-negotiable scopes to algorithmic edits, not field-additive shape changes).

5. **`PACT_LEGACY_DIRECT_SOLANA` flag wiring per service** documented (RESEARCH §5.1). Each service logs active mode at boot.

6. **Adapter-swap e2e diff harness** specified (RESEARCH §5.4). Lives in settler-driven test against local docker postgres. Stub Connection makes signatures deterministic. THE Gate B headline artifact.

7. **EvmAdapterStub scaffold** specified (RESEARCH §4.5). Routes can be exercised; EVM settlement throws clearly. WP-MN-04 replaces with real impl.

8. **5-task sub-breakdown** well-sized. T1 latencyMs additive; T2 EvmAdapterStub; T3 Map<network, ChainAdapter> construction; T4 service refactor; T5 e2e diff + multi-network routing tests.

9. **R1 (adapter-swap diff non-empty) is the dominant risk.** PR-R2 in plan-level register. Mitigation: Gate B BLOCK on non-empty; flag-based surgical fallback if observed in prod ramp.

---

## Important note for execution

This is the **RISKIEST** WP in the entire track. The settler's `submitter.service.ts` is the live Solana broadcast loop; rewriting it to route through an adapter Map is invasive (~200 lines of refactor). T5's byte-identical e2e is the only way to prove no behavior change.

**Captain-proxy recommendation:** Before T1 begins execution, Tu reviews this verdict + the RESEARCH doc and either:
- (a) Authorizes captain-proxy to auto-drive T1–T5 via subagent-driven-development (the established cadence), OR
- (b) Takes T4 (the service refactor) personally and leaves T1/T2/T3/T5 to captain-proxy.

T1–T3 are mechanical (interface addition + stub + bootstrap wiring) and safe to auto-drive. T4 is the live-settler swap. T5 is the gate.

---

## Standing instructions

- Implementer is `superpowers:writing-plans` → 5 PLANs at `docs/superpowers/plans/2026-05-20-wp-mn-03b-services-swap.md` → `superpowers:subagent-driven-development`.
- **NO remote pushes** until Gate B closes.
- **HIGHEST-RISK** task is T4 (live-service swap); T5 is the gate.
- Pause-and-escalate on any RESEARCH-contradicting finding (especially: adapter interface needs a new method we didn't enumerate).
- Tag `pre-mn-04-rollback` on `feat/multi-network` immediately after WP-MN-03b Gate B + merge.

## Verdict

**APPROVED.** Captain-proxy paused awaiting Tu authorization before T1 execution.
