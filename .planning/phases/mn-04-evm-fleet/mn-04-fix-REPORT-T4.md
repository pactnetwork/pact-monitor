# MN-04 EVM settle-path fix-WP — Task 4 REPORT (finding 3 fully wired)

**Crew:** crew-1
**Branch:** `fix/mn-04-evm-settle-path`
**Date:** 2026-05-22
**Scope:** Task 4 — wire the EVM/Solana cross-mode auth guard in `index.ts` so finding 3 is fully implemented in prod (not deferred).
**Status:** DONE. e2e still 8-of-8. Cross-mode guard active in prod via `createApp`. Solana auth unchanged.

---

## 1. Commit

| Commit | What changed |
|---|---|
| `236b1bc` | `feat(market-proxy): wire EVM/Solana cross-mode auth guard in createApp (mn-04 fix-WP T4, finding 3 complete)` |

Files: `packages/market-proxy/src/index.ts` (wiring + comment + testability extraction), `packages/market-proxy/test/index-wiring.test.ts` (new wiring test). No other files.

---

## 2. The index.ts change (diff)

The resolver is now passed to `verifyPactSignature`, the comment documents the cross-mode behavior, and the app construction was extracted into an exported `createApp(deps)` with `main()` guarded behind an entrypoint check (so the wiring is importable/testable without booting Postgres/RPC/Pub-Sub — `index.ts` eager-parses env via `proxyRoute -> lib/context -> env` and previously auto-ran `main()` on import).

Key lines:
```ts
app.use(
  "/v1/:slug/*",
  verifyPactSignature({
    getEndpointNetwork: async (c) =>
      (await deps.registry.get(c.req.param("slug") ?? ""))?.network,
  }),
);
```
```ts
const isEntrypoint =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) { main().catch(...); }
```
Full diff: `git diff e703793 HEAD -- packages/market-proxy/src/index.ts` (also pasted at the end of this report).

Behavior in prod: `registry.get(slug)` resolves the endpoint's `network`; the middleware rejects an agent whose VM doesn't match (a 0x agent on a Solana endpoint, or an Ed25519 agent on an EVM endpoint). A Solana agent on a `solana-devnet` endpoint still matches — no regression for today's all-Solana registry. Unknown slug -> `undefined` -> falls back to key-format selection (proxyRoute 404s downstream). The captain's correction was right: this does not defeat finding 3 — the e2e mounts `verifyPactSignature()` directly (no resolver), so wiring `index.ts` cannot affect it, and there are no EVM agents in prod today to wrongly reject.

---

## 3. New wiring test (the REAL createApp)

`packages/market-proxy/test/index-wiring.test.ts` builds the app via the **real** `createApp` (dynamic-imported after stubbing the 7 required env vars) with a **real** `EndpointRegistry` over a fake `pg.query` returning both an `arc-testnet` (`arc-ep`) and a `solana-devnet` (`sol-ep`) endpoint. 5 tests, all pass:

```
✓ EVM agent (0x / EIP-191) on an arc-testnet endpoint authenticates
✓ Solana agent (Ed25519) on a solana-devnet endpoint authenticates (regression)
✓ cross-mode: EVM 0x agent on a solana-devnet endpoint -> 401 (pact_auth_bad_sig)
✓ cross-mode: Solana Ed25519 agent on an arc-testnet endpoint -> 401 (pact_auth_bad_sig)
✓ no x-pact-agent (dashboard demo) passes through unauthenticated
```

The two cross-mode cases prove the resolver wiring end-to-end (slug -> registry -> network -> reject mismatch). The authenticated/no-agent cases assert `status !== 401` (auth let the request through to proxyRoute, which then 500s on the uninitialized global `AppContext` — that is expected and not an auth failure, mirroring the e2e #1 `expect(status).not.toBe(401)` contract). Signing uses a current `Date.now()` because `createApp` wires the real clock.

---

## 4. e2e still 8/8 (gate not weakened)

```
$ pnpm --filter @pact-network/settler exec vitest run arc-testnet-settle-e2e
  Tests  8 passed (8)

$ git diff e703793 -- packages/settler/test/arc-testnet-settle-e2e.spec.ts
  (empty)
```
The acceptance test was not touched in Task 4; #1 stays green. The `index.ts` wiring has no effect on the e2e (it mounts `verifyPactSignature()` directly with no resolver).

---

## 5. Market-proxy suite — before/after (pre-existing failures isolated)

```
Before T4: Test Files 1 failed | 20 passed (21)  |  Tests 3 failed | 157 passed (160)
After  T4: Test Files 1 failed | 21 passed (22)  |  Tests 3 failed | 162 passed (165)
```
- **+5 tests, all passing** = the new `index-wiring.test.ts`.
- **The 3 failures are unchanged** — still exactly `test/endpoints.test.ts` (EndpointRegistry / Postgres) failing with `TypeError: Cannot convert undefined to a BigInt`. Pre-existing (confirmed in T3 by stashing changes); unrelated to auth. Count unchanged at 3, same file.
- `verify-signature.test.ts`: 22/22 still green (16 original Solana + 6 EVM/cross-mode from T3).

Settler suite unchanged: `Test Files 13 passed (13) | Tests 86 passed (86)` (e2e 8/8).

market-proxy `typecheck`: clean (0 errors) after fixing the `c.req.param("slug")` `string | undefined` with the same `?? ""` guard `proxyRoute` uses.

---

## 6. Notes for the captain

- **Testability extraction:** `createApp(deps)` exported from `index.ts` + `main()` guarded by an entrypoint check. This is slightly more than "wiring + comment", but it is the minimum needed to satisfy requirement #3 ("test the REAL index.ts wiring") given `index.ts` eager-parses env and previously auto-ran `main()` on import. Behavior is unchanged: `main()` builds the same pipeline via `createApp` and still boots when run as the entrypoint (`node dist/index.js` / `tsx src/index.ts`).
- **No prod behavior regression:** today's curated endpoints are all `solana-devnet`; Solana agents continue to match. The guard only starts rejecting once an EVM endpoint is registered in the proxy registry (the intended activation).
- **gitnexus** not run (worktree rule). Impact was manual: `createApp` is new (only `main()` and the new test call it); the `verifyPactSignature` option is additive.

---

## 7. Self-check vs. Task 4

- [x] index.ts passes `getEndpointNetwork: async (c) => (await ctx.registry.get(c.req.param('slug')))?.network`
- [x] index.ts comment documents endpoint.network <-> agent VM cross-mode enforcement
- [x] New test exercises the REAL createApp with a fixture EndpointRegistry (fake pg, both networks) covering all 5 required cases
- [x] e2e still 8/8; acceptance assertions untouched (empty diff)
- [x] Existing 22 verify-signature unit tests green
- [x] market-proxy suite green except the exact pre-existing endpoints.test.ts ×3 (count unchanged)
- [x] Surgical: index.ts wiring + comment + extraction-for-testability + the new test only

---

## Appendix: full index.ts diff

```
$ git diff e703793 HEAD -- packages/market-proxy/src/index.ts
```
(See commit `236b1bc`. Summary: `const app = new Hono()` + inline route/middleware registration moved into an exported `createApp(deps)`; `main()` now calls `createApp` and is guarded by an `isEntrypoint` check; `verifyPactSignature()` -> `verifyPactSignature({ getEndpointNetwork: ... })`; comment block updated to describe cross-mode enforcement.)
