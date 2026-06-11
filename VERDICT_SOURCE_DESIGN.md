# VERDICT_SOURCE_DESIGN — one verdict-source abstraction, three paths, a v2 seam

> Authored 2026-06-11 on `spike/verdict-source-10`. Companion: `MECHANISM_MAP.md`
> (the verified file:line map of where the breach is decided today). This doc is
> the **design**; the spike implements it. Every claim about current code cites
> `file:line` against this branch. Where a design choice hinges on a cited line I
> re-verified it; anything I could not confirm is marked **UNVERIFIED**.
>
> Scope guard, stated up front so nobody over-reads this doc: `verdictSource` is
> **provenance metadata, not a security control**. It records *who observed the
> outcome* so the settler/indexer/ops can treat client-attested money
> differently. It does NOT make the x402 path trustworthy — the actual bound on
> client-attested abuse stays the on-chain hourly exposure cap and the
> per-call imputed-cost ceiling (`coverage.ts:308-312`,
> `settle_batch.rs:408-423`). The abuse controls in §3 are an *additional*
> monitored gate, feature-flagged OFF, that plug in where the red-team says.

---

## 0. The problem in one paragraph

Pact computes the SLA breach off-chain in one of three places (`MECHANISM_MAP.md`
§1). On the gateway path Pact's own server makes the upstream fetch and times it
(`wrapFetch.ts:147,151`), so the verdict is *observed* — zero client trust. On
the x402 path the agent's CLI classifies its own `pay` output and the facilitator
accepts the `verdict` verbatim (`coverage.ts:186,250`), so the verdict is
*asserted* by the party who profits from a breach. Both paths emit the **same**
settlement-event shape and converge on the same settler + on-chain executor,
which does not recompute anything (`settle_batch.rs:159-162`). Today nothing in
the event, the DB, or the API records *which* of those two trust regimes produced
a given refund. This design adds exactly that one bit of provenance, cleanly, and
opens a seam for a v2 oracle without touching settler/indexer/on-chain.

---

## 1. THE ABSTRACTION

### 1.1 The type (locked — do not rename)

```ts
// @pact-network/wrap  (exported from types.ts, re-exported from index)
export type VerdictSource =
  | "pact_observed"    // Pact's server saw the upstream response itself
                       // (gateway / wrapFetch). Authoritative, zero client trust.
  | "client_attested"  // Client reported the outcome (off-gateway / facilitator).
                       // Zero-friction default; monitored + abuse-capped.
  | "oracle";          // v2: external attestation (zkTLS / TEE / cosigned).
                       // Seam only today — no producer implemented.
```

Both event interfaces gain ONE optional field:

```ts
// wrap/src/types.ts — SettlementEvent
verdictSource?: VerdictSource;   // gateway stamps "pact_observed"

// facilitator/src/lib/events.ts — PaySettlementEvent (already a superset of SettlementEvent)
verdictSource?: VerdictSource;   // facilitator stamps "client_attested"
```

### 1.2 Contract of each source

| Source | Who observed the upstream outcome | Client trust required | Produced by (today) |
|---|---|---|---|
| `pact_observed` | Pact's server (the proxy made the fetch, read the status, timed latency) | **none** | gateway / `wrapFetch` |
| `client_attested` | the paying agent's own machine | **full** (bounded by on-chain caps + §3 controls) | x402 facilitator `register` |
| `oracle` | a third party that cryptographically attests to the exchange | **none** (trust shifts to the attestor + its verifier) | nothing yet — §4 seam |

