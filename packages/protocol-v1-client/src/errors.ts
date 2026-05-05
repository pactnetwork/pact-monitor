/**
 * Maps PactError numeric codes (from `src/error.rs`) to TypeScript-friendly
 * names + human-readable descriptions.
 *
 * Used by downstream consumers (settler, dashboard) to surface meaningful
 * messages from `ProgramError::Custom(code)` rather than raw numbers.
 *
 * Numbering policy (from error.rs):
 * - 6003 / 6004 / 6009 are reserved gaps from the deleted agent-custody
 *   instructions and are deliberately omitted here.
 * - New errors after 6015 (ArithmeticOverflow) are the fee-recipient family
 *   added by Step C.
 */

export const PROTOCOL_V1_ERRORS: Record<
  number,
  { name: string; message: string }
> = {
  6000: {
    name: "InsufficientBalance",
    message: "Coverage pool has insufficient balance for the requested operation.",
  },
  6001: {
    name: "EndpointPaused",
    message: "Endpoint is paused; settle_batch will not accept events for it.",
  },
  6002: {
    name: "ExposureCapExceeded",
    message: "Hourly exposure cap exceeded for this endpoint.",
  },
  6005: {
    name: "UnauthorizedSettler",
    message: "Settler signer does not match SettlementAuthority.signer.",
  },
  6006: {
    name: "UnauthorizedAuthority",
    message: "Authority signer does not match the expected ProtocolConfig / pool authority.",
  },
  6007: {
    name: "DuplicateCallId",
    message: "CallRecord already exists — call_id has been settled before.",
  },
  6008: {
    name: "EndpointNotFound",
    message: "EndpointConfig PDA does not exist for the given slug.",
  },
  6010: {
    name: "PoolDepleted",
    message: "Coverage pool exhausted — refund could not be paid.",
  },
  6011: {
    name: "InvalidTimestamp",
    message: "Event timestamp is in the future relative to the cluster clock.",
  },
  6012: {
    name: "BatchTooLarge",
    message: "Batch contains more events than MAX_BATCH_SIZE (50).",
  },
  6013: {
    name: "PremiumTooSmall",
    message: "Premium below MIN_PREMIUM_LAMPORTS (100).",
  },
  6014: {
    name: "InvalidSlug",
    message: "Slug contains a non-printable byte (must be ASCII 0x20..0x7E or zero).",
  },
  6015: {
    name: "ArithmeticOverflow",
    message: "Internal arithmetic overflow.",
  },
  6016: {
    name: "FeeRecipientArrayTooLong",
    message: "fee_recipients array longer than MAX_FEE_RECIPIENTS (8).",
  },
  6017: {
    name: "FeeBpsExceedsCap",
    message: "Per-entry or sum bps exceeds ProtocolConfig.max_total_fee_bps.",
  },
  6018: {
    name: "FeeBpsSumOver10k",
    message: "Sum of fee_recipients[*].bps exceeds 10000 (100%).",
  },
  6019: {
    name: "FeeRecipientDuplicateDestination",
    message: "Two fee_recipients share the same destination pubkey.",
  },
  6020: {
    name: "FeeRecipientInvalidUsdcMint",
    message: "Mint passed to instruction does not match ProtocolConfig.usdc_mint.",
  },
  6021: {
    name: "MultipleTreasuryRecipients",
    message: "More than one fee_recipient has kind == Treasury.",
  },
  6022: {
    name: "RecipientCoverageMismatch",
    message:
      "settle_batch event accounts do not match the EndpointConfig (count, ATA ordering, or cached coverage_pool).",
  },
  6023: {
    name: "ProtocolConfigNotInitialized",
    message: "ProtocolConfig PDA does not exist — initialize it first.",
  },
  6024: {
    name: "TreasuryNotInitialized",
    message: "Treasury PDA does not exist — initialize it before register_endpoint.",
  },
  6025: {
    name: "EndpointAlreadyRegistered",
    message: "EndpointConfig (or its CoveragePool) already exists for this slug.",
  },
  6026: {
    name: "InvalidFeeRecipientKind",
    message: "fee_recipient.kind byte is not 0/1/2.",
  },
  // Codex 2026-05-05 review fixes (mainnet blocker class):
  6027: {
    name: "InvalidProtocolConfig",
    message:
      "Supplied ProtocolConfig is not the canonical [b\"protocol_config\"] PDA, or is not owned by the V1 program.",
  },
  6028: {
    name: "InvalidTreasury",
    message:
      "Supplied Treasury is not the canonical [b\"treasury\"] PDA, or is not owned by the V1 program.",
  },
  6029: {
    name: "MissingTreasuryEntry",
    message:
      "fee_recipients does not contain exactly one Treasury entry — Treasury must always be present so the protocol fee path is funded.",
  },
  6030: {
    name: "TreasuryBpsZero",
    message:
      "Treasury fee_recipient entry has bps == 0 — Treasury must take a non-zero cut when present.",
  },
  6031: {
    name: "InvalidAffiliateAta",
    message:
      "An AffiliateAta destination is not a valid initialized SPL Token account on the protocol USDC mint, or otherwise fails ATA invariants.",
  },
};

/**
 * Look up an error by code. Returns `undefined` for unknown codes.
 */
export function decodeProtocolError(
  code: number
): { name: string; message: string } | undefined {
  return PROTOCOL_V1_ERRORS[code];
}

/**
 * Format a `ProgramError::Custom(code)` into a `Name (code): message` string.
 * Returns `Custom(<code>): unknown error` when the code is not one of ours.
 */
export function formatProtocolError(code: number): string {
  const e = PROTOCOL_V1_ERRORS[code];
  if (!e) return `Custom(${code}): unknown error`;
  return `${e.name} (${code}): ${e.message}`;
}

/**
 * Try to extract a Pact error from an arbitrary thrown value (e.g. a
 * `SendTransactionError` from web3.js). Returns `undefined` if no V1 error
 * code is found.
 */
export function tryExtractProtocolError(
  err: unknown
): { code: number; name: string; message: string } | undefined {
  if (!err || typeof err !== "object") return undefined;
  // web3.js puts InstructionError details on `logs` as well as nested struct.
  const obj = err as Record<string, unknown>;
  // Look for { InstructionError: [idx, { Custom: code }] } anywhere in the
  // object's own enumerable properties or its `cause` / `transactionError`.
  const seen = new Set<unknown>();
  function walk(node: unknown): number | undefined {
    if (!node || typeof node !== "object" || seen.has(node)) return undefined;
    seen.add(node);
    const o = node as Record<string, unknown>;
    if ("Custom" in o && typeof o.Custom === "number") {
      return o.Custom;
    }
    if (Array.isArray(node)) {
      for (const v of node) {
        const r = walk(v);
        if (r !== undefined) return r;
      }
      return undefined;
    }
    for (const k of Object.keys(o)) {
      const r = walk(o[k]);
      if (r !== undefined) return r;
    }
    return undefined;
  }
  const code = walk(obj);
  if (code === undefined) return undefined;
  const e = PROTOCOL_V1_ERRORS[code];
  if (!e) return { code, name: "Unknown", message: `Custom(${code})` };
  return { code, ...e };
}
