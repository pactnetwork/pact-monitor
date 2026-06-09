# Curated Endpoints — LOCAL Behavior Proof — 2026-05-29

- **Branch:** `chore/curated-endpoints-moralis-covalent` (PR #247 wiring active — DEFAULT_UPSTREAM_BASE has moralis+covalent)
- **Operator:** captain-delegated crew + captain verification (local pnpm workspace)
- **Goal:** register the 7 curated providers on-chain on the testnets we control, then watch the full **register → indexer auto-DB-row → /.well-known discovery** loop, and drive calls.
- **Scope:** operational only — NO source edits, NO commits. On-chain testnet registrations are intentional (Tu-approved; near-permanent, only pausable).

## Verdict: GREEN — register → sync → discover proven symmetric on BOTH EVM chains (arc-testnet + base-sepolia), all 7 curated providers.

---

## 1. On-chain registrations (signer/registry-authority 0x777d569Bd3b0A2De007097A3D7E1687C5E5EB859)

All `registerEndpoint` → PactRegistry `0x056bac33546b5b51b8cf6f332379651f715b889c`, params: flatPremium 10000, percentBps 0, slaLatencyMs 2000, imputedCost 10000, exposureCapPerHour 1000000, fee recipients [treasury 0x777 bps 1000 + affiliate bps 500].

### arc-testnet (chainId 5042002) — 7/7 success
| slug | tx | block |
|------|----|-------|
| helius | `0xd8395728d199c48096e5e1b8a3e20c01ac8dd14a78994dcec28a82e1fea79386` | 44572511 |
| birdeye | `0xa63eb386d2d4aa83f8dc1f43e5a7bfc04129a3079255719a1deb9218bd78df66` | 44572515 |
| jupiter | `0x8881f4436e2853621efc3f67b8648b7415917b17172235788e3e29929f150d1d` | 44572518 |
| elfa | `0x669f51c0ff7869f8858871de35d02703044735f9e5df59df8808b8ba766e01ed` | 44572522 |
| fal | `0x9581788dc46639fc4ed8e6574aa8542a516659e80f486219ac184388956afff6` | 44572533 |
| moralis | `0x0cd5c33246eb63087e011e54aa81d94742301d56776ae62acf8ebeafc10c2240` | 44572544 |
| covalent | `0x18f64a0467188ae600f0fc07c993cbdf4c0d7f61386294914b4bb065b871d45f` | 44572548 |

### base-sepolia (chainId 84532) — 6 new + helius pre-existing
| slug | tx | block |
|------|----|-------|
| helius | SKIP (already registered) | — |
| birdeye | `0x2214be40f3345473034ca8a8828f221e6874075e1a9a3425cfecef309f0c8b85` | 42138961 |
| jupiter | `0x14004b96989f4147e0660091555e2a4f3f6bcce6a2c95dcfafefca37270c7d65` | 42138962 |
| elfa | `0xa69680b48915f9e9e962d8318390e125d2e4713131e5f1597b2ee48918d83230` | 42138963 |
| fal | `0xe06479acc012ff336e647902b81ccb6b0815f3dc11d9346e39a9fd1fcdf9a83f` | 42138965 |
| moralis | `0x0d408e2abf0a1c6bf9d2c6399914dc2bbbed532ba806e8a0a816fb5b289aaf6a` | 42138966 |
| covalent | `0xa713dd65e5bce8a8f25f53d088dee2ce38729fa2cab971fa4199f05380ba5ae4` | 42138967 |

Captain spot-verified (RPC `getTransactionReceipt`): arc `jupiter` + base `covalent` → status success, to=PactRegistry, EndpointRegistered event log. All consistent.

## 2. Auto-DB-row sync (indexer OnChainSyncService, 5-min cursor path)

Final DB counts (curated slugs): **arc-testnet = 7, base-sepolia = 7**, solana-devnet = 1 (pre-existing helius).

The indexer auto-materialized every registered endpoint with the correct `upstreamBase` pulled from `DEFAULT_UPSTREAM_BASE` (the #247 wiring), e.g.:
- moralis → `https://deep-index.moralis.io`
- covalent → `https://api.covalenthq.com`
- jupiter → `https://api.jup.ag`, birdeye → `https://public-api.birdeye.so`, helius → `https://mainnet.helius-rpc.com`, elfa → `https://api.elfa.ai`, fal → `https://queue.fal.run`

**base-sepolia sync timing (NOT a bug):** the boot sync (16:20) preceded the registrations; the cursor caught up over ticks — 42138603 → 42138800 → 42138956 → (16:40) **42139178**, crossing the registration blocks (42138961–42138967) and upserting the 6 new endpoints. arc caught up one tick earlier. Cursor-lag behind finality, self-healing.

## 3. /.well-known/endpoints discovery

`GET http://localhost:3003/.well-known/endpoints` returned all 7 curated providers on arc-testnet (fal, moralis, covalent, helius, birdeye, jupiter, elfa) + helius/dummy on solana-devnet + helius on base-sepolia (queried before base caught up; base now lists all 7 too). Hostnames resolve per provider (e.g. covalent → `api.covalenthq.com` + `api.goldrush.dev`; jupiter → `api.jup.ag` + `lite-api.jup.ag` + `quote-api.jup.ag`).

## 4. Per-provider behavior matrix

| Provider | Registered (arc/base) | Synced→DB | In well-known | Call behavior |
|----------|----------------------|-----------|---------------|---------------|
| jupiter | ✅/✅ | ✅/✅ | ✅ | **keyless → real 200 → premium → on-chain settle** (proven earlier: arc `0x0806…`, base `0xc480…`) |
| helius | pre/pre | ✅/✅ | ✅ | key-gated → 401/zero-premium without `PACT_HELIUS_API_KEY` |
| birdeye | ✅/✅ | ✅/✅ | ✅ | key-gated (caller `X-API-KEY` passthrough) |
| moralis | ✅/✅ | ✅/✅ | ✅ | key-gated (caller `X-API-KEY` passthrough) |
| covalent | ✅/✅ | ✅/✅ | ✅ | key-gated (caller `Authorization: Bearer`) |
| elfa | ✅/✅ | ✅/✅ | ✅ | ⚠️ strips caller auth, NO operator-key injection → cannot 200 yet |
| fal | ✅/✅ | ✅/✅ | ✅ | ⚠️ same gap as elfa |

## 5. Items for Rick / follow-up
1. **elfa + fal secret-injection gap:** handlers strip caller auth but don't read an operator key env var. Need a small handler change (read e.g. `PACT_ELFA_API_KEY` / `PACT_FAL_API_KEY`, inject the header) before they can go live with a proxy-held secret.
2. **solana-devnet registration: NOT done this run** — needs `ProtocolConfig.authority` confirmation + pre-allocated pool vaults per endpoint, and FS9 blocks devnet settle regardless (pre-mainnet redeploy item). Mainnet `5bCJ` registration is Rick's (see `.planning/endpoint-registration-plan.md`).
3. **Production premium / fee-recipient values** remain a product decision (test values 10000/bps used here).

## 6. Teardown
- `pact-pg-curated` removed; smoke indexer/proxy/settler processes killed.
- `pact-redis-smoke` + `oneplan-postgres` (5433) left untouched.
- git working tree: only `.planning/` untracked, no modified source.
- On-chain registrations left in place (intentional, testnet, only pausable).
