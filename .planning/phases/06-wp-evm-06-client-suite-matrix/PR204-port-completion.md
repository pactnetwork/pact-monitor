## Arc EVM parity port COMPLETE (WP-EVM-02..06)

The behavioral-parity port of the Solana `pact-network-v1-pinocchio` program to Circle Arc (EVM L1) is **complete**. Parity is verified against the 10 LiteSVM test files as the authoritative oracle, plus fuzz; every mechanism divergence is formally recorded in the parity matrix and the design spec is corrected.

### Per-WP deliverables (branch `feat/arc-protocol-v1`)

- **WP-EVM-02** — `PactErrors` (30 custom errors), `PactEvents`, `ArcConfig` (ported `constants.rs`), `FeeValidation` library (ported `fee.rs` incl. the separate `validateDefaultTemplate`), `PactRegistry` full logic; ported registry/treasury/protocol-config tests.
- **WP-EVM-03** — `PactPool` full logic (per-slug `PoolState`, `topUp`, `balanceOf`, USDC custody, SETTLER-gated credit/debit/refund/payout hooks); ported pool tests. Decisions D1-D6.
- **WP-EVM-04** — `PactSettler` happy path (`settleBatch` per-event loop: premium-in via `transferFrom` try/catch → `DelegateFailed`, fee fan-out, breach refund, `CallSettled`, stats); E1-E4 + LOCKED guard precedence; ported happy-path settle-batch tests.
- **WP-EVM-05** — settler hardening: `ExposureCapClamped` + `PoolDepleted` clamps (pool-then-cap order), protocol/endpoint kill switches, `BatchTooLarge` edges; P1/P3 final forms; ported pause/exposure/auth tests.
- **WP-EVM-06** — `@pact-network/protocol-evm-v1-client` (viem, pnpm workspace member mirroring `protocol-v1-client`: addresses/encode/state/errors/constants/helpers) with a committed-ABI drift guard; consolidated forge fuzz + `.gas-snapshot`; live `IERC20(USDC).decimals()==6` assertion; the per-variant parity matrix; formal design-spec corrections.

### Final test totals

- **forge: 109/109** (102 ported LiteSVM scenarios preserved + 5 fuzz properties @ 257 runs each + 2 USDC-decimals).
- **client: 41/41** (`@pact-network/protocol-evm-v1-client`, builds clean).
- Fuzz proved `premium*bps/10_000` u64 floor-div + value conservation bit-identical to the spec §3 oracle.

### Parity matrix + formal spec corrections

- Parity matrix: `docs/superpowers/specs/2026-05-18-arc-parity-matrix.md` — every `PactError` variant (30/30) + every design-spec §3 behavior tagged IDENTICAL / OPTIMIZED-DIVERGENCE (§4 ref) / N-A-ON-EVM (rationale), with file:line authority; includes the `05-NA-MATRIX` rows verbatim + the P3 corner.
- Design spec `docs/superpowers/specs/2026-05-15-arc-parity-port-design.md` formally corrected for **all 8 handoff §(d) items**: (1) §3 now lists 30 variants (`FeeBpsSumOver10k` added); (2) §4 #7 corrected — `InvalidAffiliateAta` is OPTIMIZED-DIVERGENCE, only `FeeRecipientInvalidUsdcMint` true N-A; (3) `updateEndpointConfig` per-field→typed-set; (4) `created_at` lazy-at-`topUp`; (5) ruling #8 D1-scope refinement; (6) P3 corner; (7) N-A rows; (8) Solana-platform-mechanics N-A class — enumerated in a "WP-EVM-06 Corrections" appendix.
- **Corrects PR #201 §7.1**: the TS client IS required for parity at the integration layer (settler `ChainAdapter` + indexer per-chain poller); delivered.

### Remaining

**WP-EVM-07 (Arc testnet deploy + arcscan verify) is the only remaining item, and is a SEPARATE cycle** — explicitly out of the parity-port scope, captain/Rick-initiated when ready. Contracts are LOCKED through WP-05; WP-06 added zero contract behavior. No mainnet.
