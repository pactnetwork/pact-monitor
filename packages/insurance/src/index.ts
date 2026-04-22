export { PactInsurance } from "./client.js";
export type {
  PactInsuranceConfig,
  PolicyInfo,
  ClaimSubmissionResult,
  EnableInsuranceArgs,
  TopUpDelegationArgs,
  CoverageEstimate,
  BilledEvent,
  LowBalanceEvent,
} from "./types.js";

// Codama-TS client surface (Pinocchio port — WP-5 onward). Exposed under an
// explicit namespace so existing Anchor-based exports above stay intact; the
// WP-17 cut-over will fold this in as the primary surface.
export * as generated from "./generated/index.js";
