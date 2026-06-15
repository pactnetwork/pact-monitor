/**
 * Maps Pact EVM custom-error 4-byte selectors to TypeScript-friendly names +
 * human-readable descriptions. EVM analogue of
 * `protocol-v1-client/src/errors.ts` (which maps Solana numeric codes).
 *
 * Numeric codes do NOT carry over to EVM (design spec §3): the parity binding
 * is name + trigger condition. The selector is `keccak256("Name()")[:4]` —
 * every one of error.rs's 30 `PactError` variants is mirrored 1:1 as a
 * zero-argument Solidity custom error in `PactErrors.sol` (handoff §(b)
 * ruling 1; `FeeBpsSumOver10k` is the 30th). Variants that lose meaning on
 * EVM (`InvalidAffiliateAta`, `FeeRecipientInvalidUsdcMint`) are kept in the
 * map for parity completeness; their reachability is recorded in the
 * WP-EVM-06 parity matrix (design spec §4 #7).
 *
 * Used by downstream consumers (settler `ChainAdapter`, indexer) to surface
 * meaningful messages from a reverted `settleBatch` / registry call rather
 * than a raw selector.
 */
import { toFunctionSelector, type Hex } from "viem";

import { PactErrorsAbi } from "./abi/PactErrors.js";

/**
 * Human-readable descriptions, keyed by error name. Mirrors the
 * `protocol-v1-client` message set; wording is EVM-adapted only where the
 * Solana sentence names a platform mechanism (PDA/ATA/lamports) — the
 * trigger condition (the parity contract) is unchanged.
 */
const MESSAGES: Record<string, string> = {
  InsufficientBalance:
    "Coverage pool has insufficient balance for the requested operation.",
  EndpointPaused:
    "Endpoint is paused; settleBatch will not accept events for it.",
  ExposureCapExceeded: "Hourly exposure cap exceeded for this endpoint.",
  UnauthorizedSettler: "Caller does not hold SETTLER_ROLE.",
  UnauthorizedAuthority:
    "Caller is not the protocol/pool authority for this operation.",
  DuplicateCallId:
    "callId has been settled before (already set in the settled-callId mapping).",
  EndpointNotFound: "No endpoint is registered for the given slug.",
  PoolDepleted: "Coverage pool exhausted — refund could not be paid.",
  InvalidTimestamp:
    "Event timestamp is in the future relative to the block clock.",
  BatchTooLarge: "Batch contains more events than MAX_BATCH_SIZE (50).",
  PremiumTooSmall: "Premium below MIN_PREMIUM (100).",
  InvalidSlug:
    "Slug contains a non-printable byte (must be ASCII 0x20..0x7E or zero).",
  ArithmeticOverflow: "Internal arithmetic overflow or underflow.",
  FeeRecipientArrayTooLong:
    "fee_recipients array longer than MAX_FEE_RECIPIENTS (8).",
  FeeBpsExceedsCap:
    "Per-entry or sum bps exceeds the endpoint's maxTotalFeeBps.",
  FeeBpsSumOver10k:
    "Sum of fee_recipients[*].bps exceeds 10000 (ABSOLUTE_FEE_BPS_CAP).",
  FeeRecipientDuplicateDestination:
    "Two fee_recipients share the same destination address.",
  FeeRecipientInvalidUsdcMint:
    "Mint check — N/A on EVM (recorded in the WP-EVM-06 parity matrix, §4 #7).",
  MultipleTreasuryRecipients:
    "More than one fee_recipient has kind == Treasury.",
  RecipientCoverageMismatch:
    "settleBatch event does not match the EndpointConfig fee-recipient count.",
  ProtocolConfigNotInitialized:
    "Protocol config not initialized — initialize it first.",
  TreasuryNotInitialized:
    "Treasury not initialized — set it before registerEndpoint.",
  EndpointAlreadyRegistered: "An endpoint already exists for this slug.",
  InvalidFeeRecipientKind: "fee_recipient.kind byte is not 0/1/2.",
  InvalidProtocolConfig: "Supplied protocol config is not valid.",
  InvalidTreasury: "Supplied treasury is not valid.",
  MissingTreasuryEntry:
    "fee_recipients does not contain exactly one Treasury entry.",
  TreasuryBpsZero: "Treasury entry's bps is zero — it must take a non-zero cut.",
  InvalidAffiliateAta:
    "Affiliate destination is the zero address (EVM-adapted residual of the Solana ATA check, §4 #7).",
  ProtocolPaused:
    "Protocol kill switch is engaged — settleBatch refuses all events until unpaused.",
};

export interface PactEvmError {
  name: string;
  message: string;
}

/** `keccak256("Name()")[:4]` for a zero-arg Pact custom error. */
export function pactErrorSelector(name: string): Hex {
  return toFunctionSelector(`${name}()`);
}

/** Selector (lowercase 0x + 8 hex) -> { name, message }, all 30 variants. */
export const PACT_EVM_ERRORS: Record<string, PactEvmError> = (() => {
  const out: Record<string, PactEvmError> = {};
  for (const item of PactErrorsAbi) {
    if (item.type !== "error") continue;
    const name = item.name;
    if (item.inputs.length !== 0) {
      // Defensive: a non-zero-arg PactError would break the `${name}()`
      // selector assumption — fail loudly rather than silently mis-map.
      throw new Error(
        `PactError ${name} is not zero-arg — selector derivation invalid`,
      );
    }
    out[pactErrorSelector(name).toLowerCase()] = {
      name,
      message: MESSAGES[name] ?? name,
    };
  }
  return out;
})();

function selectorOf(data: string): string | undefined {
  if (typeof data !== "string" || !data.startsWith("0x")) return undefined;
  if (data.length < 10) return undefined;
  return data.slice(0, 10).toLowerCase();
}

/** Resolve revert data (0x + >=4-byte selector, payload ignored) to an error. */
export function decodePactError(data: Hex | string): PactEvmError | undefined {
  const sel = selectorOf(data);
  return sel ? PACT_EVM_ERRORS[sel] : undefined;
}

/** Format a selector as `Name (0xsel): message`, or an Unknown fallback. */
export function formatPactError(data: Hex | string): string {
  const sel = selectorOf(data) ?? String(data);
  const e = PACT_EVM_ERRORS[sel];
  return e ? `${e.name} (${sel}): ${e.message}` : `Unknown custom error (${sel})`;
}

/**
 * Best-effort extraction of a Pact error from an arbitrary thrown value
 * (viem `BaseError`/`ContractFunctionRevertedError`, or any nested object
 * carrying revert `data`). Mirrors `protocol-v1-client`'s
 * `tryExtractProtocolError` defensive walk. Returns undefined if none found.
 */
export function tryExtractPactError(err: unknown): PactEvmError | undefined {
  const seen = new Set<unknown>();
  function walk(node: unknown): PactEvmError | undefined {
    if (node == null || seen.has(node)) return undefined;
    if (typeof node === "string") return decodePactError(node);
    if (typeof node !== "object") return undefined;
    seen.add(node);
    const o = node as Record<string, unknown>;
    // Common viem carriers, checked first for a fast path.
    for (const k of ["data", "cause", "details", "error", "raw", "value"]) {
      if (k in o) {
        const r = walk(o[k]);
        if (r) return r;
      }
    }
    for (const v of Object.values(o)) {
      const r = walk(v);
      if (r) return r;
    }
    return undefined;
  }
  return walk(err);
}
