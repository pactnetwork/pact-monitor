/**
 * Structured error model for `@q3labs/pact-operator-sdk`.
 *
 * Authority semantics matter on V1: most ops require ProtocolConfig.authority,
 * but `top_up_coverage_pool` requires CoveragePool.authority — distinct
 * mismatch codes so callers can recover deterministically.
 */
export enum OperatorErrorCode {
  /** createOperator() received an invalid/missing required config field. */
  CONFIG_INVALID = "CONFIG_INVALID",
  /** Supplied signer's pubkey != on-chain ProtocolConfig.authority. */
  AUTHORITY_MISMATCH = "AUTHORITY_MISMATCH",
  /** Supplied signer's pubkey != on-chain CoveragePool.authority (topup only). */
  POOL_AUTHORITY_MISMATCH = "POOL_AUTHORITY_MISMATCH",
  /** Referenced endpoint slug is not registered on-chain. */
  ENDPOINT_NOT_REGISTERED = "ENDPOINT_NOT_REGISTERED",
  /** Attempted to register a slug that already exists on-chain. */
  ENDPOINT_ALREADY_REGISTERED = "ENDPOINT_ALREADY_REGISTERED",
  /** ProtocolConfig is paused; settle path halted. */
  PROTOCOL_PAUSED = "PROTOCOL_PAUSED",
  /** Tx simulation failed (returned in opts.simulationFailure for diagnosis). */
  SIMULATION_FAILED = "SIMULATION_FAILED",
  /** lastValidBlockHeight elapsed before tx confirmed. */
  BLOCK_HEIGHT_EXCEEDED = "BLOCK_HEIGHT_EXCEEDED",
  /** RPC error during send/confirm/simulate. */
  RPC_ERROR = "RPC_ERROR",
  /** Affiliate read API returned non-2xx or malformed JSON. */
  AFFILIATE_READ_FAILED = "AFFILIATE_READ_FAILED",
}

export class OperatorError extends Error {
  readonly code: OperatorErrorCode;
  readonly cause?: unknown;
  readonly details?: Record<string, unknown>;

  constructor(
    code: OperatorErrorCode,
    message: string,
    opts?: { cause?: unknown; details?: Record<string, unknown> },
  ) {
    super(message);
    this.name = "OperatorError";
    this.code = code;
    this.cause = opts?.cause;
    this.details = opts?.details;
    Object.setPrototypeOf(this, OperatorError.prototype);
  }
}

export function isOperatorError(e: unknown): e is OperatorError {
  return e instanceof OperatorError;
}
