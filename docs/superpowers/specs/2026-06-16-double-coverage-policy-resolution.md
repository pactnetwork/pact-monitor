# ADR: Double-coverage policy resolution (agent-side vs provider-side)

- **Status:** Accepted (design-only). Q1–Q5 all locked (Q5 locked by Rick 2026-06-16).
- **Date:** 2026-06-16
- **Scope:** V2 program (`pact-network-v2-pinocchio`). Struct-layout seam only — no
  runtime instruction behavior changes in this change.
- **Tracking:** [agent-tasks#17](https://github.com/pactnetwork/agent-tasks/issues/17)
  (ported from `pactnetwork/pact-monitor#30`).
- **Related:** Whitepaper §8 (mutual state channel & co-signed call record);
  PRD-PHASE-5 (`Policy` struct + reserved-pad extensibility convention);
  Office hours design doc (2026-04-16, V1 scope / V2 gating).

---

## Context

Pact Network has two integration surfaces:

- **Agent-side** — the agent installs the SDK, pays a per-call premium out of its
  USDC ATA, and receives an automatic refund when the call breaches an SLA.
- **Provider-side** — the API provider pays Pact to insure their own endpoint's
  uptime; agents consuming that endpoint receive coverage implicitly. This is a
  **V2 product** (external underwriters / provider-underwrite-own-uptime) and is
  not shipping in V1.

When both surfaces are active for the **same call into the same pool**, the
program currently has no opinion. Left unresolved, the first provider-integrated
agent calling a provider-integrated API that fails hits four concrete failure
modes:

1. **Double premium collection** — the same risk is priced twice; the agent
   believes it pays ~0.3% but is effectively funding both sides.
2. **Double refund on one failure** — a single 5xx triggers both policies; the
   agent is made *more* than whole (2× call cost), inflating loss ratios and
   breaking the parametric promise.
3. **Ambiguous co-signed call record** — a provider that is also a Pact customer
   has conflicting incentives on the shared state-channel record (wants the
   failure acknowledged for *its* coverage, suppressed for the *agent's*).
4. **Pool double-exposure accounting** — the per-API exposure cap (15–20% of
   pool capital) assumes one policy per call; two overlapping policies are
   counted as two risk units unless the program knows they overlap.

The issue's explicit constraint: if the `Policy` struct cannot express
linked/deduplicated policies later, opening V2 forces an account migration —
exactly what the `reserved: [u8; 64]` pad (PRD-PHASE-5 convention) exists to
avoid. So the program's policy model must be made double-coverage-aware **now**,
at the byte-layout level, even though the runtime logic ships in V2.

This ADR records the resolution to all five questions in agent-tasks#17 and
carves the minimal struct seam (Deliverable 2) needed for the V2 implementation
to land without a migration.

---

## Decision

### Q1 — Canonical policy rule: **agent-side wins** (LOCKED)

When both sides have coverage for a single call, the **agent-side policy is
canonical and is the only policy that pays a separate refund.** The agent is the
buyer of record; its parametric promise (one refund per breached call) is the
contract the protocol honors.

Provider-side coverage is **passive**:

- It is a **premium flow into the pool** — no parallel payout on a breach.
- It contributes to **enhanced scoring** of the endpoint and, optionally, a
  **reserve contribution** that deepens the pool backing the agent-side policy.
- It is explicitly **not a second parallel policy** that triggers on the same
  event.

This directly kills failure mode #2 (double refund): only one policy — the
agent-side one — ever disburses on a given call.

### Q2 — Deduplication at policy creation: **struct seam now, runtime in V2** (LOCKED)

`enable_insurance` must be **able** to detect an existing provider-funded policy
on the same pool and **link** the new agent-side policy to it. This ADR adds
**only the struct seam** that makes the link expressible:

- `linked_policy: [u8; 32]` — the counterpart Policy PDA (all-zero = None).
- `policy_kind: u8` — `0` = agent-side (canonical), `1` = provider-side (passive).
- `linked_policy_present: u8` — explicit Some/None discriminant.

The **runtime discount-or-reject logic** (adjust the agent's premium because some
risk is already provider-funded, or reject a true duplicate) is **V2
implementation and out of scope here.** It is documented below as a follow-up.
Killing failure mode #1 (double premium) is a function of that V2 runtime path;
this ADR only guarantees the data model can carry the link it needs.

> **V2 follow-up (not in this change):** in `enable_insurance.rs`, before
> creating an agent-side policy, scan the target pool for an active
> `policy_kind == 1` (provider-side) policy. If found, set `linked_policy` /
> `linked_policy_present` on both records and apply the premium adjustment
> gated by that provider's `discount_scope` (Q5): scope `1` (all-agents)
> discounts unconditionally; scope `2` (opt-in-only) discounts only when the
> agent enrolled. On a true duplicate of the *same kind*, reject.

### Q3 — Co-sign authority model: **canonical record binds the agent-side policy; design-only tiebreaker** (LOCKED)

The co-signed call record on the mutual state channel is **binding for the
canonical (agent-side) policy.** That resolves failure mode #3's "which policy is
this record for" ambiguity: it is always the agent-side one.

For the conflicting-incentive case (provider is also a Pact customer and is party
to two interests on the same record), the tiebreaker is **either**:

- a **third independent measurement** from an observer node, **or**
- a **pre-agreed schema-match check** that either party can verify
  unilaterally (neither side can suppress or fabricate the verdict alone).

This is a **design-only** decision — no observer-node or schema-match code is
written in this change. It records the intended trust model so the V2 state
channel and the V2 oracle work (tracked separately under the V2 oracle
trust-model issue) build toward it.

### Q4 — Pool accounting: **linked policies are ONE risk unit; struct seam makes it expressible** (LOCKED)

The per-API exposure-cap calculation must treat a linked agent-side/provider-side
pair as a **single risk unit**, not two. The `linked_policy` pointer added here is
what makes that expressible: exposure math can follow the link and de-duplicate.

This change does **not** modify `submit_claim.rs` or the exposure-cap calculation.

> **V2 follow-up (not in this change):** update the exposure-cap calculation in
> the claim/settlement path so that when a policy has
> `linked_policy_present == 1`, the linked counterpart's notional is **not**
> double-counted against the 15–20% per-pool cap — the pair consumes one unit of
> exposure. `submit_claim.rs` is intentionally left untouched here.

### Q5 — Economic model: **merchant-configurable (per-provider)** (LOCKED — Rick 2026-06-16)

The coverage-discount scope is the **provider/merchant's choice, per integration**
— it is **not** a protocol-wide rule and **not** hardcoded either way. Some
merchants will want the discount to apply to **every** agent calling their API;
others will want it **opt-in only**. The protocol **exposes the toggle**; the
merchant sets it when they stand up their provider-side coverage.

This is carried by a 1-byte `discount_scope` field on the **provider-side**
policy (`policy_kind == 1`). Its semantics:

| `discount_scope` | Meaning                                                                 |
|-----------------:|-------------------------------------------------------------------------|
| `0`              | unset / not-applicable — the value on every agent-side policy, and the default before a provider chooses. |
| `1`              | **all-agents** — every agent calling this API gets the discount.        |
| `2`              | **opt-in-only** — only agents who explicitly enroll get the discount.   |

`discount_scope` is **meaningful only when `policy_kind == 1`** (provider-side).
On an agent-side policy it MUST be `0` (the zero-default already enforces this for
fresh buffers). The field is part of the inert struct seam: the V2
`enable_insurance` runtime that reads it to price the agent's premium is a
follow-up and is **out of scope here** — this change only guarantees the data
model can carry the merchant's choice.

> **Why per-provider, not protocol-wide:** a blanket protocol rule would force
> every merchant into the same go-to-market model. Making it a per-integration
> toggle lets a provider who wants maximum agent adoption discount everyone, while
> a provider who wants to gate the benefit behind enrollment can require opt-in —
> both on the same pool, without a second protocol-level premium tier baked into
> the program.

---

## Struct seam (Deliverable 2)

Carved into `Policy` in
`packages/program/programs-pinocchio/pact-network-v2-pinocchio/src/state.rs`,
following the existing Phase-5 referrer-block pattern (Pod-safe: no
`Option<Pubkey>` / `bool`; zero-sentinel + present-byte). Fields are consumed
**from the trailing `reserved` pad**, which shrinks from 64 → 24 bytes so
`Policy::LEN` stays **320** — no account migration (PRD-PHASE-5 reserved-pad
convention).

New fields (inserted after the referrer block, before `reserved`):

| Field                   | Type       | Offset | Size | Notes                                                  |
|-------------------------|------------|-------:|-----:|--------------------------------------------------------|
| `linked_policy`         | `[u8; 32]` |    256 |   32 | Counterpart Policy PDA; all-zero = None.               |
| `policy_kind`           | `u8`       |    288 |    1 | 0 = agent-side (canonical), 1 = provider-side (passive).|
| `linked_policy_present` | `u8`       |    289 |    1 | 1 = `linked_policy` populated; 0 = None.               |
| `discount_scope`        | `u8`       |    290 |    1 | Q5 merchant toggle; meaningful only when `policy_kind == 1`. 0 = unset/n-a, 1 = all-agents, 2 = opt-in-only. |
| `_pad_double_coverage`  | `[u8; 5]`  |    291 |    5 | Alignment pad (was `[u8; 6]`; gave up 1 byte to `discount_scope`) → `reserved` lands on an 8-byte boundary. |
| `reserved`              | `[u8; 24]` |    296 |   24 | Was `[u8; 64]`; shrunk by the 40-byte seam above. **Unchanged by the Q5 addition** — `discount_scope` came out of `_pad_double_coverage`, not `reserved`. |

- **`Policy::LEN` = 320** (unchanged).
- **Reserved pad:** 64 → 24 bytes (40 bytes consumed: 32 + 1 + 1 + 1 + 5). The Q5
  `discount_scope` byte was carved from `_pad_double_coverage` (6 → 5), so the
  reserved pad stays at **24** and `reserved` stays 8-aligned at offset 296.
- Compile-time offset asserts pin `linked_policy@256`, `policy_kind@288`,
  `linked_policy_present@289`, `discount_scope@290`; the `Policy, reserved`
  end-distance assert is `Policy::LEN - 24`. The `Policy::LEN == 320` assert is
  unchanged.
- A fresh, zero-initialized policy buffer defaults to
  `policy_kind = 0` (agent-side), `linked_policy_present = 0` (unlinked),
  `discount_scope = 0` (unset) — i.e. today's V1 behavior, so `enable_insurance`
  needs no change to remain correct.

---

## Consequences

**Positive**

- The V2 double-coverage runtime (dedupe at creation, single-unit exposure
  accounting) can land **without an account migration** — the data model already
  carries the link and the kind.
- Failure mode #2 (double refund) is closed by design: only the agent-side
  policy pays out, period.
- The trust model for the contested co-signed record (Q3) is recorded before the
  V2 oracle / state-channel work begins, so that work has a target.
- Zero behavior change in V1: the seam is inert (all-zero default = canonical
  agent-side, unlinked), so the deployed V1 program and clients are unaffected.

**Negative / costs**

- The `Policy` reserved pad drops from 64 → 24 bytes. A *second* future
  layout extension beyond double-coverage will have less slack (24 bytes); a
  third may force a migration. This is the deliberate trade the reserved-pad
  convention exists to make, but the budget is now smaller and should be tracked.
- The runtime is **deliberately incomplete**: the seam exists but
  `enable_insurance` does not yet dedupe and `submit_claim` does not yet treat
  links as one exposure unit. Until the V2 follow-ups land, a hypothetical
  provider-side policy would still be mis-accounted — acceptable because
  provider-side integration does not exist in V1.

**Open items**

- **V2 follow-up: dedupe logic** in `enable_insurance.rs` (Q2).
- **V2 follow-up: exposure-cap calc** treating linked policies as one unit in the
  claim/settlement path (Q4); `submit_claim.rs` untouched here.
- **V2 follow-up: observer-node / schema-match tiebreaker** for the contested
  co-signed record (Q3), aligned with the V2 oracle trust-model work.
- **Downstream docs:** whitepaper §8 and the SDK README still need the
  canonical-policy rule written up (acceptance-criteria items not covered by this
  design-only change).
