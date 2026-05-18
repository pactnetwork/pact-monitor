---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: executing
last_updated: "2026-05-18T12:30:00.000Z"
last_activity: 2026-05-18 -- 04-02 complete (AccessControl + E1 hooks + harness)
progress:
  total_phases: 7
  completed_phases: 0
  total_plans: 4
  completed_plans: 2
  percent: 50
---

# Project State

## Project Reference

**Core value:** Behavioral-parity port of the Solana `pact-network-v1-pinocchio`
on-chain program to Circle Arc (EVM L1), driven by the 10 LiteSVM test files as
the parity oracle. This is a PORT, not a redesign.
**Current focus:** WP-EVM-04 — PactSettler happy path

## Current Position

Phase: 4 of 7 (PactSettler Happy Path)
Plan: 2 of 4 complete in current phase
Status: Executing — 04-02 done; 04-03 (per-event guards + dedup + premium-in) is next
Last activity: 2026-05-18 -- 04-02 complete (AccessControl + E1 hooks + harness)
`.planning/` scaffold for the GSD plan-phase pipeline (spec §8 mandates GSD for
WP-04/05). WP-EVM-01/02/03 complete and pushed; WP-02/03 were plan-doc-driven
(no `.planning/`), so WP-04 is the first GSD-orchestrated phase.

Progress: WP-01 ✓ · WP-02 ✓ · WP-03 ✓ · WP-04 (04-01 ✓, 04-02 ✓, 04-03/04 pending) · WP-05/06/07 pending

## Decisions (WP-EVM-04)

- **E1 OPTION (a) RULED**: PactRegistry gains OZ AccessControl + SETTLER_ROLE +
  two SETTLER_ROLE-gated hooks (recordCallAndCapAccrual + recordRefundPaid)
  mirroring settle_batch.rs's two ep.* mutation points (committed in 04-02).
- **E2 RULED**: PactSettler 3-arg ctor + OZ AccessControl SETTLER_ROLE;
  DEFAULT_ADMIN_ROLE -> registry.authority() (committed in 04-02).
- **D1 scope refinement**: WP-03 D1 barred PactPool reaching into registry; WP-04
  adding its own gated stat-writer is a sanctioned additive extension per GATE-A
  E1 condition (4). To be appended to handoff locked-rulings as ruling #8 during
  WP-06 formal-correction pass.

## Notes

- Branch: `feat/arc-protocol-v1` (single checkout; never touch `main`).
- PR #204 (`pactnetwork/pact-monitor`); WP completion summaries are PR comments.
- Authoritative handoff:
  `docs/superpowers/handoffs/2026-05-18-arc-evm-port-handoff.md` — 7 LOCKED
  rulings + methodology + contamination warning. Treat as settled law; do NOT
  re-derive prior decisions.

- Gate cadence per WP: (1) plan-review gate (GATE A) — author plan, report,
  WAIT for captain approval BEFORE any Solidity; (2) final parity gate (GATE B)
  — after impl + `forge build && forge test` green, report, WAIT, no push / no
  PR comment until approved.

- WP-EVM-04 GATE A RULED 2026-05-18 (see 04-GATE-A-DECISIONS.md). E1=(a):
  PactRegistry gains a SETTLER_ROLE-gated endpoint-stats writer. This REFINES
  WP-03 ruling D1 (NOT a contradiction): D1 barred `PactPool` reaching into
  the registry; it does NOT bar WP-04 adding its own gated stat-writer where
  spec §6 places `EndpointConfig` state. Append to the handoff locked-rulings
  list as ruling #8 during the WP-06 §d formal-correction pass.

- D-SPLIT refinement: the hourly-window PERIOD RESET + `currentPeriodRefunds
  += intendedRefund` are WP-04 happy-path state (in the registry stat hook);
  ONLY the 3 clamp DECISIONS (ExposureCapClamped, PoolDepleted, pause
  kill-switches) are WP-05, layered additively.

- Config: Nyquist/security GSD gates DISABLED for WP-04 (ported LiteSVM oracle
  + strict TDD is the validation contract). WP-05 enables a settlement
  threat-model/adversarial pass; WP-06 fuzz/gas covers statistical adequacy.

- Reporting: gate reports go to `.planning/phases/<phase>/<phase>-REPORT-<gate>.md`
  AND a short `cockpit runtime send pact-network` notice (relay unreliable).
