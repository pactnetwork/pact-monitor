/**
 * Structured error model for `@pact-network/sdk`.
 *
 * Golden rule: `pact.fetch()` NEVER throws a `PactError`. Pact-internal
 * failures (discovery, proxy, signing, indexer) degrade silently to a bare
 * fetch and surface as a `degraded` event. Only the explicit ops
 * (`setup`, `topUp`, `revoke`, `policy`, `estimate`) and `createPact()`
 * config validation throw.
 *
 * Codes are V1-adapted. The design draft's V2/oracle codes
 * (`POLICY_NOT_FOUND`, `POOL_PROVISION_FAILED`, `CLAIM_FAILED`) are
 * intentionally absent — V1 has no Policy PDA, no agent-side provisioning,
 * and no agent-submitted claims.
 */
export enum PactErrorCode {
  /** createPact() received an invalid/missing required config field. */
  CONFIG_INVALID = "CONFIG_INVALID",
  /** A signer is required for this operation but was not usable. */
  SIGNER_MISSING = "SIGNER_MISSING",
  /** Hostname did not resolve to a registered Pact endpoint slug. */
  ENDPOINT_NOT_REGISTERED = "ENDPOINT_NOT_REGISTERED",
  /** The resolved endpoint is paused by the operator. */
  ENDPOINT_PAUSED = "ENDPOINT_PAUSED",
  /** Agent USDC associated token account does not exist. */
  ATA_NOT_FOUND = "ATA_NOT_FOUND",
  /** SPL delegated allowance to the SettlementAuthority is below required. */
  ALLOWANCE_INSUFFICIENT = "ALLOWANCE_INSUFFICIENT",
  /** Agent USDC ATA balance is below required. */
  BALANCE_INSUFFICIENT = "BALANCE_INSUFFICIENT",
  /** An on-chain transaction (approve/revoke) failed to confirm. */
  ON_CHAIN_TX_FAILED = "ON_CHAIN_TX_FAILED",
  /** The Pact Market proxy was unreachable (triggers degraded fallback). */
  PROXY_UNREACHABLE = "PROXY_UNREACHABLE",
  /** The indexer was unreachable (non-fatal; poller retries silently). */
  INDEXER_UNREACHABLE = "INDEXER_UNREACHABLE",
  /** Request signing failed (no usable secret key for the signer). */
  SIGNATURE_FAILED = "SIGNATURE_FAILED",
  /** The proxy discovery document could not be fetched/parsed. */
  DISCOVERY_FAILED = "DISCOVERY_FAILED",
}

export class PactError extends Error {
  readonly code: PactErrorCode;
  readonly cause?: unknown;
  /** Whether retrying the same operation could plausibly succeed. */
  readonly retryable: boolean;

  constructor(
    code: PactErrorCode,
    message: string,
    opts?: { cause?: unknown; retryable?: boolean },
  ) {
    super(message);
    this.name = "PactError";
    this.code = code;
    this.cause = opts?.cause;
    this.retryable = opts?.retryable ?? false;
    Object.setPrototypeOf(this, PactError.prototype);
  }
}

export function isPactError(e: unknown): e is PactError {
  return e instanceof PactError;
}
