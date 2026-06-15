# FS9 Deploy Phase 2 — Devnet Verification Report

**Issue:** agent-tasks#15 (FS9 keystone refund) + SOL-01 forged-authority guard
**Date:** 2026-06-15
**Program:** `5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5` (devnet)
**Upgrade slot under test:** 469590326 (data 89560B, upgrade tx `4x26f1zf5Lw5n2SCMdpsG6Qimhh3hKDNqCzJhQyQTttZ1YuN74ncknbgAexXURUNH7Yn9FRJyNThDKFsnrPTR7L5`)
**RPC:** https://api.devnet.solana.com
**Branch:** `fs9-verify-15` (from `origin/fix/fs9-devnet-declare-id-15`, head `93d18eb`)

---

## C) OVERALL DEVNET VERDICT: **PASS**

Both FS9 (declare_id refund fix) and SOL-01 (forged settlement-authority guard) are
**proven on-chain with real devnet transactions**. The freshly-upgraded devnet binary
carries both fixes and they behave exactly as specified.

| Part | Claim | Verdict |
|------|-------|---------|
| A | FS9: `settle_batch` no longer reverts `InvalidSeeds`; real on-chain USDC refund | **PASS** |
| B | SOL-01: forged `settlement_authority` rejected with error 6033; canonical accepted | **PASS** |

---

## A) FS9 KEYSTONE REFUND — **PASS**

**Claim under test:** the prior devnet binary was built with the *mainnet* `declare_id`
(`5bCJ…`), so `crate::ID`-driven PDA derivation did not match the actual deploy address
and `settle_batch` reverted `InvalidSeeds` — blocking every refund. The redeploy with the
`devnet-id` feature fixes the declared ID.

### Step 0 — read-only probe (authority + provisioning gate)
`verify-network.ts probe … --expect-authority 47Fg…` → **PASS**
- `ProtocolConfig.authority` == `SettlementAuthority.signer` == `47Fg5JqMsCeuRyDsFtD7Ra7YTdzVmTr2mZ1R2dUkZyfS`
- `paused = 0`, USDC mint == devnet `4zMMC9…`
- dummy `EndpointConfig` + `CoveragePool` provisioned; pool vault funded
- Artifact: `.planning/smoke/fs9-devnet-verify/01-probe.json`

### Steps 1–9 — full live settlement loop
`scripts/devnet/local-strict-e2e.sh up` drove the real loop on live devnet:
dummy-upstream → market-proxy → Redis Streams → settler (**real `settle_batch` on devnet**)
→ indexer → SDK `refund` event.
- SDK strict vitest: **2/2 PASS** — `live devnet: approve -> covered call -> forced breach -> refund`
- Agent (pre-provisioned, funded + SPL-approved): `Hr7XXdvkiQXb1Z7SnC5i8BJks5ptuEUkswrJX97AsNLa`
- Artifacts: `04-strict-e2e-run2.log`, `07-strict-e2e-run3.log`

### Step 10 — independent on-chain refund proof (the real F2 deliverable)
`verify-network.ts assert-refund` against the settled CallRecord → **PASS**

```
callId               = 4b481472-69bd-49b7-8139-9fa4fd8b49e0
CallRecord PDA       = DbMrUJQQaByoA7XtHcqxXuF1RmP1D2EWfWiTR8mYb8R4
settlementStatus     = Settled
breach               = true
premiumLamports      = 1000
refundLamports       = 11000
actualRefundLamports = 11000      <-- REAL USDC moved (> 0)
agent ATA pre/post   = 19937000 / 19947000
ATA delta            = +10000  == actualRefund(11000) - premium(1000)   ✓
=> assert-refund PASS — real on-chain refund proven
```

**settle_batch refund tx (Solscan):**
`3JZFuob57s7hBusUc8sqa1gGoJd1Zx2VqTjk49DaHgoCsfSjuQ95btsCTR7Cp1opqJPB4MV4bB6JLFDi8wHDbxFD`
- https://solscan.io/tx/3JZFuob57s7hBusUc8sqa1gGoJd1Zx2VqTjk49DaHgoCsfSjuQ95btsCTR7Cp1opqJPB4MV4bB6JLFDi8wHDbxFD?cluster=devnet
- `err = null`; program `5jBQ…` invoked, 3 SPL Token transfers (premium debit + refund + fee split), `Program 5jBQ… success`, slot 469594370.
- Artifact: `.planning/smoke/fs9-devnet-verify/08-assert-refund-PASS.json`

