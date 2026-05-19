# WP-EVM-07 — C2 Deploy-Parameter Ratification (written record)

Per GATE A verdict condition C2 (treasuryVault / maxTotalFeeBps / default
template are PERMANENT at deploy — no setters), the three baked-immutable
deploy parameters are hereby ratified by Rick/Alan before broadcast:

1. **Deployer EOA = protocol authority (C1).** `authority_` := the deployer
   EOA (`vm.addr(DEPLOYER_PRIVATE_KEY)`). No separate-authority branch
   (already implemented, commit 46d2ab9). The deployer holds
   DEFAULT_ADMIN_ROLE on registry + pool so the post-deploy SETTLER_ROLE
   grants succeed.

2. **TREASURY_VAULT_ADDRESS = the deployer EOA address.** Deliberate testnet
   simplification ("use the same as 1 for now"). Non-zero, conscious, not a
   throwaway-by-accident. Set in
   `packages/program-evm/protocol-evm-v1/.env`. The script rejects
   `address(0)` as a backstop; this human ratification is the primary
   control. MAINNET-HARDENING ITEM: split treasury into a real
   Safe/multisig distinct from the deployer before any mainnet deploy
   (fresh deploy; no migration since testnet).

3. **Default fee template = EMPTY (`defaultCount_ = 0`).** Confirmed
   ("empty, go"). Parity-valid (initialize_protocol_config.rs:138-156 —
   count == 0 allowed; FeeValidation.validateDefaultTemplate). Every
   endpoint registered on this deployment must declare its OWN fee
   recipients; there is no protocol-wide default treasury cut. Per-endpoint
   recipients remain fully expressible at registerEndpoint and adjustable
   via updateFeeRecipients(slug,...), so no capability is lost. Script
   already hardcodes empty defaults (commit 46d2ab9) — NO script change
   required.

## Operational preconditions confirmed

- `DEPLOYER_PRIVATE_KEY` is set in the CORRECT file:
  `packages/program-evm/protocol-evm-v1/.env` (the `packages/backend/.env`
  the user opened in the IDE was inspection only — NOT where the key lives).
- Deployer EOA is faucet-funded with testnet USDC (Arc gas = USDC;
  faucet.circle.com). User confirmed funded.
- `TREASURY_VAULT_ADDRESS` set in the same `.env` to the deployer EOA
  address.

## Effect

C2 fully satisfied. Broadcast boundary is UNBLOCKED. Crew proceeds:
T2 dry-run -> T3 broadcast + inline verify -> T4 arcscan fallback ->
T5 fill addresses.ts -> T6 check:abi post-deploy -> T7 read-only smoke ->
T8 write 07-REPORT-gateB.md, then STOP for the captain GATE B verdict.
No script change. No contract change. File-scoped commits. No push / no
PR #204 comment until GATE B captain approval.
