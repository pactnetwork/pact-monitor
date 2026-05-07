# Deployed Program ID

**Network:** Solana Devnet
**Program ID:** `5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5`
**ProgramData address:** `2YETBtKq1DnxCVEHwKRmTjmesq6pA84Q8TBquqeHEapy`
**Upgrade authority:** `47Fg5JqMsCeuRyDsFtD7Ra7YTdzVmTr2mZ1R2dUkZyfS` (devnet hot key — rotate to multisig before mainnet)
**Latest upgrade signature:** `5bSPMvGK8Ec4E5efcw4mqXyWC32vSZZo7HeKB9KGv9PpmWKHSWUv79yL7yJeuUf6ZAY8xi3q4ifeLgcp3be5MTZX`
**Latest upgrade date:** 2026-05-05
**Binary size:** 86,424 bytes (~85 KB)
**Last deployed in slot:** 460315243

This is the active v1 deploy after the Step C substantive refactor + the codex security review fixes (privileged-handler ProtocolConfig PDA verification, SettlementStatus per-event status enum replacing silent skips, fee-recipient validation tightening). All clients should target this program ID.

### Upgrade history

| Slot | Signature | Size | Notes |
|---|---|---|---|
| 460315243 | `5bSPMvGK8Ec4…` | 86,424 B | Codex feedback fixes (commits `ed3af77`, `2c27eba`, `cd2bdba`, `f4f45af`) |
| 460289499 | `PZk6rAa7CNHas9…` | 72,896 B | `declare_id!` correction to `5jBQb7fL…` |
| 460289499 | `3jSoem3L9LRdsP55…` | 72,896 B | Initial deploy at this address (Step C substantive refactor) |

## Previous deploys

| Program ID | Status | Notes |
|---|---|---|
| `DhWibM2z3Vwp5VmJyashoeZCAZHLFKeHab8o12qYsiQc` | **Orphaned** | Original Wave 1A deploy of the pre-refactor binary (58 KB). The upgrade authority for this program ID was not accessible from the deployer environment, so the Step C refactor was deployed at a new program ID (above) rather than redeployed in place. The orphan still runs the old code path on devnet but is no longer canonical and should not be referenced by any client. |

## Program keypair

The program-ID keypair lives at `~/.config/solana/pact-network-v1-program-keypair.json` (perms 0600) with a backup at `~/keypairs-backup/pact-network-v1-program-keypair-2026-05-05.json`. Losing this file means losing the ability to upgrade the program at this address forever — back it up off-box.
