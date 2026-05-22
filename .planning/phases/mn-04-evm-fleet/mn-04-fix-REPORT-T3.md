# MN-04 EVM settle-path fix-WP — Task 3 REPORT (FINAL)

**Crew:** crew-1
**Branch:** `fix/mn-04-evm-settle-path`
**Date:** 2026-05-22
**Scope:** Task 3 — proxy EVM auth (finding 3). The last fix.
**Status:** DONE. The Arc e2e acceptance gate is **8-of-8 GREEN**. Solana auth path unchanged. Zero settler regression.

---

## 1. Commit

| Commit | What changed |
|---|---|
| `e703793` | `fix(market-proxy): EVM (secp256k1/EIP-191) auth mode in verify-signature (mn-04 fix-WP T3, finding 3)` |

Files: `packages/market-proxy/src/middleware/verify-signature.ts` (production), `packages/market-proxy/test/verify-signature.test.ts` (tests), `packages/market-proxy/package.json` (+`viem` dep), `pnpm-lock.yaml`.

---

## 2. What changed and why

`verify-signature.ts` was Ed25519/bs58-only (`bs58.decode` + `nacl.verify`), so an EVM agent (0x address, secp256k1) always got 401.

- **Auth mode selected by the agent key format:** `isAddress(agent)` → EVM (EIP-191), else Solana (bs58/Ed25519). A `0x` agent now verifies via viem `verifyMessage` (recover signer over the **same canonical `v1` payload** the Solana path builds) — no hand-rolled secp256k1. Anything not a 0x address stays on the **unchanged** Ed25519/bs58/nacl path.
- **Cross-mode guard (optional):** new `getEndpointNetwork?(c)` resolver. When the endpoint network is known, an agent whose VM (`networkToVm`: `solana-*` → solana, else evm) doesn't match the endpoint is rejected (0x on a Solana endpoint, or Ed25519 on an EVM endpoint).

### Why selection is by agent format (matching the frozen gate)
The e2e #1 mounts `verifyPactSignature()` with **no** endpoint context (the proxy resolves the endpoint *after* auth, in `proxyRoute`), and signs with a real 0x agent. So the selector that satisfies the frozen gate is the agent key format. The cross-mode guard is the "selected by endpoint.network" half: it activates when the network is supplied. This matches the e2e's contract exactly — it signs `AGENT_ACCOUNT.signMessage({ message: buildSignaturePayload(...) })` and sends `x-pact-agent: <0x address>`, which the middleware verifies with the same `payload` + viem.

### Why prod `index.ts` wiring of the cross-mode resolver is deferred (deliberate)
The proxy registry's curated endpoints are all `network = "solana-devnet"` today (EVM endpoints are registered via `cast`, out of scope per the plan). Wiring `getEndpointNetwork` against that registry now would reject every EVM agent (endpoint resolves to Solana) — defeating finding 3. So the guard is **opt-in via the resolver, fully unit-tested, ready to wire** once the proxy registry carries EVM endpoints. `index.ts` is unchanged; EVM agents authenticate by key format in prod today.

---

## 3. e2e RED→GREEN (before/after)

`arc-testnet-settle-e2e.spec.ts` (8 tests):

| | passed/total | RED |
|---|---|---|
| After Task 2 | 7/8 | #1 auth (finding 3) |
| **After Task 3** | **8/8** | none |

#1 (`authenticates a 0x / secp256k1 (EIP-191) agent through the real proxy auth middleware`) is GREEN — driven by the REAL `verifyPactSignature` on a real Hono app with a real EIP-191 signature. The whole acceptance gate now passes.

---

## 4. Full suite results

```
@pact-network/market-proxy: Test Files 1 failed | 20 passed (21)
                            Tests 3 failed | 157 passed (160)
   verify-signature.test.ts: 22/22 passed (16 original Solana + 6 new EVM/cross-mode)

@pact-network/settler:      Test Files 13 passed (13)
                            Tests 86 passed (86)   <- e2e 8/8; zero regression
```

