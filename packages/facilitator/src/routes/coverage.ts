// POST /v1/coverage/register  +  GET /v1/coverage/:id
//
// The pay.sh side-call. After `pay` settles an x402/MPP payment directly with
// the merchant and `pact pay` classifies the result, `pact pay` POSTs the
// payment receipt + classifier verdict here. The facilitator:
//   1. (middleware) verifies the ed25519 envelope over the canonical payload
//      (same scheme as the gateway) — done before this handler runs.
//   2. cross-checks the verified agent against the JSON `agent` field.
//   3. IF the receipt carries BOTH `payee` and `paymentSignature` ("verified"
//      mode): verifies `paymentSignature` on-chain — a confirmed tx that moved
//      >= `amountBaseUnits` of `asset` (must be the network USDC mint) into an
//      account owned by `payee`. IF EITHER is absent ("unverified" / degrade
//      mode — `pay 0.16.0` never logs the merchant address or the settle tx
//      sig, so `pact pay` sends those fields absent): skips on-chain
//      verification, treats `payee` as null, and `verified` is false. Abuse in
//      this mode is bounded by the on-chain hourly exposure cap (and the
//      per-call imputed-cost ceiling), not by receipt verification.
//   4. maps `(payee, resource)` -> a coverage-pool slug (MVP: always `pay-default`).
//   5. reads the pool's premium / imputed-refund config (Postgres, env fallback).
//   6. checks the agent's `pact approve` allowance covers the premium.
//   7. computes premium + (possibly zero) refund from the verdict.
//   8. publishes a SettlementEvent to the SHARED Pub/Sub topic with
//      source: "pay.sh" — the existing settler drives `settle_batch` on-chain
//      against the `pay-default` CoveragePool.
//   9. returns the coverage decision.
//
// GET /v1/coverage/:id returns the status of a registered record: while the
// Pub/Sub event is in flight there's no DB row yet (status:
// "settlement_pending"); once the settler's settle_batch lands and the indexer
// ingests it, the `Call` row appears (with source: "pay.sh") and we surface it
// (status: "settled") with the settle_batch tx signature. The response carries
// `callId` (an alias for `coverageId`) and `settleBatchSignature` (an alias for
// `settlementSignature`, null until settled) for clients that key off those.

import type { Context } from "hono";
import bs58 from "bs58";
import { getContext } from "../lib/context.js";
import { readPoolConfig } from "../lib/pool-config.js";
import {
  computeCoverage,
  deriveCoverageId,
  randomCoverageId,
  isKnownVerdict,
  poolSlugFor,
  verdictToOutcome,
} from "../lib/coverage.js";
import { verifyPayment } from "../lib/payment-verify.js";
import type { PaySettlementEvent } from "../lib/events.js";

// Same UUIDv4 shape gate the market-proxy's GET /v1/calls/:id uses. The
// coverageId we mint in deriveCoverageId() is forced into this shape.
const COVERAGE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SOL_SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/; // base58, ~64 bytes encoded
const SOL_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// USDC mints — the only `asset` values in scope for the MVP. We don't trust
// the client's `asset`; it must be one of these (and must match env.USDC_MINT,
// enforced below).
const USDC_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // mainnet
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", // devnet (program-hardcoded)
]);

interface RegisterBody {
  agent: string;
  /**
   * Merchant wallet pubkey (bs58). OPTIONAL — `pay 0.16.0` never logs the
   * merchant address, so `pact pay` sends this absent. Absent => unverified
   * mode (no on-chain check; `payee` treated as null downstream).
   */
  payee?: string;
  resource: string;
  scheme: string;
  /**
   * Solana tx signature `pay` submitted (bs58). OPTIONAL — `pay 0.16.0` never
   * logs the settle tx sig, so `pact pay` sends this absent. Absent => unverified
   * mode. Verification requires BOTH `payee` and `paymentSignature`; if only one
   * is present we still treat the receipt as unverified.
   */
  paymentSignature?: string;
  amountBaseUnits: string;
  asset: string;
  verdict: string;
  latencyMs?: number;
  // Extra fields the CLI may send (upstreamStatus, reason, ...) are ignored.
  [k: string]: unknown;
}

