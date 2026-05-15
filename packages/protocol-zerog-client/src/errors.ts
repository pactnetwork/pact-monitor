import {
  type Abi,
  type Hex,
  BaseError,
  ContractFunctionRevertedError,
  toFunctionSelector,
} from 'viem';
import { pactCoreAbi } from './abi.js';

/**
 * Custom-error decoding for PactCore. Two layers:
 *
 *  1. `buildErrorSelectorMap(abi)` — derives `selector → errorName` from the
 *     ABI itself (NOT a hard-coded list). The test asserts the entry count
 *     equals the number of `type:'error'` items in the built ABI, so this
 *     stays correct even as the contract gains/loses errors. NB: the built
 *     ABI also carries inherited OZ errors (`ReentrancyGuardReentrantCall`,
 *     `SafeERC20FailedOperation`) — those are real revert paths and ARE
 *     mapped on purpose.
 *
 *  2. `decodeContractError(err)` — walks a thrown viem error to the
 *     `ContractFunctionRevertedError` and returns `{ name, message }` using
 *     viem's own decoding (which used the ABI we passed at call time).
 */

/** Human-friendly messages for PactCore's own errors. */
const FRIENDLY: Record<string, string> = {
  Unauthorized: 'Caller is not authorized for this action',
  ProtocolIsPaused: 'The protocol is globally paused',
  EndpointNotFound: 'No endpoint registered for this slug',
  EndpointIsPaused: 'This endpoint is paused',
  EndpointAlreadyExists: 'An endpoint is already registered for this slug',
  BatchTooLarge: 'Batch exceeds MAX_BATCH_SIZE (50)',
  DuplicateCallId: 'A record with this callId was already settled',
  InvalidFeeRecipients: 'Fee recipient set failed validation',
  BpsSumExceedsCap: 'Sum of fee bps exceeds MAX_TOTAL_FEE_BPS (3000)',
  TreasuryCardinalityViolation:
    'There must be exactly one Treasury fee recipient',
  TreasuryBpsZero: 'The Treasury recipient must have bps > 0',
  PremiumTooSmall: 'Premium is below MIN_PREMIUM (100)',
  InvalidTimestamp: 'Record timestamp is in the future',
  InvalidSlug: 'Slug has a byte outside the printable ASCII range',
  // inherited OZ errors (still reachable)
  ReentrancyGuardReentrantCall: 'Reentrant call blocked by ReentrancyGuard',
  SafeERC20FailedOperation: 'An ERC20 transfer/transferFrom failed',
};

export interface DecodedContractError {
  name: string;
  message: string;
  args?: readonly unknown[];
}

/** Build `selector → errorName` from any ABI's error entries. */
export function buildErrorSelectorMap(abi: Abi): Record<Hex, string> {
  const map: Record<Hex, string> = {};
  for (const item of abi) {
    if (item.type !== 'error') continue;
    const sig = `${item.name}(${item.inputs.map((i) => i.type).join(',')})`;
    map[toFunctionSelector(sig)] = item.name;
  }
  return map;
}

/** Pre-built map for PactCore (covers PactCore + inherited OZ errors). */
export const PACT_CORE_ERROR_SELECTORS: Record<Hex, string> =
  buildErrorSelectorMap(pactCoreAbi as unknown as Abi);

/**
 * Walk a thrown viem error to the contract revert and return the decoded
 * custom-error name + a friendly message. Returns `undefined` if the error
 * is not a recognizable contract revert (e.g. a plain RPC failure).
 */
export function decodeContractError(
  err: unknown,
): DecodedContractError | undefined {
  if (!(err instanceof BaseError)) return undefined;

  const revert = err.walk(
    (e) => e instanceof ContractFunctionRevertedError,
  ) as ContractFunctionRevertedError | null;
  if (!revert) return undefined;

  const name = revert.data?.errorName;
  if (!name) {
    // Fall back to raw selector lookup if viem couldn't decode (e.g. no ABI).
    const raw = (revert as unknown as { raw?: Hex }).raw;
    if (raw && raw.length >= 10) {
      const sel = raw.slice(0, 10) as Hex;
      const mapped = PACT_CORE_ERROR_SELECTORS[sel];
      if (mapped) {
        return { name: mapped, message: FRIENDLY[mapped] ?? mapped };
      }
    }
    return undefined;
  }

  return {
    name,
    message: FRIENDLY[name] ?? name,
    args: revert.data?.args,
  };
}
