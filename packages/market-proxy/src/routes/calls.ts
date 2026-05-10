import type { Context } from "hono";
import { getContext } from "../lib/context.js";

// Wire shape mirrors the indexer's CallsController response so dashboards and
// CLIs that already consume the indexer's `/api/calls/:id` get an identical
// payload from the gateway. BigInts are serialised as decimal strings.
interface CallWire {
  callId: string;
  agentPubkey: string;
  endpointSlug: string;
  premiumLamports: string;
  refundLamports: string;
  latencyMs: number;
  breach: boolean;
  breachReason: string | null;
  source: string | null;
  ts: string;
  settledAt: string;
  signature: string;
  recipientShares: Array<{
    kind: number;
    pubkey: string;
    amountLamports: string;
  }>;
}

// callId is a UUIDv4 produced by @pact-network/wrap. The shape gate enforces
// version=4 (third group starts with `4`) and the RFC 4122 variant bits
// (fourth group starts with 8/9/a/b). Anything else short-circuits to a 400
// so a stray pubkey, lower-version UUID, or arbitrary string can't trigger
// DB load.
const CALL_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function callsRoute(c: Context): Promise<Response> {
  const callId = c.req.param("id") ?? "";
  if (!CALL_ID_RE.test(callId)) {
    return c.json({ error: "invalid call id" }, 400);
  }

  const { pg } = getContext();

  try {
    const callRes = await pg.query(
      `SELECT "callId",
              "agentPubkey",
              "endpointSlug",
              "premiumLamports",
              "refundLamports",
              "latencyMs",
              breach,
              "breachReason",
              source,
              ts,
              "settledAt",
              signature
         FROM "Call"
        WHERE "callId" = $1`,
      [callId],
    );
    if (callRes.rows.length === 0) {
      return c.json({ error: "call not found" }, 404);
    }
    const row = callRes.rows[0];

    // Settlement-level recipient shares — keyed by signature, not callId.
    // All calls in the batch share the same shares payload (FIX-4).
    const sharesRes = await pg.query(
      `SELECT "recipientKind",
              "recipientPubkey",
              "amountLamports"
         FROM "SettlementRecipientShare"
        WHERE "settlementSig" = $1`,
      [row.signature],
    );

    const wire: CallWire = {
      callId: row.callId,
      agentPubkey: row.agentPubkey,
      endpointSlug: row.endpointSlug,
      premiumLamports: String(row.premiumLamports),
      refundLamports: String(row.refundLamports),
      latencyMs: Number(row.latencyMs),
      breach: Boolean(row.breach),
      breachReason: row.breachReason ?? null,
      source: row.source ?? null,
      ts: new Date(row.ts).toISOString(),
      settledAt: new Date(row.settledAt).toISOString(),
      signature: row.signature,
      recipientShares: sharesRes.rows.map((s) => ({
        kind: Number(s.recipientKind),
        pubkey: s.recipientPubkey,
        amountLamports: String(s.amountLamports),
      })),
    };

    return c.json(wire);
  } catch (err) {
    console.error("[calls] error reading call", callId, err);
    return c.json({ error: "failed to read call" }, 502);
  }
}