**KEY RESULT:** `settle_batch` **executes on-chain and settles `Settled` with a real, non-zero
USDC refund**. The `InvalidSeeds` revert that defined FS9 is gone. FS9 keystone is RESOLVED on devnet.

### False-pass guard fired first (and was honest)
The very first settle attempt (callId `63e81ddc…`, CallRecord `7Cva…`) settled
**`PoolDepleted` with `actualRefundLamports = 0`** even though the SDK vitest went green —
exactly the Critical-1 false-pass the `assert-refund` guard exists to catch. Root cause was
*not* the program: the on-chain `CoveragePool.currentBalance` accounting counter was only
2,700 lamports (< the 11,000 refund), despite the raw vault token balance being ~1 USDC.
Resolved by a protocol-level `top_up_coverage_pool` (disc 9) raising `currentBalance`
2,700 → 52,700 (tx `4ej6eKx99Tj2uaSgubxbDdq2Vq1k2azwyeTvS1VFSNcVAWjSYpnc3iz5iruRTzDUxphR41KRSyYAeVLUjBdkq6rD`),
after which the re-run settled `Settled` with `actualRefund = 11000`. This demonstrates the
guard distinguishes "settle ran" from "refund actually paid".

---

## B) SOL-01 FORGED-AUTHORITY REJECT — **PASS**

**Adversarial script:** `scripts/devnet/sol01-forged-auth.ts` (new; uses
`@q3labs/pact-protocol-v1-client` `buildSettleBatchIx`). Submits an empty-batch `settle_batch`
(0 events) so the fixed-prefix `verify_settlement_authority` gate (`settle_batch.rs:125`,
`pda.rs:91`) is isolated — no agent/pool funding needed. Both cases sent as REAL devnet txs
(`skipPreflight` so the failing tx still lands and yields a signature).

### Forged settlement_authority → **rejected 6033**
```
forgedSettlementAuthority = 26GMJycJuCGzB9m6sjTvgqQGcDSHJu2AkierkscueNVz   (random, not the PDA)
failing tx sig            = 56rkL1N5721nM15CaE2TbBejjV9NV1zdzUkNg9jzrpfCijfGw1816sZ1Yg6fqAFMSjftCje2YJLtsdCYKmY6TvuD
on-chain err             = { InstructionError: [0, { Custom: 6033 }] }
program log              = "Program 5jBQ… failed: custom program error: 0x1791"   (0x1791 = 6033)
decoded                  = InvalidSettlementAuthority — "Supplied SettlementAuthority is not
                           the canonical [b\"settlement_authority\"] PDA, or is not owned by this program."
```
- Solscan: https://solscan.io/tx/56rkL1N5721nM15CaE2TbBejjV9NV1zdzUkNg9jzrpfCijfGw1816sZ1Yg6fqAFMSjftCje2YJLtsdCYKmY6TvuD?cluster=devnet

### Control — canonical settlement_authority → **success (no false-reject)**
```
canonicalSettlementAuthorityPda = FbTs39EycTWtQCRrExwmoAAjeQrcaLrXyNpVqthuXy4m
success tx sig                  = 4vhzEvfCb45T51G7KsvHg8ixFeaAB1nFiHusJzkW3qmNxo9vZUzASq2YJ5iQNyzd823thurQ5XmJfcTbiYW25Wkh
on-chain err                    = null
```
- The canonical empty batch passing the gate also transitively confirms the **declare_id fix**:
  `verify_settlement_authority` derives the expected PDA from `crate::ID`; the on-chain account
  matches only because the binary now declares the devnet ID.
- Plus the full Part-A `settle_batch` (`3JZFuob5…`, canonical authority) is the strong control:
  canonical authority settles real funds, forged authority is rejected.
- Artifact: `.planning/smoke/fs9-devnet-verify/03-sol01-forged-auth.json`

**KEY RESULT:** SOL-01 guard rejects a forged `settlement_authority` with `InvalidSettlementAuthority`
(6033) before trusting `sa.signer`, and does not false-reject the canonical authority.

---

## D) MAINNET-READINESS RECOMMENDATION

