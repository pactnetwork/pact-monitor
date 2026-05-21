/**
 * `merchant.dispute()` — Commit 1 stub. The real backend route + ops workflow
 * lands in Commit 2. Throws a typed NOT_AVAILABLE error so callers can
 * distinguish "not wired yet" from "backend error".
 */
import { PactError, PactErrorCode } from "../errors.js";

export interface DisputeInput {
  callRecordId: string;
  reason: string;
  evidence?: Record<string, unknown>;
}

export interface DisputeResult {
  ticketId: string;
  status: "open";
}

export async function fileDispute(_input: DisputeInput): Promise<DisputeResult> {
  throw new PactError(
    PactErrorCode.NOT_AVAILABLE,
    "merchant.dispute(): backend endpoint lands in Commit 2 (Phase H4); contact ops for V1 dispute filing",
    { retryable: false },
  );
}