function bad(c: Context, code: string, reason: string, status = 400): Response {
  return c.json(
    { coverageId: null, status: "rejected", reason, code, verified: false },
    status as 400 | 401 | 422 | 502,
  );
}

export async function registerCoverageRoute(c: Context): Promise<Response> {
  const verifiedAgent = c.get("verifiedAgent") as string | undefined;
  if (!verifiedAgent) {
    // Defensive — the middleware should have set this or rejected.
    return bad(c, "pact_auth_missing", "missing authenticated agent", 401);
  }

  let body: RegisterBody;
  try {
    body = (await c.req.json()) as RegisterBody;
  } catch {
    return bad(c, "bad_json", "request body is not valid JSON");
  }

  // ---- Shape + identity validation ---------------------------------------
  if (typeof body.agent !== "string" || !SOL_PUBKEY_RE.test(body.agent)) {
    return bad(c, "bad_agent", "agent must be a base58 Solana pubkey");
  }
  if (body.agent !== verifiedAgent) {
    return bad(
      c,
      "agent_mismatch",
      "x-pact-agent header does not match body.agent",
      401,
    );
  }
  // Sanity: the verified agent must be a real ed25519 pubkey (32 bytes).
  try {
    if (bs58.decode(body.agent).length !== 32) {
      return bad(c, "bad_agent", "agent pubkey is not 32 bytes");
    }
  } catch {
    return bad(c, "bad_agent", "agent pubkey is not valid base58");
  }
  // `payee` and `paymentSignature` are OPTIONAL on the wire (pay 0.16.0 doesn't
  // expose them). Reject ONLY if present-and-malformed — absent is fine and
  // means "unverified mode" (handled below).
  const payeePresent =
    body.payee !== undefined && body.payee !== null && body.payee !== "";
  if (payeePresent) {
    if (typeof body.payee !== "string" || !SOL_PUBKEY_RE.test(body.payee)) {
      return bad(c, "bad_payee", "payee, when present, must be a base58 Solana pubkey");
    }
  }
  const paymentSigPresent =
    body.paymentSignature !== undefined &&
    body.paymentSignature !== null &&
    body.paymentSignature !== "";
  if (paymentSigPresent) {
    if (typeof body.paymentSignature !== "string" || !SOL_SIG_RE.test(body.paymentSignature)) {
      return bad(
        c,
        "bad_payment_signature",
        "paymentSignature, when present, must be a base58 Solana tx signature",
      );
    }
  }
  if (typeof body.resource !== "string" || body.resource.length === 0 || body.resource.length > 2048) {
    return bad(c, "bad_resource", "resource must be a non-empty string (<=2048 chars)");
  }
  if (body.scheme !== "x402" && body.scheme !== "mpp") {
    return bad(c, "bad_scheme", 'scheme must be "x402" or "mpp"');
  }
  // Verification needs BOTH the merchant address and the settle tx sig.
  const verified = payeePresent && paymentSigPresent;
  // `payee` is null downstream whenever we're not verifying (even if only the
  // address was supplied — there's nothing to verify it against).
  const payee: string | null = verified ? (body.payee as string) : null;
  if (typeof body.asset !== "string" || !USDC_MINTS.has(body.asset)) {
    return bad(c, "unsupported_asset", "asset must be a supported USDC mint");
  }
  const { usdcMint } = getContext();
  if (body.asset !== usdcMint) {
    return bad(
      c,
      "asset_network_mismatch",
      `asset ${body.asset} is not the USDC mint configured for this facilitator (${usdcMint})`,
    );
  }
  let amountBaseUnits: bigint;
  try {
    amountBaseUnits = BigInt(String(body.amountBaseUnits));
  } catch {
    return bad(c, "bad_amount", "amountBaseUnits must be an integer string");
  }
  if (amountBaseUnits <= 0n) {
    return bad(c, "bad_amount", "amountBaseUnits must be > 0");
  }
  if (typeof body.verdict !== "string" || !isKnownVerdict(body.verdict)) {
    return bad(c, "bad_verdict", "verdict is not a recognised classifier verdict");
  }
  const latencyMs =
    typeof body.latencyMs === "number" && Number.isFinite(body.latencyMs) && body.latencyMs >= 0
      ? Math.trunc(body.latencyMs)
      : 0;

  const ctx = getContext();

  // ---- (3) Coverage id + (conditionally) on-chain payment verification ----
  // VERIFIED path: deterministic id = hash(payee, resource, paymentSignature)
  //   so re-registering the same payment is idempotent (the on-chain CallRecord
  //   PDA dedups it too). Verify the payment on-chain before going further.
  // UNVERIFIED path: there's no payment sig to dedup on, so mint a fresh random
  //   UUIDv4-shaped id each call (unverified registrations aren't idempotent —
  //   re-running `pact pay` is a different payment anyway). Skip verifyPayment.
  let coverageId: string;
  let observedPaymentBaseUnits: bigint | null = null;
  if (verified) {
    coverageId = deriveCoverageId({
      payee: body.payee as string,
      resource: body.resource,
      paymentSignature: body.paymentSignature as string,
    });
    const pv = await verifyPayment({
      connection: ctx.connection,
      paymentSignature: body.paymentSignature as string,
      payee: body.payee as string,
      asset: body.asset,
      amountBaseUnits,
    });
    if (!pv.ok) {
      return bad(c, `payment_${pv.reason}`, `payment verification failed: ${pv.reason}`, 422);
    }
    observedPaymentBaseUnits = pv.observedAmount;
  } else {
    coverageId = randomCoverageId();
  }

  // ---- (4)+(5) Map to a pool + read its config ---------------------------
  const slug = poolSlugFor(payee ?? "", body.resource, ctx.payDefaults.slug);
  const pool = await readPoolConfig(ctx.pg, slug, ctx.payDefaults);
  if (pool.paused) {
    return c.json({
      coverageId,
      status: "uncovered",
      premiumBaseUnits: "0",
      refundBaseUnits: "0",
      reason: "pool_paused",
      verified,
    });
  }

  // ---- (7) Compute the coverage math -------------------------------------
  // On a covered breach the refund equals what the agent says it paid the
  // merchant (`amountBaseUnits`), capped at the pool's per-call ceiling. In the
  // VERIFIED path we additionally confirmed on-chain that the payee received AT
  // LEAST `amountBaseUnits`; we still use the *claimed* amount (not the larger
  // chain-observed delta) so the refund the CLI is told to expect matches what
  // it claimed, not an unrelated bigger transfer in the same tx. In the
  // UNVERIFIED path there's nothing to cross-check against — the on-chain
  // hourly exposure cap (and the $1/call imputed-cost ceiling) is the bound.
  const outcome = verdictToOutcome(body.verdict);
  const math = computeCoverage(
    outcome,
    {
      flatPremiumLamports: pool.flatPremiumLamports,
      imputedCostLamports: pool.imputedCostLamports,
    },
    amountBaseUnits,
  );
  if (!math.covered) {
    // client_error / payment_failed — not covered. Record nothing on-chain
    // (zero-premium events are dropped by the settler's batcher anyway).
    return c.json({
      coverageId,
      status: "uncovered",
      premiumBaseUnits: "0",
      refundBaseUnits: "0",
      reason: "not_covered_outcome",
      verified,
    });
  }

  // ---- (6) Agent allowance check -----------------------------------------
  let allowanceOk = false;
  try {
    const r = await ctx.allowanceCheck.check(body.agent, math.premiumLamports);
    allowanceOk = r.eligible;
    if (!r.eligible) {
      return c.json({
        coverageId,
        status: "uncovered",
        premiumBaseUnits: math.premiumLamports.toString(),
        refundBaseUnits: "0",
        reason:
          r.reason === "insufficient_allowance" || r.reason === "no_ata"
            ? "no_allowance"
            : "insufficient_balance",
        verified,
      });
    }
  } catch (err) {
    // RPC blip on the allowance check — fail open to `uncovered` (don't 5xx;
    // the agent already got their resource). They can retry register.
    // eslint-disable-next-line no-console
    console.warn("[facilitator] allowance check failed", err);
    return c.json({
      coverageId,
      status: "uncovered",
      premiumBaseUnits: math.premiumLamports.toString(),
      refundBaseUnits: "0",
      reason: "allowance_check_unavailable",
      verified,
    });
  }
  // (allowanceOk is true here)
  void allowanceOk;

  // ---- (8) Publish the SettlementEvent -----------------------------------
  // We publish the SettlementEvent regardless of `verified` — an unverified
  // registration still drives an on-chain `settle_batch`, so abuse is bounded
  // by the pool's on-chain hourly exposure cap (and the $1/call imputed-cost
  // ceiling), not by receipt verification. `payee` rides along as null when we
  // didn't verify; the settler/indexer forward it untouched (the Call.payee
  // Postgres column is nullable).
  const event: PaySettlementEvent = {
    callId: coverageId,
    agentPubkey: body.agent,
    endpointSlug: slug,
    premiumLamports: math.premiumLamports.toString(),
    refundLamports: math.refundLamports.toString(),
    latencyMs,
    outcome: math.outcome,
    ts: new Date().toISOString(),
    source: "pay.sh",
    verified,
    payee,
    resource: body.resource,
    coverageId,
  };
  await ctx.publisher.publish(event); // swallows errors internally

  // ---- (9) Respond -------------------------------------------------------
  return c.json({
    coverageId,
    status: "settlement_pending",
    premiumBaseUnits: math.premiumLamports.toString(),
    refundBaseUnits: math.refundLamports.toString(),
    reason: null,
    poolSlug: slug,
    outcome: math.outcome,
    // null in the unverified path — we never went to chain to observe it.
    observedPaymentBaseUnits:
      observedPaymentBaseUnits === null ? null : observedPaymentBaseUnits.toString(),
    verified,
  });
}