The defining test for `pact_observed`: *could the client have lied about this
outcome?* On the gateway it cannot — it controls the request but not what the
proxy *sees* as the response (`MECHANISM_MAP.md` §3; `classifier.ts:66` reads
`response.status` off the server-side fetch). On x402 it can — the facilitator
never sees the HTTP exchange, only the agent's post-mortem JSON
(`coverage.ts:107` parses the client body; `pay.ts:157` spawns `pay` out of
Pact's sight).

### 1.3 Where it is stamped (exact insertion points)

**Gateway — `pact_observed`.** The event is built in one place,
`wrapFetch.ts:169-179`:

```ts
const event: SettlementEvent = {
  callId, agentPubkey: opts.walletPubkey, endpointSlug: opts.endpointSlug,
  premiumLamports: classified.premium.toString(),
  refundLamports: classified.refund.toString(),
  latencyMs, outcome: classified.outcome,
  ts: new Date(tEnd).toISOString(),
  network: opts.network ?? "solana-devnet",
  verdictSource: "pact_observed",          // <-- ADD (one line)
};
```

This is correct **unconditionally** for `wrapFetch`, because `wrapFetch` is by
definition the server-side self-observing primitive and its only production
caller is the proxy (`MECHANISM_MAP.md` §3: `proxy.ts:168`, grep-verified single
prod caller). A literal constant is right here, not a parameter — see §1.5 for
the one caveat (a hypothetical client-side `wrapFetch` host) and why it's a
non-issue today.

**Facilitator — `client_attested`.** The event is built at
`coverage.ts:314-328` (`PaySettlementEvent`). Add:

```ts
const event: PaySettlementEvent = {
  ...,
  source: "pay.sh",
  verified,                                // existing — payment-verified ≠ verdict-verified
  payee, resource, coverageId,
  verdictSource: "client_attested",        // <-- ADD (one line)
};
```

Note the deliberate distinction the spike must preserve: the existing
`verified: boolean` field means *the on-chain payment was confirmed*
(`coverage.ts:205-221`). It says nothing about the **breach** verdict. A
registration can be `verified: true` (we saw the agent pay the merchant
on-chain) and still `verdictSource: "client_attested"` (we did NOT see the call
fail). Keeping these two as separate fields is the whole point — do not collapse
them.

### 1.4 Why an OPTIONAL field is the right migration

The precedent is exact: `network?` was added to `SettlementEvent` the same way
(`types.ts:50-58`) and consumers default it when absent. We re-use that pattern.
Three independent reasons, each verified against the consumers:

1. **The settler batcher tolerates unknown fields.** It treats the event as
   `Record<string, unknown>` and reads only `premiumLamports`, `callId`,
   `outcome`, `network`, `endpointSlug` by string key
   (`batcher.service.ts:45-94`). There is no closed-schema validation — a new
   optional field rides through untouched. **Verified.**

2. **The indexer tolerates unknown fields and already carries optional
   extensions.** `WrapCallEventDto` is a plain TS interface (no runtime
   allowlist/strip) and already has `source?`, `payee?`, `resource?`, `network?`
   (`events.dto.ts:50-77`). Ingest maps fields one-by-one into `tx.call.create`
   (`events.service.ts:388-405`) — an unmapped field is silently ignored, never
   rejected. So an old indexer receiving `verdictSource` does nothing with it and
   does not break; a new indexer that wants it adds a column + one mapping line.
   **Verified.**

3. **Backward + forward compatible both directions.** Old producer + new
   consumer: field absent → consumer defaults (`client_attested` is the only safe
   default for an *absent* value on an event that reached the facilitator path,
   `pact_observed` for the gateway path — but see §1.5: prefer making the absent
   default explicit per consumer rather than guessing). New producer + old
   consumer: field present, ignored. No coordinated deploy, no schema migration
   gate, no version bump on the shared event. This is why optional-field beats a
   required field or a discriminated-union rework of the event.

### 1.5 The one subtlety: what does *absent* mean?

`verdictSource` absent is a real wire state (old producers, replayed Pub/Sub
backlog). A consumer must pick a default. The honest default is
**per-ingestion-path, not global**:

- Events the **indexer** receives are already tagged `source` (`"pay.sh"` vs
  gateway). The settler's indexer-pusher knows the path. So the indexer can
  default `verdictSource` from `source`: `source === "pay.sh"` → `client_attested`,
  else → `pact_observed`. This is a safe, lossless inference because today the
  two are 1:1 (`MECHANISM_MAP.md` §2a).
- Do NOT hardcode a single global default in the type or in `wrapFetch`. The
  gateway stamps `pact_observed` explicitly (§1.3); the facilitator stamps
  `client_attested` explicitly; only *legacy replayed* events need the
  `source`-based fallback above.

UNVERIFIED: the exact line in the settler where `source` is forwarded to the
indexer (`events.ts:24-25` says "one-line patch shipped in this PR" but I did not
open the settler indexer-pusher). The spike should confirm `source` survives to
the indexer before relying on the inference; if it doesn't, fall back to
`client_attested` only when the event also carries `source:"pay.sh"`-shaped
fields, else `pact_observed`.

---

## 2. THREE PATHS MAPPED TO THE ABSTRACTION

### 2a. Gateway-routed → `pact_observed` → authoritative

- **Trust property:** zero client trust. Pact's server made the fetch
  (`wrapFetch.ts:147`), timed it (`:151`), read the status (`classifier.ts:66`).
- **Stamps:** `verdictSource: "pact_observed"` at `wrapFetch.ts:169` (§1.3).
- **Settler does differently:** nothing. This is the trusted baseline; settle as
  today. (Optionally: `pact_observed` events may be exempted from any §3
  attestation throttle, since there is no client claim to throttle. The §3
  decision function is simply never invoked on this path.)
- **Indexer does differently:** record the column (below) so the dashboard can
  badge a refund "Pact-observed". No behavioral change.

### 2b. Off-gateway / x402 → `client_attested` → authorize, then log for monitoring

- **Trust property:** full client trust on the *breach* (payment may still be
  on-chain-verified via the separate `verified` flag, `coverage.ts:205-221`).
- **Stamps:** `verdictSource: "client_attested"` at `coverage.ts:314` (§1.3).
- **Settler does differently:** by default **nothing different** — it settles
  client-attested events exactly as today, because the real bound is the on-chain
  cap (this is the deliberate zero-friction MVP posture). When the §3 flag is ON,
  the *facilitator* (not the settler) runs `evaluateClientAttestation(...)` before
  publishing and may decline/route-to-review; the settler stays dumb. Keeping the
  gate at the facilitator (the producer) rather than the settler (the consumer) is
  correct: the settler has no per-agent claim history and no notion of "decline
  the claim, keep the premium" — it only knows how to push `settle_batch`.
- **Indexer does differently:** record `verdictSource`, AND this is where it earns
  its keep — surfacing the column lets ops/dashboard see *what fraction of
  refunds are client-attested vs observed*, the baseline §3 needs.

### 2c. v2 oracle → seam (no producer yet)

- **Trust property:** zero client trust, but trust moves to the attestor + the
  facilitator's verifier of the attestation (§4).
- **Stamps:** `verdictSource: "oracle"` — by a *new* producer, not by `wrapFetch`
  or the current `register` path.
- **Settler / indexer do differently:** nothing — that is the whole design goal
  (§4). An `oracle` event is just another tagged settlement event.

### 2d. Indexer surfacing — the concrete column + API field (proposed)

Yes, surface it. The `Call` row and the `GET /api/calls/:id` response are the
natural home, and the precedent (`source`, `payee`, `resource`) is exactly this.

**Prisma `Call` model** (`packages/db/prisma/schema.prisma:57-85`) — add one
nullable column next to `source`:

```prisma
model Call {
  ...
  source          String?  @db.VarChar(32)
  verdictSource   String?  @db.VarChar(16)   // "pact_observed" | "client_attested" | "oracle"; NULL = legacy
  payee           String?  @db.VarChar(44)
  ...
  // Optional analytics index — lets ops count attested-vs-observed refunds fast:
  @@index([network, verdictSource, ts(sort: Desc)])
}
```

Nullable (not defaulted) so legacy rows read honestly as "unknown provenance"
rather than being silently relabeled. `VarChar(16)` fits the longest value
(`client_attested` = 15).

**Ingest** (`events.service.ts:388-405`) — one mapping line in `tryInsertCall`:

```ts
verdictSource: call.verdictSource ?? deriveFromSource(call.source) ?? null,
```

where `deriveFromSource` implements the §1.5 legacy inference (`"pay.sh"` →
`client_attested`, else `pact_observed`). Add `verdictSource?` to
`WrapCallEventDto` (`events.dto.ts:40-78`) so the settler can forward it.

**Read API** (`calls.controller.ts`) — add `verdictSource: string | null` to the
`CallWire` interface (`:20-33`) and to `serializeCall` (`:40-55`). It then appears
on both `GET /api/calls?limit=N` and `GET /api/calls/:id` for free. The facilitator's
own `GET /v1/coverage/:id` (`coverage.ts:347-419`) reads the `Call` row directly,
so once the column exists it can SELECT and return it there too (it already
SELECTs `source`, `payee`, `resource` at `:355-368`).

Dashboard impact: out of scope for the spike, but the field lets the per-call
detail panel badge a refund "Pact-observed" vs "Client-attested" — a trust
signal worth showing.

---

## 3. ABUSE CONTROLS for the `client_attested` accept path (design only)

The spike implements a **pure decision function**, feature-flagged **OFF by
default**. WHICH controls and WHAT thresholds is the red-team's call
(`SECURITY_REDTEAM_VERDICT.md`); this section specifies **where they plug in** and
the **function contract**, so their thresholds drop in without re-architecting.

### 3.1 Where it plugs in

One call site: the facilitator's `registerCoverageRoute`, AFTER the verdict is
known and the coverage math says "covered", BEFORE publishing the settlement
event — i.e. between `coverage.ts:259` (`if (!math.covered) return uncovered`) and
the allowance check / publish at `:272`/`:329`. It only ever runs when
`verdictSource === "client_attested"`. `pact_observed` and `oracle` skip it.

```
register → validate → verifyPayment(opt) → poolConfig → computeCoverage
        → [covered?] ── no ──> uncovered (today's path, unchanged)
                    └─ yes ──> evaluateClientAttestation(...)   <-- NEW gate (flag-gated)
                                 ├ ALLOW           ──> allowance check → publish (today's path)
                                 └ THROTTLE(reason) ──> respond "uncovered"/"under_review", DO NOT publish
```

`THROTTLE` must reuse the existing non-publishing exit shape
(`coverage.ts:262-269` returns `status:"uncovered"` with a `reason`). That keeps
the settler/on-chain path untouched — a throttled claim simply never becomes a
settlement event, so there is no batch to nack and no money moves. This is the
cleanest possible insertion: the gate's only power is *decline to publish*.

### 3.2 The decision function signature

```ts
// @pact-network/wrap (pure, no I/O — host injects state)  OR a small new
// @pact-network/attestation-policy package. Keep it OUT of the facilitator route
// so it is unit-testable and reusable by a future BYO-SDK attested path.

export type AttestationDecision =
  | { kind: "ALLOW" }
  | { kind: "THROTTLE"; reason: string };   // reason ∈ a closed enum the red-team defines

export interface AttestationContext {
  agentPubkey: string;
  endpointSlug: string;            // pool slug
  outcome: Outcome;                // the claimed (covered) outcome
  refundLamports: bigint;          // what this claim would pay out
  verified: boolean;               // was the PAYMENT on-chain-verified? (coverage.ts `verified`)
  now: number;                     // injected clock (testability)
  // ---- state the host supplies (read models; the function does no I/O) ----
  agentWindow: AgentRefundWindow;  // this agent's recent client_attested refunds
  networkBaseline: NetworkBreachBaseline; // protocol-wide breach-claim rate
}

export function evaluateClientAttestation(
  ctx: AttestationContext,
  thresholds: AttestationThresholds,   // RED-TEAM owns the numbers; injected, not hardcoded
): AttestationDecision;
```

Purity is the design constraint: `evaluateClientAttestation` takes state as
**arguments** and returns a decision — it performs no DB/RPC calls. That makes it
trivially unit-testable (the spike's deliverable) and lets the host decide how to
source/cache the state. Mirrors how `computeEconomics` is a pure function the two
paths share (`economics.ts:79`).

### 3.3 What state it needs (the two read models)

```ts
// Per-agent rolling refund window — "how much / how often has THIS agent been
// refunded on client_attested claims lately?" Bounds a single bad actor.
export interface AgentRefundWindow {
  windowMs: number;                 // e.g. trailing 1h / 24h (red-team picks)
  attestedClaimCount: number;       // client_attested registrations in window
  attestedRefundLamports: bigint;   // sum of client_attested refunds in window
  attestedBreachCount: number;      // of those, how many were "covered breach"
}

// Network breach-claim-rate baseline — "is this agent's breach rate wildly above
// the population?" Bounds coordinated / sybil-ish abuse and catches an endpoint
// that suddenly 'fails' for one agent only.
export interface NetworkBreachBaseline {
  windowMs: number;
  populationBreachRate: number;     // breaches / total client_attested claims, network-wide
  perEndpointBreachRate?: number;   // optional finer baseline for this slug
}
```

**Where the host gets this state (design, not in the pure function):** the
indexer already stores every settled `Call` with `breach`, `breachReason`,
`agentPubkey`, `ts`, and (after §2d) `verdictSource`, and already has the index
`@@index([network, breach, ts(sort: Desc)])` (`schema.prisma:84`). So both read
models are computable from existing data with a bounded-window aggregate query —
*no new event stream*. The facilitator would query the indexer's read API (or a
small new internal endpoint) for `agentWindow` / `networkBaseline` and pass them
in. **UNVERIFIED:** whether the facilitator can reach the indexer DB/API in the
deployed topology — the spike/host must wire that; if not, the window can be a
local in-memory ring buffer on the facilitator (lossy across restarts, but the
on-chain cap is still the hard floor).

### 3.4 Cross-check client claims vs gateway ground truth (the seam)

Where BOTH a client claim and Pact-observed truth exist for the *same endpoint*,
the baseline becomes much stronger than a blind rate limit. Concretely: an
endpoint reachable BOTH via the gateway (`pact_observed` rows) AND via x402
(`client_attested` rows) has a *measured* observed-breach rate. If an agent's
client-attested breach rate for that endpoint is wildly above the gateway-observed
rate for the same endpoint, that is high-signal abuse.

The seam: `NetworkBreachBaseline.perEndpointBreachRate` should be computable
**split by `verdictSource`** — the §2d column makes this a one-line `GROUP BY
verdictSource` over the `Call` table. The red-team decides whether/how to use the
divergence; the design's only job is to make the column exist so the comparison is
queryable. For x402-only endpoints (`pay-default`, `coverage.ts:227`) there is no
gateway ground truth, so the cross-check degrades to the population baseline —
state that explicitly so the red-team's thresholds account for "no ground truth
available" as a distinct case.

---

## 4. V2 ORACLE SEAM

**Claim: adding `"oracle"` later requires NO change to settler, indexer, or
on-chain — only a new producer.** Walk it:

- **Event shape:** `verdictSource: "oracle"` is already a legal value of the
  locked union (§1.1). No type change when v2 lands.
- **Settler:** reads `premiumLamports`/`outcome`/etc. by key
  (`batcher.service.ts:45-94`); an `oracle`-tagged event batches and settles
  identically. No change.
- **Indexer:** the `verdictSource` column (§2d) already accepts the string
  `"oracle"` (`VarChar(16)`); ingest maps it through. No migration. No change.
- **On-chain:** never sees `verdictSource` at all — it executes
  `refund_lamports` it is handed (`settle_batch.rs:159-162,464-485`). No change,
  ever.

So the *only* new code for v2 is a **producer** that obtains an external
attestation, verifies it, derives an `Outcome`, runs `computeEconomics`, and
publishes a settlement event stamped `"oracle"`. Sketch:

```ts
// New package, e.g. @pact-network/attestation-oracle (does NOT touch wrap/settler)
export interface AttestationVerifier {
  // Verify a zkTLS proof / TEE quote / merchant-cosigned receipt binds:
  //   (agent, resource, paymentSignature?) -> an observed HTTP outcome.
  // Returns the attested outcome ONLY if the proof verifies; else null.
  verify(input: {
    agent: string; resource: string; attestation: unknown;
  }): Promise<{ outcome: Outcome; latencyMs: number } | null>;
}

// Producer flow (mirrors coverage.ts:250-329 but with a VERIFIED outcome):
const att = await verifier.verify({ agent, resource, attestation });
if (!att) return reject("attestation_invalid");
const math = computeEconomics({ outcome: att.outcome, pool, amountPaid });  // SAME math
publish({ ...event, outcome: att.outcome, verdictSource: "oracle" });        // SAME topic
```

Key property: the oracle producer re-uses the SAME `computeEconomics`
(`economics.ts:79`) and the SAME settlement topic, so it inherits all downstream
machinery for free. It differs from the x402 path in exactly one place — it
verifies the outcome before trusting it, and stamps `"oracle"` instead of
`"client_attested"`. The §3 throttle does not apply to `oracle` (the outcome is
verified, not asserted), which is why `evaluateClientAttestation` keys on
`verdictSource === "client_attested"` and nothing else.

This is the payoff of putting provenance in the event rather than branching the
infrastructure: the trust regime is data, so a new regime is a new producer, not
a new pipeline.

---

## 5. FEATURE-FLAGGING + ROLLOUT

### 5.1 Flags and defaults (defaults preserve TODAY's behavior exactly)

| Flag | Default | Effect |
|---|---|---|
| `PACT_STAMP_VERDICT_SOURCE` | `"on"` (it is a pure additive field — but gate it so it can be killed if a stale consumer chokes) | When on, gateway stamps `pact_observed`, facilitator stamps `client_attested`. When off, field omitted → consumers behave exactly as pre-spike (the optional-field guarantee, §1.4). |
| `PACT_VERDICT_ATTESTATION_GATE` | `"off"` | When off, `evaluateClientAttestation` is **never invoked** — every covered client-attested claim publishes as today (zero-friction MVP preserved). When on, the §3 gate runs and may THROTTLE. |
| `PACT_ATTESTATION_THRESHOLDS` | n/a (only read when gate on) | JSON/env-sourced `AttestationThresholds` the red-team owns. Absent → the gate, if somehow on, must fail **open** (ALLOW) and log loudly — never fail closed and start declining real refunds on a config miss. |

The critical invariant: **with both flags at their defaults the system is
byte-for-byte the current behavior except for one extra string field on the
event** (and that field is itself flag-gated). No refund decision changes. The
"mode stays trust / zero-friction" requirement is met by `*_GATE = off`.

### 5.2 Migration order

1. **Add the type + optional fields + stamp** (`types.ts`, `events.ts`,
   `wrapFetch.ts:169`, `coverage.ts:314`), behind `PACT_STAMP_VERDICT_SOURCE`.
   Ship. Nothing downstream consumes it yet → zero risk (§1.4 guarantees).
2. **Add the indexer column + DTO field + read-API field** (§2d). Ship. Backfill
   is unnecessary — legacy rows stay `NULL`/inferred; new rows populate. The
   column is nullable so the migration is non-blocking.
3. **Land `evaluateClientAttestation` as a pure, unit-tested function** with the
   gate flag `off`. Ship. It is dead code in prod until enabled — but fully
   tested and reviewable. The spike stops here.
4. **(Later, red-team-gated) wire the read models** (`agentWindow`,
   `networkBaseline`) from indexer data, set thresholds, flip
   `PACT_VERDICT_ATTESTATION_GATE = on` in **shadow/log-only** first (compute the
   decision, log it, but still ALLOW), confirm it would not throttle legitimate
   traffic, THEN flip to enforcing. (Shadow mode = a third gate value
   `"log_only"`, not just on/off — recommend the flag be an enum
   `off | log_only | enforce`, not a boolean.)

Order rationale: provenance must exist (steps 1-2) before any control can read it
(step 3-4). Each step is independently shippable and independently revertible by
its own flag.

---

## Source-of-truth index (load-bearing lines this design hinges on)

- Locked type + optional-field precedent: `wrap/src/types.ts:50-59`
- Gateway stamp point: `wrap/src/wrapFetch.ts:169-179` (event build), self-obs
  `:147,151`; classifier `wrap/src/classifier.ts:66`
- Facilitator stamp point: `facilitator/src/routes/coverage.ts:314-328`; verdict
  trusted `:186,250`; `verified` (payment, not verdict) `:205-221`
- Shared money math (oracle reuses it): `wrap/src/economics.ts:79-105`
- Settler ignores unknown fields: `settler/src/batcher/batcher.service.ts:45-94`
- Indexer DTO already has optional extensions: `indexer/src/events/events.dto.ts:50-78`
- Indexer ingest maps fields explicitly: `indexer/src/events/events.service.ts:388-405`
- Indexer Call model (column home): `db/prisma/schema.prisma:57-85` (breach index `:84`)
- Read API shape: `indexer/src/api/calls.controller.ts:20-55,109-138`
- Facilitator GET reads Call directly: `coverage.ts:347-419`
- On-chain never recomputes: `settle_batch.rs:159-162,464-485`
- Companion map: `MECHANISM_MAP.md` §1-§3
```