**The 3 market-proxy failures are pre-existing and environmental, NOT a Task 3 regression.** They are all in `test/endpoints.test.ts` (EndpointRegistry / Postgres) failing with `TypeError: Cannot convert undefined to a BigInt`. With my Task 3 changes stashed, the same 3 fail (`3 failed | 1 passed`). Unrelated to auth or the `viem` dep.

---

## 5. Solana-auth-unchanged proof + cross-mode tests

**Solana path untouched** — all 16 original `verify-signature.test.ts` tests pass: happy-path Ed25519, no-agent no-op, missing headers, skew, replay, body/path tamper, wrong pubkey, malformed/wrong-length signature. The Solana branch in the middleware is byte-for-byte the original (`bs58.decode` + length check + `nacl.sign.detached.verify`).

**New tests (6):**
- `EVM agent (0x / EIP-191) authenticates and verifiedAgent is the 0x address`.
- `EVM agent with a tampered signature → 401`.
- `Solana Ed25519 agent still authenticates against a solana-devnet endpoint (regression)`.
- `EVM agent authenticates against an arc-testnet endpoint (matching VM)`.
- **cross-mode** `0x agent on a solana-devnet endpoint → 401`.
- **cross-mode** `Ed25519 agent on an arc-testnet endpoint → 401`.

---

## 6. Acceptance gate not weakened

```
$ git diff 43c6fde -- packages/settler/test/arc-testnet-settle-e2e.spec.ts
(empty)
```
The acceptance test was **not touched** in Task 3 — #1 went green purely from the production fix. Seam still never mocked:
```
$ grep -nE "(mock|stub|spyOn).*(submitSettleBatch|encodeSettleBatch)" arc-testnet-settle-e2e.spec.ts
NONE
```

---

## 7. Whole fix-WP — final state

```
e703793  T3 finding 3  EVM auth mode (market-proxy)
43c6fde  T2 finding 5  batch-level network on indexer push (settler)
d24a04b  T1 finding 6  thread exact refund (settler, shared)
cb286fd  T1 finding 4  partition pending by (network, slug) (settler)
a67f55d  T1 finding 1  VM-aware endpoint fee-config load (settler, shared)
69bf45a  T1 finding 2  0x-prefix EVM call ids (settler)
e50f371  T0           failing Arc e2e acceptance gate
```

All 6 of Rick's PR #225 blocking findings are fixed; the real-seam Arc e2e (settler → adapter → encode → indexer + proxy auth) is 8-of-8 GREEN.

---

## 8. Notes for the captain

- **viem** added as a direct `market-proxy` dependency (was only transitive via `@pact-network/protocol-evm-v1-client`; pnpm strict resolution needs it direct for the middleware import and the proxy test).
- **Build-before-test for the e2e:** unchanged from T1 — settler resolves `@pact-network/shared` via dist; run `pnpm -r build` (or `pnpm -r test`) so shared is fresh. (T3 didn't touch shared.)
- **Pre-existing failures (not mine), documented for transparency:** market-proxy `endpoints.test.ts` x3 (Postgres BigInt); indexer `migration-rollback.spec.ts` x4 (needs live Postgres); settler `typecheck` x2 (SettleMessage fixture shape). All confirmed present before this WP; the per-package vitest/jest suites are the gates.
- **gitnexus** not run (worktree corrupts CLAUDE.md/AGENTS.md; pact-network not in local index). Impact was manual: the middleware's only caller is `index.ts` (`verifyPactSignature()` — still valid, new option optional); `c.get("verifiedAgent")` consumers in `proxyRoute` are unaffected (still a string).

## 9. Self-check vs. Task 3

- [x] EVM auth mode (EIP-191 via viem, no hand-rolled secp256k1)
- [x] Solana Ed25519/bs58 path unchanged (16 tests green)
- [x] Cross-mode rejection tested (0x→Solana endpoint, Ed25519→EVM endpoint)
- [x] Matches the e2e's message/canonicalization contract (same `buildSignaturePayload`, agent = 0x address)
- [x] e2e 8-of-8 GREEN; acceptance assertions untouched (empty diff); seam never mocked
- [x] Full market-proxy + settler suites run; only pre-existing/env failures remain
