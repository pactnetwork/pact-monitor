import { PublicKey } from "@solana/web3.js";

/**
 * Pure validators for the ops forms. Imperative useState forms call these on
 * change; the submit handler calls them again on submit. NEVER throws —
 * always returns a tagged `Result`.
 *
 * Verified against the on-chain program rules:
 *   - slug regex: `^[a-z0-9-]{1,16}$` (the program packs the slug into a
 *     16-byte fixed-len field; lowercase ASCII keeps it printable).
 *   - bps fields: u16 in [0, 10000] (basis points).
 *   - sum of recipient bps: ≤ ProtocolConfig.max_total_fee_bps (NOT
 *     === 10000 — caught by C4 critique against fee.rs:83-88). The chain
 *     accepts any sum from 0 to max; the residual stays in the pool.
 *   - exactly one Treasury entry with bps > 0 (fee.rs:140-149).
 */

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export const SLUG_REGEX = /^[a-z0-9-]{1,16}$/;

export function validateSlug(input: string): Result<string> {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: "slug is required" };
  if (!SLUG_REGEX.test(trimmed)) {
    return {
      ok: false,
      error: "slug must be lowercase a-z, 0-9, or '-', 1..16 chars",
    };
  }
  return { ok: true, value: trimmed };
}

export function validatePubkey(input: string): Result<PublicKey> {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: "pubkey is required" };
  try {
    return { ok: true, value: new PublicKey(trimmed) };
  } catch {
    return {
      ok: false,
      error: "invalid base58 pubkey (must decode to 32 bytes)",
    };
  }
}

export function validateBigIntNonNeg(
  input: string,
  label: string,
): Result<bigint> {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: `${label} is required` };
  if (!/^\d+$/.test(trimmed)) {
    return {
      ok: false,
      error: `${label} must be a non-negative integer (got '${input}')`,
    };
  }
  try {
    return { ok: true, value: BigInt(trimmed) };
  } catch {
    return { ok: false, error: `${label} is not a valid integer` };
  }
}

export function validatePercentBps(input: string | number): Result<number> {
  const n = typeof input === "number" ? input : Number(String(input).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return {
      ok: false,
      error: "percentBps must be an integer (basis points; 0..10000)",
    };
  }
  if (n < 0 || n > 10000) {
    return { ok: false, error: "percentBps must be in [0, 10000]" };
  }
  return { ok: true, value: n };
}

/**
 * Convert decimal USDC string (e.g., "1.5") to base units (×10^6).
 * Rejects negatives, zero, NaN. Keeps 6 decimals of precision.
 */
export function validateUsdcDecimal(input: string): Result<bigint> {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: "amount is required" };
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) {
    return {
      ok: false,
      error: "amount must be decimal USDC with ≤ 6 decimal places",
    };
  }
  const [whole, frac = ""] = trimmed.split(".");
  const padded = (whole + frac.padEnd(6, "0")).replace(/^0+(?=\d)/, "");
  const base = BigInt(padded || "0");
  if (base <= 0n)
    return { ok: false, error: "amount must be greater than 0" };
  return { ok: true, value: base };
}

// ---------------------------------------------------------------------------
// Recipients row-builder validators (C4 critique-corrected)
// ---------------------------------------------------------------------------

export type RecipientKind = "Treasury" | "AffiliateAta";

export interface RecipientRow {
  /** Tag for React key + remove() — caller-assigned. */
  id: string;
  kind: RecipientKind;
  /** Raw user input (validated on submit). */
  destination: string;
  /** Raw user input (validated on submit). */
  bps: string;
}

export interface ValidRecipient {
  kind: RecipientKind;
  destination: PublicKey;
  bps: number;
}

export interface RecipientsValidation {
  ok: boolean;
  /** Sum of all parsed-and-clamped bps (for live UI tally). */
  sumBps: number;
  /** Per-row errors keyed by row.id, for inline display. */
  rowErrors: Record<string, string>;
  /** Form-level errors (sum > max, missing treasury, count > 8, etc.). */
  formErrors: string[];
  /** Successfully parsed recipients in row order. Always present (best-effort). */
  parsed: ValidRecipient[];
}

/**
 * Validate the recipients row-builder against on-chain rules. Reports
 * form-level + per-row errors so the UI can highlight each problem
 * separately. Notes:
 *   - sum ≤ maxTotalFeeBps (NOT === 10000)
 *   - exactly one Treasury entry with bps > 0
 *   - count ≤ 8 (program-side hard cap)
 *   - all pubkeys parse as base58 32-byte
 */
export function validateRecipients(
  rows: RecipientRow[],
  maxTotalFeeBps: number,
): RecipientsValidation {
  const rowErrors: Record<string, string> = {};
  const formErrors: string[] = [];
  const parsed: ValidRecipient[] = [];
  let sumBps = 0;
  let treasuryCount = 0;
  let treasuryHasBps = false;

  if (rows.length === 0) {
    formErrors.push("at least one recipient required");
  }
  if (rows.length > 8) {
    formErrors.push(`max 8 recipients (got ${rows.length})`);
  }

  for (const row of rows) {
    const dest = validatePubkey(row.destination);
    const bps = validatePercentBps(row.bps);
    if (!dest.ok) {
      rowErrors[row.id] = dest.error;
      continue;
    }
    if (!bps.ok) {
      rowErrors[row.id] = bps.error;
      continue;
    }
    if (row.kind === "Treasury") {
      treasuryCount += 1;
      if (bps.value > 0) treasuryHasBps = true;
    }
    sumBps += bps.value;
    parsed.push({ kind: row.kind, destination: dest.value, bps: bps.value });
  }

  if (treasuryCount === 0) {
    formErrors.push("exactly one Treasury recipient required");
  } else if (treasuryCount > 1) {
    formErrors.push(`exactly one Treasury recipient required (got ${treasuryCount})`);
  } else if (!treasuryHasBps) {
    formErrors.push("the Treasury recipient must have bps > 0");
  }

  if (sumBps > maxTotalFeeBps) {
    formErrors.push(
      `sum of bps (${sumBps}) exceeds ProtocolConfig.max_total_fee_bps (${maxTotalFeeBps})`,
    );
  }

  return {
    ok: formErrors.length === 0 && Object.keys(rowErrors).length === 0,
    sumBps,
    rowErrors,
    formErrors,
    parsed,
  };
}
