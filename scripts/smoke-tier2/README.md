# Tier-2 Surfpool E2E Smoke Harness

Stress-tests the Pact Network V1 off-chain stack end-to-end against a local
surfpool validator with the actual program deployed. Designed to catch:

1. **B1** — the cross-process per-call `shares` payload contract (settler → indexer).
2. `settle_batch` lands real on-chain txs for ~45 mixed-outcome events split
   into batches of 3 (the FIX-1 cap).
3. The indexer's reconciliation matches on-chain `CoveragePool.current_balance`
   and `Treasury` vault for every endpoint.
4. (Bonus) `pause_protocol` kill-switch round-trip — the protocol halts and
   resumes correctly.

**This harness is destructive to the local Postgres at port 5433.** It writes
schema migrations, ingests events, and never cleans up. Run `pnpm db:reset`
from the repo root afterwards if you want a clean slate.

## Layout

| File                       | Purpose                                                                                       |
|----------------------------|-----------------------------------------------------------------------------------------------|
| `00-setup.ts`              | Generate gitignored test keypairs (program, authorities, 5 agents, vault keys, USDC mint)     |
| `01-deploy.sh`             | sed-rewrite `declare_id!` → rebuild SBF → `solana program deploy` → revert lib.rs             |
| `02-init-protocol.ts`      | 8 init txs: protocol_config + treasury + settlement_authority + 5× register_endpoint          |
| `03-fund-agents.ts`        | Cheatcode-mint USDC to agents, SPL-Approve the SA PDA, top up coverage pools                  |
| `04-run-stack.sh`          | Start Pub/Sub emulator, indexer, settler                                                      |
| `04b-stop-stack.sh`        | Kill all background services started by `04-run-stack.sh`                                     |
| `05-fire-50-calls.ts`      | Publish 50 mixed-outcome `SettleMessage`s to `pact-settle-events`                             |
| `06-reconcile.ts`          | Read on-chain CoveragePool + Treasury balances, compare to indexer Postgres state             |
| `07-pause-roundtrip.ts`    | (Bonus) `pause_protocol(true)` → assert next batch fails with 6032 → unpause → resume         |

## Pre-requisites

- `surfpool` on `$PATH` (or `/home/rick_quantum3labs_com/.local/bin/surfpool`)
- `solana` CLI ≥ 3.1.x
- Rust toolchain + `cargo-build-sbf` 3.1.x
- Postgres on `localhost:5433` (db `pact`, user `pact`, password `pact`) — start
  with `pnpm db:up` from repo root
- `gcloud` SDK with `pubsub-emulator` + `beta` components installed
- pnpm workspace installed (`pnpm install` from repo root)

## Run order (happy path)

```bash
# Terminal 1 — surfpool with mainnet/devnet fork (so the canonical USDC mint at
# 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU is fetched lazily).
surfpool start --network devnet --no-tui --port 8899

# Terminal 2 — smoke
cd scripts/smoke-tier2
pnpm install                       # one-time, picks up workspace deps
pnpm 00-setup                      # generate keypairs into .smoke-keys/
bash 01-deploy.sh                  # builds SBF, deploys, then reverts lib.rs
pnpm 02-init                       # 8 init instructions
pnpm 03-fund                       # mint USDC to agents, top up pools
bash 04-run-stack.sh               # start pubsub + indexer + settler
pnpm 05-fire                       # publish 50 events
sleep 60                           # let settler drain (batches every 5s, ~15 batches)
pnpm 06-reconcile                  # PASS / FAIL summary
pnpm 07-pause                      # (optional) kill-switch round-trip
bash 04b-stop-stack.sh             # tear down stack
```

## What goes in `.smoke-keys/` and why it must NEVER be committed

- `program.json` — secret key for the test program ID. Anyone with this can
  upgrade the deployed program. The on-chain program ID it derives is unique
  to each `00-setup.ts` invocation. **Gitignored.**
- `upgrade-authority.json` — controls program upgrades. **Gitignored.**
- `protocol-authority.json` — `ProtocolConfig.authority`; can rotate fee
  recipients, pause the protocol, etc. **Gitignored.**
