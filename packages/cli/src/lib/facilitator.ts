// Client for facilitator.pact.network — the pay.sh-path coverage
// registrar (see docs/premium-coverage-mvp.md §B).
//
// `pact pay` makes a side-call here AFTER `pay` has already settled the
// payment with the merchant: this records the receipt, prices the
// premium (charged from the agent's `pact approve` allowance), and on a
// covered failure issues a refund from the subsidised `pay-default`
// pool via the same on-chain `settle_batch` machinery the gateway path
// uses.
//
// Auth — identical scheme to the gateway path (packages/cli/src/lib/
// transport.ts → verified by packages/market-proxy/src/middleware/
// verify-signature.ts): an ed25519 detached signature over the canonical
// payload `v1\nMETHOD\nPATH\nTIMESTAMP_MS\nNONCE\nBODY_SHA256_HEX`,
// carried in `x-pact-signature` alongside `x-pact-agent` /
// `x-pact-timestamp` / `x-pact-nonce` / `x-pact-project`.
//
// Failure model: best-effort. The payment already happened and `pay`
// already settled with the merchant — coverage just isn't recorded if
// the facilitator is unreachable / 5xx. We return a soft "uncovered"
// shape (status "facilitator_unreachable") rather than throwing, so
// `pact pay` never fails the command or changes its exit code on a
// facilitator outage.

