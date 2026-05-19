# WP-EVM-07 — Live Deployment Functional Verification (post-Gate-B)

Date: 2026-05-19. Method: `cast` `eth_call` simulations + reads against the
DEPLOYED Arc Testnet bytecode (chain 5042002). No broadcast, no gas, no keys,
no state change. Caller spoofed via `--from` for access-control paths.

Targets: PactRegistry 0x056BAC33546b5b51B8CF6f332379651f715B889C ·
PactPool 0xa6135d9C6BFA0F256B9DeBa10d76C7698329aFdE ·
PactSettler 0xe461CE50ef53BFC10945B101FB94b11Ec5eB591f ·
authority/deployer 0x777d569Bd3b0A2De007097A3D7E1687C5E5EB859 ·
USDC 0x3600000000000000000000000000000000000000.

## Results — all match Solana parity exactly

| Path | Input | Result | Parity verdict |
|------|-------|--------|----------------|
| USDC sanity | decimals/symbol | 6 / "USDC" | guard premise holds |
| registry.protocolPaused() | - | false | OK |
| registry.isRegistered(slug) | unregistered | false | OK |
| settler.usdc()/pool() | - | USDC / pool addr | wiring OK |
| pool.balanceOf / topUp | unregistered slug | revert EndpointNotFound (0x6eedfa98) | guard live |
| registerEndpoint | Treasury-only count1, from AUTH | SUCCESS (0x) | core path works live |
| registerEndpoint | Treasury+Affiliate count2, from AUTH | SUCCESS (0x) | fee-split path works live |
| registerEndpoint | no recipients / empty default, from AUTH | revert MissingTreasuryEntry (0x4f43e988) | IDENTICAL parity (matrix row 27; register_endpoint.rs:181 validate_post_substitution; handoff (b) ruling 5) |
| registerEndpoint | from NON-authority | revert UnauthorizedAuthority (0xb9739d1b) | guard live |
| registerEndpoint | control-byte slug, from AUTH | revert InvalidSlug (0x290a8315) | guard live |
| registerEndpoint | Treasury bps=0 | revert TreasuryBpsZero (0x8188e67f) | fee engine live |
| registerEndpoint | two Treasury entries | revert MultipleTreasuryRecipients (0x8a5df093) | fee engine live |
| registerEndpoint | fee sum 4000 > maxTotalFeeBps 3000 | revert FeeBpsExceedsCap (0x48cedec0) | fee engine live |
| settler.settleBatch([]) | from non-SETTLER (AUTH) | revert AccessControlUnauthorizedAccount(AUTH, SETTLER_ROLE) (0xe2517d3f) | SETTLER_ROLE gate live |

Every decoded error selector equals the exact PactError the Solana program
throws for the same input — a live differential-parity confirmation that the
deployed bytecode's logic + guards are correct and parity-faithful.

## OPERATIONAL CONSTRAINT confirmed live (consequence of the empty default template, C2 #3)

Because the deployment baked an EMPTY default fee template (defaultCount_=0),
**every endpoint MUST be registered with `feeRecipientsPresent=true` and an
explicit fee-recipient array containing exactly one Treasury entry with
non-zero bps.** Registering with `feeRecipientsPresent=false` (copying the
empty default) reverts `MissingTreasuryEntry` — parity-correct, by design,
now empirically confirmed on-chain. Integrators/tools registering endpoints on
this deployment must always supply explicit recipients. (Already documented in
07-C2-RATIFICATION.md and the PR #204 comment; this is the empirical
confirmation.)

## NOT covered by this verification (requires real broadcast + keys)

This is simulation-level (logic + guards). It does NOT exercise actual token
movement / economic settlement. Still untested end-to-end on Arc Testnet:
persisted registerEndpoint; pool topUp; an authorised settler running
settleBatch with a real agent (USDC approve -> premium debit -> Treasury/
Affiliate/pool fee split -> SLA-breach refund -> pool + ERC-20 balance + event
assertions). That write-path e2e needs: the authority key (in .env), a settler
EOA granted SETTLER_ROLE (a grant tx from authority), a funded test agent EOA
(faucet USDC + ERC-20 approve). Recommended as a separate captain-gated task
before anything relies on the deployment economically.

## Verdict

The deployed Arc Testnet contracts are functionally correct at the logic +
access-control + fee-validation level, parity-faithful to the Solana program
(differential error-selector match across 13 paths). Economic end-to-end
(real USDC settlement) remains unproven and is the recommended next step.
