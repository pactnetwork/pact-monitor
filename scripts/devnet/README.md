# Pact Network V1 — Devnet Init Runbook

Procedure for initializing the V1 protocol on Solana devnet. **Run from Rick's laptop.** Same model as `scripts/mainnet/` but pointed at devnet with a single `helius` endpoint instead of the mainnet 5.

The devnet **program** is already deployed (`5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5`); this script handles the post-deploy PDA bring-up: ProtocolConfig, Treasury, SettlementAuthority, and one `helius` EndpointConfig + CoveragePool.

## TL;DR

```bash
# Phase 1: laptop prep — keypairs
mkdir -p ~/pact-devnet-keys && chmod 700 ~/pact-devnet-keys

# Reuse your existing dev hot key for both upgrade-authority + settler signer
# (per plan §12 settled decisions). Copy or symlink:
cp ~/.config/solana/id.json ~/pact-devnet-keys/pact-devnet-upgrade-authority.json
cp ~/.config/solana/id.json ~/pact-devnet-keys/settlement-authority.json

# Devnet program-ID keypair (already exists from the May 5 devnet deploy)
cp ~/.config/solana/pact-network-v1-program-keypair.json ~/pact-devnet-keys/

# Generate fresh vault keypairs
solana-keygen new --no-bip39-passphrase --silent --outfile ~/pact-devnet-keys/treasury-vault.json
solana-keygen new --no-bip39-passphrase --silent --outfile ~/pact-devnet-keys/pool-vault-helius.json
chmod 600 ~/pact-devnet-keys/*.json

# Phase 2: fund the upgrade authority (need ~0.1 SOL devnet)
solana airdrop 1 $(solana-keygen pubkey ~/pact-devnet-keys/pact-devnet-upgrade-authority.json) --url devnet

# Phase 3: rehearsal (no txs sent)
cd /path/to/pact-monitor/scripts/devnet
pnpm install
DRY_RUN=1 pnpm init

# Phase 4: real init
pnpm init
```

Output lands at `scripts/devnet/.devnet-state.json` — captures every PDA + tx signature.

## Required keypairs

In `$DEVNET_KEYS_DIR` (default `~/pact-devnet-keys`):

| File | Purpose | Source |
|---|---|---|
| `pact-network-v1-program-keypair.json` | Devnet program ID `5jBQb7fL…` | already exists at `~/.config/solana/pact-network-v1-program-keypair.json` — copy or symlink |
| `pact-devnet-upgrade-authority.json` | Protocol auth + Treasury auth + tx fee payer | reuse your `~/.config/solana/<key>.json` per plan §12 — copy or symlink |
| `settlement-authority.json` | Settler service signing key | reuse same key as upgrade-authority on devnet per plan §12; can be a separate key if you want strict role separation |
| `treasury-vault.json` | Treasury USDC vault account | fresh — `solana-keygen new` |
| `pool-vault-helius.json` | helius pool USDC vault | fresh — `solana-keygen new` |

The settlement-authority key's **pubkey** is what gets registered on-chain in step 3 (`initialize_settlement_authority`). The settler service running on Railway must hold the **same keypair** in its `SETTLEMENT_AUTHORITY_KEY` env var (base58-encoded). See the project root runbook `docs/devnet-railway-deploy.md` §4 for the base58-encoding command.

## Env

| Var | Default | Notes |
|---|---|---|
| `DEVNET_KEYS_DIR` | `~/pact-devnet-keys` | `~/`-prefix accepted |
| `DEVNET_RPC_URL` | `https://api.devnet.solana.com` | Swap to Helius devnet if rate-limited |
| `DRY_RUN` | unset (real mode) | Set `1` to print plan + skip sending |

## Idempotency

Every step checks `pdaExists()` first. If `ProtocolConfig` already exists on-chain, that step prints `already initialized — skipping` and moves on. Safe to re-run after partial failure.

State file `.devnet-state.json` accumulates every PDA + tx signature across runs.

## After init

1. **Capture the settler signer pubkey:**
   ```sh
   solana-keygen pubkey ~/pact-devnet-keys/settlement-authority.json
   ```
   Paste the corresponding **base58-encoded keypair** into the Railway settler service's `SETTLEMENT_AUTHORITY_KEY` env var (see `docs/devnet-railway-deploy.md` §4).

2. **Fund the settler signer with ≥ 0.05 devnet SOL** (~5,000 settle txs at 10k lamports each):
   ```sh
   solana airdrop 1 <settler-signer-pubkey> --url devnet
   ```

3. **Optionally bootstrap the devnet `pay-default` coverage pool** if you want `dummy-upstream` running in PayAI mode (real x402 settlement). The existing `scripts/pay-default-bootstrap.ts` already supports devnet — it's the default path. Devnet invocation:
   ```sh
   PACT_PRIVATE_KEY=~/pact-devnet-keys/pact-devnet-upgrade-authority.json \
   PACT_RPC_URL="https://api.devnet.solana.com" \
   PROGRAM_ID=5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5 \
     pnpm exec tsx scripts/pay-default-bootstrap.ts --confirm
   ```
   USDC_MINT defaults to `USDC_MINT_DEVNET` (`4zMMC9srt5…`) — no override needed. The script prints the pay-default pool's authority wallet pubkey at the end; paste that into the `DUMMY_X402_PAY_TO` env var on the Railway dummy-upstream service.

   For the **first cut you can skip this step entirely** and leave `DUMMY_X402_USE_PAYAI` unset on dummy-upstream (emulation mode). It still serves the 402 challenge — just no real USDC moves on `pact pay` calls.

4. **Run the smoke probe:**
   ```sh
   cd /path/to/pact-monitor
   ./scripts/devnet-smoke/health.sh
   ```

## Verification

```sh
solana program show 5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5 --url devnet
solana account <protocolConfigPda> --url devnet
solana account <treasuryPda> --url devnet
solana account <helius-coveragePool> --url devnet
```

All four should return account data (length > 0). The PDAs are printed at the end of `pnpm init`.

## Related

- Mainnet equivalent: `scripts/mainnet/init-mainnet.ts` + `scripts/mainnet/README.md`
- Plan: `docs/superpowers/plans/2026-05-15-devnet-mirror-build.md` (branch `plan/devnet-mirror-build`)
- Railway runbook: `docs/devnet-railway-deploy.md`
- Smoke: `scripts/devnet-smoke/health.sh`