- **FS9 and SOL-01 are functionally verified on devnet.** The mainnet artifact is the *default*
  build (mainnet `declare_id` `5bCJ…`); the verified devnet binary is the `--features devnet-id`
  build of the same source. The fixes live in shared source (`verify_settlement_authority`,
  cfg-gated `declare_id`), so the mainnet binary carries the SOL-01 guard identically. **A mainnet
  redeploy from the default build is still required** to ship the SOL-01 fix on mainnet
  (`5bCJ…` is the program flagged HIGH for the forgeable settle_batch authority — see
  `project_sol01_settle_batch_authority`).
- Recommend a mainnet redeploy of the default build, then re-run `sol01-forged-auth.ts` against
  mainnet `5bCJ…` to confirm 6033 there before closing SOL-01.
- The broader mainnet gate (`docs/audits/2026-05-05-mainnet-readiness.md`) remains BLOCKED on
  multisig rotation of the upgrade authority (currently the `47Fg…` hot key) + third-party audit
  + protocol-wide pause drill — unchanged by this verification.
- **Pool accounting note:** for any production endpoint, `CoveragePool.currentBalance` must be
  raised via `top_up_coverage_pool`, not by minting/transferring directly to the vault. A vault
  with tokens but a low `currentBalance` settles `PoolDepleted` and silently pays 0 — operators
  must fund through the protocol instruction.

## E) BLOCKERS / NOTES

- **No blockers to the FS9/SOL-01 verdict.** Both proven.
- **Harness bugs found & handled (test-tooling only, not on-chain):**
  1. `scripts/devnet/seed-local-dummy.sql` used `ON CONFLICT (slug)` but the `Endpoint` PK is the
     composite `@@id([network, slug])` (multi-network migration). **Fixed** → `ON CONFLICT (network, slug)`.
     Without it the local Postgres seed errored and the proxy discovery was empty.
  2. `local-strict-e2e.sh` step [10] captures `ATA_PRE` via `$(SCMD ata-balance …)`, but a pnpm
     "Unsupported engine" WARN (Node 24 vs wanted 20) leaks into stdout and corrupts the captured
     value → `BigInt` throws and the in-harness `assert-refund` never runs. **Worked around** by
     capturing the clean pre-balance out-of-band and running `assert-refund` manually; the on-chain
     settle is unaffected. Recommend piping service stdout to stderr or grep-filtering the capture.
     (Both are local-harness fixes; neither touches program/client/settler behavior.)
- Devnet USDC mint authority (`GrNg1XM2…`) is not held locally; Part A reused the pre-provisioned
  agent `Hr7X…` (already holding ~20 USDC + SPL-approved to the SettlementAuthority PDA) instead of
  minting fresh — and funded the pool authority's ATA by transferring 0.06 USDC from that agent.

---

### Artifacts (`.planning/smoke/fs9-devnet-verify/`)
| File | Contents |
|------|----------|
| `01-probe.json` | read-only probe + authority gate PASS |
| `03-sol01-forged-auth.json` | SOL-01 forged (6033) + canonical control |
| `05-assert-refund.json` | false-pass guard firing on PoolDepleted (currentBalance gap) |
| `06-pool-topup.log` | `top_up_coverage_pool` 2,700 → 52,700 |
| `08-assert-refund-PASS.json` | final FS9 refund proof — Settled, actualRefund 11000 |
| `04/07-strict-e2e-run*.log` | full E2E loop logs (SDK 2/2 PASS) |

### Key transactions
| What | Signature |
|------|-----------|
| FS9 settle_batch refund (Settled, actualRefund 11000) | `3JZFuob57s7hBusUc8sqa1gGoJd1Zx2VqTjk49DaHgoCsfSjuQ95btsCTR7Cp1opqJPB4MV4bB6JLFDi8wHDbxFD` |
| SOL-01 forged authority → 6033 | `56rkL1N5721nM15CaE2TbBejjV9NV1zdzUkNg9jzrpfCijfGw1816sZ1Yg6fqAFMSjftCje2YJLtsdCYKmY6TvuD` |
| SOL-01 canonical control → success | `4vhzEvfCb45T51G7KsvHg8ixFeaAB1nFiHusJzkW3qmNxo9vZUzASq2YJ5iQNyzd823thurQ5XmJfcTbiYW25Wkh` |
| pool top_up (currentBalance fix) | `4ej6eKx99Tj2uaSgubxbDdq2Vq1k2azwyeTvS1VFSNcVAWjSYpnc3iz5iruRTzDUxphR41KRSyYAeVLUjBdkq6rD` |