export async function getCoverageRoute(c: Context): Promise<Response> {
  const id = c.req.param("id") ?? "";
  if (!COVERAGE_ID_RE.test(id)) {
    return c.json({ error: "invalid coverage id" }, 400);
  }
  const { pg } = getContext();
  try {
    const res = await pg.query(
      `SELECT "callId",
              "agentPubkey",
              "endpointSlug",
              "premiumLamports",
              "refundLamports",
              "latencyMs",
              breach,
              "breachReason",
              source,
              payee,
              resource,
              ts,
              "settledAt",
              signature
         FROM "Call"
        WHERE "callId" = $1`,
      [id],
    );
    if (res.rows.length === 0) {
      // No row yet — either the Pub/Sub event is still in flight / being
      // settled, or this id was never registered. We can't distinguish those
      // without our own store; the honest answer is "not settled yet".
      return c.json({
        coverageId: id,
        // Alias for callers that key off `callId` (PR #173's CLI does). Same
        // value as `coverageId` — usable with `pact calls <id>` once settled.
        callId: id,
        status: "settlement_pending",
        settled: false,
        // The on-chain `settle_batch` tx signature. Null until the settler
        // lands the batch and the indexer ingests it. Aliased below as
        // `settlementSignature` once present.
        settleBatchSignature: null,
        settlementSignature: null,
      });
    }
    const r = res.rows[0];
    return c.json({
      coverageId: r.callId,
      // Alias for callers that key off `callId` (PR #173's CLI does).
      callId: r.callId,
      status: "settled",
      settled: true,
      agentPubkey: r.agentPubkey,
      poolSlug: r.endpointSlug,
      premiumBaseUnits: String(r.premiumLamports),
      refundBaseUnits: String(r.refundLamports),
      latencyMs: Number(r.latencyMs),
      breach: Boolean(r.breach),
      breachReason: r.breachReason ?? null,
      source: r.source ?? null,
      payee: r.payee ?? null,
      resource: r.resource ?? null,
      ts: new Date(r.ts).toISOString(),
      settledAt: new Date(r.settledAt).toISOString(),
      settlementSignature: r.signature,
      // Alias for callers that read `settleBatchSignature` (PR #173's CLI
      // builds a Solscan link from it). Same value as `settlementSignature`.
      settleBatchSignature: r.signature,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[facilitator] error reading coverage record", id, err);
    return c.json({ error: "failed to read coverage record" }, 502);
  }
}
