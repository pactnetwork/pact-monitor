// Codama-style TS client surface for `@pact-network/insurance`.
//
// Bootstrapped in WP-5 (first Pinocchio handler). Extends per-instruction in
// successive WPs. Re-generate with:
//   pnpm --filter @pact-network/insurance codama:generate

export * from './programs/pactInsurance.js';
export * from './instructions/initializeProtocol.js';
export * from './instructions/updateConfig.js';
export * from './accounts/protocolConfig.js';
export * from './types/initializeProtocolArgs.js';
export * from './types/updateConfigArgs.js';
