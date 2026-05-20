# Multi-Network — READ FIRST (decision & action memo)

- **Date:** 2026-05-19 (decisions locked 2026-05-20)
- **For:** Rick (decision check / 0G timing) + Ken (implement)
- **Status:** specs DRAFT (independently reviewed + REV1-corrected); **all 6 blocking decisions LOCKED by the captain on 2026-05-20** — send-ready

This is the cover page for two specs. It carries the locked decisions and tells Ken **what he can start now vs what's waiting on confirmation**. Read this first; the two specs are the detail.

---

## TL;DR

The Arc EVM port is done and proven. There are now **3 networks built 3 different ways** (Solana original, Arc parity port, 0G a full standalone fork). Left alone this becomes N-codebases. The two specs define **one chain abstraction** so the project supports many networks with config, not forks. Both the core decision (Arc 3-contract set canonical; 0G's `PactCore` retires) **and** the six surrounding decisions are now **LOCKED** — Ken can start the non-gated phases; Rick's-eyes asks are limited to confirming D3 (0G PR #206 merge gating) and operational sign-off.

---

## What to READ (in order, ~25 min)

1. **This memo** — the decisions.
2. **`docs/evm/2026-05-19-multi-network-architecture-spec.md`** — the model: the locked decision (§0), the 3-layer architecture (§3), package layout, DB, 0G reconciliation (§7), the blocking decisions (§11). Read §0, §3, §7, §11, §12.
3. **`docs/evm/2026-05-19-multi-network-offchain-services-spec.md`** — the off-chain detail: proxy/settler/indexer/dashboard, the one wire change (§2.2), runtime model (§2.4), per-VM auth & reorg (§2.5–2.6), the greenfield dashboard lift (§5a). Read §2, §5, §5a, §8.

(Both carry a **REV1** note at the top: an independent review found 5 real gaps; they're fixed. The note documents what changed.)

---

## Acceptance criterion (Rick, 2026-05-20)

**Every supported network reaches functional parity with the current Solana off-chain stack** — proxy, settler, indexer, read API, dashboard, ops — **EXCEPT pay.sh** (x402 facilitator, Solana-only for v1; not yet ported to other networks). Anything Pact does today on Solana, it does on Arc / 0G / future EVM chains, via the same backend endpoints, routed by the new `+network` field on the wire.

## SDK ↔ off-chain (how it wires together)

The Agent SDK (`@pact-network/sdk`) is **not** independent of the off-chain stack — it depends on it. Multi-network does **not** introduce new SDK endpoints; it reuses the existing ones, each now multi-network:

- `wrap.SettlementEvent` gains `+network` (one additive field — architecture §3 L2, off-chain §2.2). The SDK and `market-proxy` stamp it; the queue and `settler` route on it.
- The SDK's auto-provision path (`POST /pools/provision`) and call-record push (`POST /events`) hit the same backend, with `+network` carried through. Per Ken's external draft, those endpoints already exist for Solana.
- The indexer read API (`/api/agents/:pubkey`, `/api/calls/:id`, `/api/endpoints`, `/api/stats`) becomes multi-network by accepting `?network=`. The dashboard and the SDK's `pact.stats()` / `pact.policy()` reads aggregate across networks by default and filter on demand.
- The `core` extraction in Ken's SDK seats the `ChainAdapter` interface at the chain-touch seam (D5) — so a Solana SDK call and an Arc SDK call go through the same `core` code path with the adapter selected by `descriptor.vm`.

Net: Ken needs both specs to ship the SDK. P1+P2 (contracts + adapter scaffold) are his immediate work; P3 (off-chain `+network` + DB column + Solana refactor) is the bridge that makes the SDK multi-network end-to-end.

## Decisions — LOCKED 2026-05-20

| # | Decision | Status |
|---|---|---|
| **D1 — A2** | One chain abstraction org-wide vs per-chain forks | **DECIDED: one abstraction (adopt the spec).** No new per-chain forks. |
| **D2 — A8** | Who owns the network registry | **DECIDED: `@pact-network/shared`/`core` owns it; the SDK consumes it.** |
| **D3 — 0G timing** | Reconcile the 0G fork before or after PR #206 merges | **DECIDED (Rick, 2026-05-20): defer 0G entirely — the network is too new to invest in now.** PR #206 stays open for hackathon visibility but is **NOT** merged or integrated; the 0G `PactCore` design is retired (architecture §0). When 0G matures, it slots in via `chains.json` as just another EVM chain — "0G is EVM, in theory it should be portable" (Rick). Full fork-set reconciliation is **deferred indefinitely**, not gated on a near-term ticket. |
| **D4 — Parametric on EVM** | EVM chains carry parametric (insurance/claims) too, or rails-only? | **DECIDED: rails-only on EVM for v1.** Parametric stays Solana-only; additive sub-interface only if real demand surfaces. Verified: Pinocchio v1 + Arc + 0G all expose the same rails verbs (`register_endpoint`/`settle_batch`/`top_up_coverage_pool`); parametric verbs (`enable_insurance`/`submit_claim`/`update_rates`) live only in the frozen Anchor `pact-insurance` crate + unshipped `pact-network-v2-pinocchio`. |
| **D5 — SDK coupling** | Chain adapter at the `core` seam in Ken's SDK | **DECIDED: precondition of SDK M0.** Ken must confirm/correct §8 against his actual draft (external `~/Downloads` artifact, not in repo). |
| **D6 — Reorg policy** | Per-VM finality / reorg-rollback policy | **DECIDED: hard gate before any EVM fleet goes live** (P4 entry criterion). |

Plus the standing rule re-confirmed: **the legacy Anchor `pact-insurance` crate (`2Go74e…`) is FROZEN — no edits, no builds, no tests, no IDL work, do not propose it as the target of any new design.** Pinocchio (Solana) and the Arc 3-contract Solidity set (EVM) are the canonical surfaces.

---

## What Ken does now

**Can start immediately (D1–D2/D4/D6 already locked):**

- Read this memo + both specs in the order below.
- **P1** — generalize the EVM package: rename `ArcConfig.sol` → `ProtocolInvariants.sol`, move chain values into `config/chains.json`, make `Deploy.s.sol` chain-agnostic (preserves the live USDC-decimals deploy guard). Note this also touches `protocol-evm-v1-client/src/constants.ts` and the deploy/verify script — not contract logic, but **not zero-risk** (Gate B = decimals guard preserved).
- **P2** — scaffold the `chain-adapters` package: `ChainAdapter` interface in `@pact-network/shared`, implement `SolanaAdapter` first (pure wrapper over `protocol-v1-client` — byte-identical behavior), regression-tested against the existing client suite.
- Confirm/correct §8 of the architecture spec against his actual SDK draft (the draft is an external `~/Downloads` HTML, not in the repo). If §8's assumption about the `core` extraction is wrong, raise it before P2 lands.

**Sequenced after P1+P2 (captain-gated):**

- **P3** — `SettlementEvent +network` + DB `network` migration + refactor `submitter`/`on-chain-sync`/proxy `balance` to the Solana adapter (riskiest — touches live Solana settlement; Gate B = byte-identical e2e + documented rollback).
- **P4** — wire the EVM adapter; stand up the first non-Solana fleet (Arc) end-to-end on testnet; the per-VM `ops` + dashboard EVM wallet stack (§5a, greenfield, its own milestone).
- **P5** — 0G reconciliation is **deferred** per Rick (above); no near-term work.
- **D5 / SDK `core` seam** lands when Ken's SDK milestones reach the `core` extraction step; the precondition is captured.

## Rick's stance (2026-05-20)

Green-lit. No remaining architectural sign-off — all six decisions locked. Heads-up only: 0G is deferred (PR #206 stays open as a hackathon artifact), and the dashboard EVM wallet stack (§5a) is greenfield as its own future milestone — not on Ken's immediate P1/P2 critical path.

---

## What is NOT in question (already locked / proven)

- Arc EVM port: done, economic-e2e-proven on testnet, PR #204. No re-port, no re-deploy.
- Arc 3-contract set = canonical EVM codebase; 0G `PactCore.sol` retires (evidence in architecture §0). Your earlier preference for 3 contracts is the locked, evidence-backed choice.
- The specs are internally consistent, cross-referenced, and independently review-hardened. The blocker to handoff is the 6 decisions above, not the documents.