- `settlement-authority.json` — the off-chain hot key the settler signs with.
  **Gitignored.**
- `treasury-vault.json`, `pool-vault-*.json`, `agent-*.json` — token-account
  keypairs and mock-agent owners. **Gitignored.**
- `test-usdc-mint.json` — generated for completeness; UNUSED in default flow
  (we use canonical devnet USDC via surfpool fork + `surfnet_setTokenAccount`
  cheatcode). **Gitignored.**

## Critical workaround: USDC mint

`initialize_protocol_config.rs` rejects any mint that isn't USDC_DEVNET
(`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`) or USDC_MAINNET
(`EPjFWdd5...`). To stay inside that constraint without modifying the program:

1. Run surfpool with `--network devnet` so the real devnet USDC mint is forked
   on first read.
2. Use the surfpool cheatcode `surfnet_setTokenAccount` (in `03-fund-agents.ts`)
   to credit USDC to agent ATAs and to the protocol authority's ATA — the
   cheatcode bypasses the missing devnet mint authority.
3. Pre-fund coverage pool USDC vaults via `top_up_coverage_pool` so refunds
   (`latency_breach` / `server_error` outcomes) have funds to draw from.

If `--network devnet` ever stops working (devnet outage, mint moved, etc.),
the alternative is to add a `smoke-test` cargo feature to the program that
overrides the `USDC_DEVNET`/`USDC_MAINNET` check with a env-supplied test
mint constant. Document that change separately — do NOT commit it on the
smoke harness branch.

## Critical workaround: lib.rs `declare_id!` rewrite

The on-chain program's PDA derivers (`pda.rs`) hardcode the program ID via
`crate::ID`, which comes from `solana_address::declare_id!` in `lib.rs`. To
deploy the same binary at a fresh test program ID without breaking PDA
derivation, `01-deploy.sh`:

1. Backs up `lib.rs` to `lib.rs.smoke-tier2.bak`.
2. `sed -i` rewrites the `declare_id!` constant to the test pubkey from
   `.smoke-keys/program.json`.
3. Runs `cargo build-sbf --features bpf-entrypoint`.
4. `solana program deploy`s the resulting binary at the test program ID.
5. **Always reverts** the lib.rs rewrite via a `trap restore_lib_rs EXIT`
   bash trap — even on build failure. The lib.rs change MUST NEVER reach
   git. Verify with `git status` after the script exits.

If `01-deploy.sh` is killed mid-flight (SIGKILL, panic, OOM), the trap may
not run. Restore manually with:

```bash
mv packages/program/programs-pinocchio/pact-network-v1-pinocchio/src/lib.rs.smoke-tier2.bak \
   packages/program/programs-pinocchio/pact-network-v1-pinocchio/src/lib.rs
```

## Acceptance criteria → script mapping

| #   | Criterion                                                                        | Script                                  |
|-----|----------------------------------------------------------------------------------|-----------------------------------------|
| 1   | Program deploys to surfpool at a test ID                                         | `01-deploy.sh` + `solana program show` |
| 2   | 8 init instructions land; PDAs exist                                              | `02-init-protocol.ts`                  |
| 3   | Indexer + Postgres + migrations up                                                | `04-run-stack.sh`                      |
| 4   | Settler bound to surfpool RPC + emulator + SA keypair                             | `04-run-stack.sh`                      |
| 5   | 50 mixed-outcome events fired with correct distribution                           | `05-fire-50-calls.ts`                  |
| 6   | Settler submits ~15 settle_batch txs (45 settleable / 3 cap), each lands          | settler logs + `06-reconcile.ts`       |
| 7   | Indexer ingests every batch; Settlement, Call, RecipientShare, Earnings rows     | `06-reconcile.ts`                      |
| 8   | On-chain CoveragePool.current_balance ≡ indexer PoolState.currentBalanceLamports | `06-reconcile.ts`                      |
| 9   | (Bonus) `pause_protocol` round-trip                                               | `07-pause-roundtrip.ts`                |
