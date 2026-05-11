// POST /v1/coverage/register  +  GET /v1/coverage/:id
//
// The pay.sh side-call. After `pay` settles an x402/MPP payment directly with
// the merchant and `pact pay` classifies the result, `pact pay` POSTs the
// payment receipt + classifier verdict here. The facilitator:
//   1. (middleware) verifies the ed25519 envelope over the canonical payload
//      (same scheme as the gateway) — done before this handler runs.
//   2. cross-checks the verified agent against the JSON `agent` field.
//   3. verifies `paymentSignature` on-chain: a confirmed tx that moved >=
//      `amountBaseUnits` of `asset` (must be the network USDC mint) into an
//      account owned by `payee`.
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
// (status: "settled") with the settle_batch tx signature.

import type { Context } from "hono";
import bs58 from "bs58";
import { getContext } from "../lib/context.js";
import { readPoolConfig } from "../lib/pool-config.js";
import {
  computeCoverage,
  deriveCoverageId,
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
  payee: string;
  resource: string;
  scheme: string;
  paymentSignature: string;
  amountBaseUnits: string;
  asset: string;
  verdict: string;
  latencyMs?: number;
  // Extra fields the CLI may send (upstreamStatus, reason, ...) are ignored.
  [k: string]: unknown;
}

function bad(c: Context, code: string, reason: string, status = 400): Response {
  return c.json(
    { coverageId: null, status: "rejected", reason, code },
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
  if (typeof body.payee !== "string" || !SOL_PUBKEY_RE.test(body.payee)) {
    return bad(c, "bad_payee", "payee must be a base58 Solana pubkey");
  }
  if (typeof body.resource !== "string" || body.resource.length === 0 || body.resource.length > 2048) {
    return bad(c, "bad_resource", "resource must be a non-empty string (<=2048 chars)");
  }
  if (body.scheme !== "x402" && body.scheme !== "mpp") {
    return bad(c, "bad_scheme", 'scheme must be "x402" or "mpp"');
  }
  if (typeof body.paymentSignature !== "string" || !SOL_SIG_RE.test(body.paymentSignature)) {
    return bad(c, "bad_payment_signature", "paymentSignature must be a base58 Solana tx signature");
  }
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
  const coverageId = deriveCoverageId({
    payee: body.payee,
    resource: body.resource,
    paymentSignature: body.paymentSignature,
  });

  // ---- (3) Verify the payment on-chain -----------------------------------
  const pv = await verifyPayment({
    connection: ctx.connection,
    paymentSignature: body.paymentSignature,
    payee: body.payee,
    asset: body.asset,
    amountBaseUnits,
  });
  if (!pv.ok) {
    return bad(c, `payment_${pv.reason}`, `payment verification failed: ${pv.reason}`, 422);
  }

  // ---- (4)+(5) Map to a pool + read its config ---------------------------
  const slug = poolSlugFor(body.payee, body.resource, ctx.payDefaults.slug);
  const pool = await readPoolConfig(ctx.pg, slug, ctx.payDefaults);
  if (pool.paused) {
    return c.json({
      coverageId,
      status: "uncovered",
      premiumBaseUnits: "0",
      refundBaseUnits: "0",
      reason: "pool_paused",
    });
  }

  // ---- (7) Compute the coverage math -------------------------------------
  // On a covered breach the refund equals what the agent actually paid the
  // merchant (we use the chain-observed delta, which is >= the claimed amount),
  // capped at the pool's per-call ceiling. We use `amountBaseUnits` (the
  // client's claim, which payment-verify already confirmed the payee received
  // AT LEAST of) rather than `pv.observedAmount` so the refund the CLI is told
  // to expect matches what it claimed, not an unrelated larger transfer in the
  // same tx.
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
    });
  }
  // (allowanceOk is true here)
  void allowanceOk;

  // ---- (8) Publish the SettlementEvent -----------------------------------
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
    payee: body.payee,
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
    observedPaymentBaseUnits: pv.observedAmount.toString(),
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
        status: "settlement_pending",
        settled: false,
      });
    }
    const r = res.rows[0];
    return c.json({
      coverageId: r.callId,
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
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[facilitator] error reading coverage record", id, err);
    return c.json({ error: "failed to read coverage record" }, 502);
  }
}