import { createHash, randomBytes } from "node:crypto";
import type { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { buildSignaturePayload } from "./transport.ts";
import type { CoverageRegistrationPayload } from "./x402-receipt.ts";

export const DEFAULT_FACILITATOR_URL = "https://facilitator.pact.network";

export function resolveFacilitatorUrl(): string {
  const env = process.env.PACT_FACILITATOR_URL;
  return env && env.trim().length > 0 ? env.trim() : DEFAULT_FACILITATOR_URL;
}

// The coverage decision the facilitator returns. This shape is shared
// with the facilitator service the `facilitator-service` agent is
// building — keep it identical. If a mismatch is discovered, flag it in
// the PR and pick the more sensible one.
//
//   status:
//     "settlement_pending" — coverage recorded; premium + (on a breach)
//                             refund settling on-chain via settle_batch.
//     "uncovered"          — no coverage applied (e.g. no `pact approve`
//                             allowance, payee not in a covered pool,
//                             amount below floor, verdict not a covered
//                             outcome). `reason` says which.
//     "rejected"           — the facilitator rejected the receipt (e.g.
//                             couldn't verify the payment, malformed
//                             payload, signature mismatch). `reason` says
//                             why.
//     "facilitator_unreachable" — CLIENT-SIDE sentinel only; the
//                             facilitator never returns this. Means the
//                             side-call itself failed (network / 5xx /
//                             timeout). The call still happened and pay
//                             already settled with the merchant; coverage
//                             just wasn't recorded.
export type CoverageStatus =
  | "settlement_pending"
  | "uncovered"
  | "rejected"
  | "facilitator_unreachable";

export interface CoverageDecision {
  coverageId: string | null;
  status: CoverageStatus;
  // Premium charged from the agent's allowance, in USDC base units, as a
  // decimal string. "0" when uncovered/rejected/unreachable.
  premiumBaseUnits: string;
  // Refund issued from the pool on a covered failure, in USDC base
  // units, as a decimal string. "0" when not a covered failure.
  refundBaseUnits: string;
  // Machine-readable reason for uncovered/rejected/unreachable; "" on
  // settlement_pending. Examples the facilitator may return:
  //   "no_allowance" | "no_pool_for_payee" | "below_min" |
  //   "not_covered_outcome" | "receipt_unverifiable" | "bad_signature"
  reason: string;
  // The Pact callId the facilitator assigned (16-byte hex / UUID),
  // usable with `pact calls <id>` once settled. May be null if the
  // facilitator only returns a coverageId.
  callId?: string | null;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export interface RegisterCoverageInput {
  keypair: Keypair;
  project: string;
  payload: CoverageRegistrationPayload;
  facilitatorUrl?: string;
  timeoutMs?: number;
  // Test override for fetch.
  fetchImpl?: typeof fetch;
}

const REGISTER_PATH = "/v1/coverage/register";

export async function registerCoverage(
  input: RegisterCoverageInput,
): Promise<CoverageDecision> {
  const base = (input.facilitatorUrl ?? resolveFacilitatorUrl()).replace(/\/$/, "");
  const url = `${base}${REGISTER_PATH}`;
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 8000;

  const bodyStr = JSON.stringify(input.payload);
  const ts = Date.now();
  const nonce = bs58.encode(randomBytes(16));
  const bodyHash = bodyStr ? sha256Hex(bodyStr) : "";
  const sigPayload = buildSignaturePayload({
    method: "POST",
    path: REGISTER_PATH,
    timestampMs: ts,
    nonce,
    bodyHash,
  });
  const sig = nacl.sign.detached(
    new TextEncoder().encode(sigPayload),
    input.keypair.secretKey,
  );
  const agent = input.keypair.publicKey.toBase58();

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-pact-agent": agent,
    "x-pact-timestamp": String(ts),
    "x-pact-nonce": nonce,
    "x-pact-signature": bs58.encode(sig),
    "x-pact-project": input.project,
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(url, {
      method: "POST",
      headers,
      body: bodyStr,
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    // 5xx / non-OK: degrade gracefully — the call already happened and
    // pay already settled with the merchant.
    if (resp.status >= 500) {
      return unreachable(`facilitator returned HTTP ${resp.status}`);
    }

    let parsed: unknown;
    try {
      parsed = await resp.json();
    } catch {
      // Non-JSON body. If it's a 4xx, treat as a rejection; otherwise
      // unreachable.
      return resp.status >= 400 && resp.status < 500
        ? rejected(`facilitator HTTP ${resp.status} (non-JSON body)`)
        : unreachable(`facilitator HTTP ${resp.status} (non-JSON body)`);
    }

    return normalizeDecision(parsed, resp.status);
  } catch (err) {
    clearTimeout(timer);
    const message = err instanceof Error ? err.message : String(err);
    return unreachable(message);
  }
}

function unreachable(reason: string): CoverageDecision {
  return {
    coverageId: null,
    status: "facilitator_unreachable",
    premiumBaseUnits: "0",
    refundBaseUnits: "0",
    reason,
    callId: null,
  };
}

function rejected(reason: string): CoverageDecision {
  return {
    coverageId: null,
    status: "rejected",
    premiumBaseUnits: "0",
    refundBaseUnits: "0",
    reason,
    callId: null,
  };
}

// Normalize the facilitator's JSON response into a CoverageDecision,
// tolerating both the canonical shape and a few defensible aliases (the
// facilitator service is being built in parallel; if it lands a
// different field name we still surface something coherent rather than
// crashing). Flag any mismatch in the PR.
function normalizeDecision(raw: unknown, httpStatus: number): CoverageDecision {
  if (raw === null || typeof raw !== "object") {
    return rejected("facilitator returned a non-object body");
  }
  const o = raw as Record<string, unknown>;

  const str = (v: unknown): string | null =>
    typeof v === "string" ? v : v == null ? null : String(v);
  const baseUnits = (v: unknown): string => {
    const s = str(v);
    if (s == null) return "0";
    // Accept "1000", 1000, "1000n" — coerce to a clean decimal string.
    const m = s.match(/^-?\d+/);
    return m ? m[0] : "0";
  };

  const coverageId = str(o.coverageId ?? o.coverage_id);
  const callId = str(o.callId ?? o.call_id);
  const premiumBaseUnits = baseUnits(o.premiumBaseUnits ?? o.premium_base_units);
  const refundBaseUnits = baseUnits(o.refundBaseUnits ?? o.refund_base_units);
  const reason = str(o.reason) ?? "";

  // Status: prefer an explicit field; otherwise infer from the legacy
  // `{ covered, settlement_pending }` shape sketched in the design doc.
  let status: CoverageStatus | null = null;
  const rawStatus = str(o.status);
  if (
    rawStatus === "settlement_pending" ||
    rawStatus === "uncovered" ||
    rawStatus === "rejected"
  ) {
    status = rawStatus;
  } else if (typeof o.covered === "boolean") {
    status = o.covered ? "settlement_pending" : "uncovered";
  }

  if (status === null) {
    // Couldn't determine — be conservative.
    return httpStatus >= 400
      ? rejected(reason || `facilitator HTTP ${httpStatus}, unknown status`)
      : {
          coverageId,
          status: "uncovered",
          premiumBaseUnits,
          refundBaseUnits,
          reason: reason || "facilitator returned no status",
          callId,
        };
  }

  return {
    coverageId,
    status,
    premiumBaseUnits,
    refundBaseUnits,
    reason,
    callId,
  };
}

// ----------------------------------------------------------------------
// Coverage status lookup — GET /v1/coverage/:id
// ----------------------------------------------------------------------

export interface CoverageStatusResult {
  // Raw JSON the facilitator returned (passed through to --json
  // consumers). null when the lookup failed.
  body: Record<string, unknown> | null;
  status: "ok" | "not_found" | "server_error" | "unreachable";
  // Extracted convenience fields when present.
  coverageId?: string | null;
  callId?: string | null;
  coverageStatus?: string | null;     // "settlement_pending" | "settled" | ...
  settleBatchSignature?: string | null;
  httpStatus?: number;
  error?: string;
}

export async function getCoverageStatus(input: {
  coverageId: string;
  facilitatorUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<CoverageStatusResult> {
  const base = (input.facilitatorUrl ?? resolveFacilitatorUrl()).replace(/\/$/, "");
  const url = `${base}/v1/coverage/${encodeURIComponent(input.coverageId)}`;
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 8000;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(url, { method: "GET", signal: ctrl.signal });
    clearTimeout(timer);
    if (resp.status === 404) {
      return { body: null, status: "not_found", httpStatus: 404 };
    }
    if (resp.status >= 500) {
      return { body: null, status: "server_error", httpStatus: resp.status };
    }
    let parsed: unknown;
    try {
      parsed = await resp.json();
    } catch {
      return {
        body: null,
        status: resp.status >= 400 ? "not_found" : "unreachable",
        httpStatus: resp.status,
        error: "non-JSON body",
      };
    }
    const body =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : null;
    const str = (v: unknown): string | null =>
      typeof v === "string" ? v : v == null ? null : String(v);
    return {
      body,
      status: "ok",
      httpStatus: resp.status,
      coverageId: body ? str(body.coverageId ?? body.coverage_id) : null,
      callId: body ? str(body.callId ?? body.call_id) : null,
      coverageStatus: body ? str(body.status) : null,
      settleBatchSignature: body
        ? str(
            body.settleBatchSignature ??
              body.settle_batch_signature ??
              body.txSignature ??
              body.tx_signature ??
              body.signature,
          )
        : null,
    };
  } catch (err) {
    clearTimeout(timer);
    return {
      body: null,
      status: "unreachable",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
