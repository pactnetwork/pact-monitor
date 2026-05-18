/**
 * `@pact-network/protocol-evm-v1-client` — TypeScript client (viem) for the
 * Pact Network EVM v1 protocol contracts on Circle Arc.
 *
 * Sibling to `@pact-network/protocol-v1-client` (Solana); mirrors its module
 * map (design spec §5): `pda.ts → addresses.ts`, `instructions.ts →
 * encode.ts`, `state.ts → state.ts`, `errors.ts → errors.ts`, `constants.ts →
 * constants.ts`, `helpers.ts`. WP-EVM-06.
 *
 * Module re-exports are added by T2..T6.
 */

/** Package version (mirrors package.json). */
export const PROTOCOL_EVM_V1_CLIENT_VERSION = "0.1.0";
