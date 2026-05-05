# Deployed Program ID

**Network:** Solana Devnet
**Program ID:** `5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5`
**ProgramData address:** `2YETBtKq1DnxCVEHwKRmTjmesq6pA84Q8TBquqeHEapy`
**Upgrade authority:** `47Fg5JqMsCeuRyDsFtD7Ra7YTdzVmTr2mZ1R2dUkZyfS` (devnet hot key — rotate to multisig before mainnet)
**Deploy signature:** `3jSoem3L9LRdsP55Ybxgnkw3PAxA3L9aUeJHAcvL8BgZpaXBrwMyd6TGUpKy6Z5Q8PcFojjEXdKJXVJGdyVQGhU3`
**Deploy date:** 2026-05-05
**Binary size:** 72,896 bytes (~71 KB)
**Last deployed in slot:** 460289499

This is the active v1 deploy after the Step C substantive refactor (per-endpoint coverage pools, SPL Token approval-based agent custody, interchangeable fee recipients with pool-as-residual + Treasury + ProtocolConfig). All clients should target this program ID.

## Previous deploys

| Program ID | Status | Notes |
|---|---|---|
| `DhWibM2z3Vwp5VmJyashoeZCAZHLFKeHab8o12qYsiQc` | **Orphaned** | Original Wave 1A deploy of the pre-refactor binary (58 KB). The upgrade authority for this program ID was not accessible from the deployer environment, so the Step C refactor was deployed at a new program ID (above) rather than redeployed in place. The orphan still runs the old code path on devnet but is no longer canonical and should not be referenced by any client. |

## Program keypair

The program-ID keypair lives at `~/.config/solana/pact-network-v1-program-keypair.json` (perms 0600) with a backup at `~/keypairs-backup/pact-network-v1-program-keypair-2026-05-05.json`. Losing this file means losing the ability to upgrade the program at this address forever — back it up off-box.
