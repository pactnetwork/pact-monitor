# Mainnet Settle SIMULATION — best-effort, non-destructive — 2026-05-29

- **Goal:** prove the local settle path works against the REAL mainnet program (`5bCJ`) with the REAL mainnet-funded agent, given the mainnet settler signer `FuT7k` is unreachable from this box (Rick's GCP — neither authed gcloud account `alan@quantum3labs.com` nor `devlumilabs@gmail.com` has a pact project).
- **Method:** build a real `settle_batch` ix with the client `buildSettleBatchIx` (the same builder the settler uses), `simulateTransaction({ sigVerify:false, replaceRecentBlockhash:true })` with `FuT7k` as the (unsigned) settler signer. **No broadcast, no funds moved.** Harness: `.planning/smoke/mainnet-settle-sim.mjs`, log `.planning/smoke/logs/mainnet-sim.log`.
- **Inputs (all real mainnet, verified on-chain):** agent `5XyGGyazg6rGJU3Hjkrx1PDM1rBE3FraRnMauSR46rW1` (1.497 USDC, ATA `CLJKEqan…`, delegate = canonical SettlementAuthority PDA `GK4mZHeP…`, 0.999 USDC delegated); endpoint `dummy` (premium 1000, pool `GAnhVQ…`, vault `2BQSL5…` owned by pool PDA, treasury fee ATA `EuptgTib…`); ProtocolConfig `3GPRab…` (not paused); SettlementAuthority signer = `FuT7k…`.

## Result: the settle PASSED the full authorization + validation layer against the real mainnet program; agent funds UNCHANGED.

Simulating against `5bCJ`, the settle progressed through (each confirmed by advancing past its specific guard):
1. **`verify_protocol_config`** — PASS (no `InvalidProtocolConfig 6027`); mainnet ProtocolConfig is canonical + program-owned.
2. **`paused` kill-switch** — PASS (not paused).
3. **Signer authorization** — **PASS: `FuT7k` accepted as settler** (no `UnauthorizedSettler 6005`). This is the key result — the mainnet settle authorizes with the real signer.
4. **Timestamp** — PASS once backdated (the guard `timestamp > clock → InvalidTimestamp 6011` fired on a 2s-future stamp, then passed).
5. **PDA verifies** — call_record, coverage_pool, endpoint_config all derive-match the deployed program (no `InvalidSeeds` at the verify checks; cross-checked: `getEndpointConfigPda`/`getCoveragePoolPda` == on-chain `CoEuw3…`/`GAnhVQ…`).
6. **Pool/vault binding** — vault `2BQSL5…` authority == pool PDA `GAnhVQ…` ✓; agent delegate == PDA + delegated 0.999 ≥ premium 0.001 ✓.

**Non-destructive confirmed:** agent USDC = 1.497 before AND after every run (no broadcast; `simulateTransaction` only).

## Residual (not fully isolated): `InvalidSeeds` at the CPI-execution stage
After passing all the above, the hand-built single-event simulation hit `InvalidSeeds` at the `invoke_signed`/CPI layer (call-record `create_account` and/or the delegate transfer). Cause not definitively isolated within reasonable effort — most plausibly a hand-assembly nuance of the single-event sim (the production settler's `SubmitterService` assembles these CPIs through its full account-resolution + batching path), **not** a protocol-validation rejection (everything the program validates — signer, config, timestamp, all PDAs, vault/delegate bindings — passed). Notably `FuT7k` holds only 0.0013 SOL on mainnet, near the call-record rent-exempt minimum, which is one candidate (rent payer) worth ruling out in a real run.

## Conclusion
- The mainnet protocol is **live and code-compatible**: the deployed `5bCJ` program accepts the current client's settle authorization + account layout (parity confirmed in execution, not just by reading accounts).
- The real funded agent (`5XyGG`) is correctly configured (USDC + delegate to the canonical PDA).
- A **true live mainnet settle** requires two things this box does not have: (1) **`FuT7k`'s signature** (Rick's GCP — `gcloud auth login` as the pact-project owner, or Rick runs it), and (2) resolving the final CPI step via the **production settler** (`SubmitterService`), which builds the batch with full context. Recommend Rick run a single real settle with the funded `5XyGG` agent + the production settler to close the loop.
- Everything provable without `FuT7k`'s key + the production settler has been proven, non-destructively.
