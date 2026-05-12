// `--wait` support: after an insured `pact <url>` call returns with a
// `call_id` and a pending `settlement_eta_sec`, the on-chain `settle_batch`
// tx doesn't exist yet (the settler batches events and lands the tx ~8s
// later). `pollSettlement` polls `GET <gateway>/v1/calls/<id>` — the same
// query `pact calls show <id>` uses — until the `Call` row has a `signature`
// (settled) or the window elapses, so `--json` consumers can get the real
// tx signature, premium, and refund in one invocation.
//
// Wire shape mirrors packages/market-proxy/src/routes/calls.ts `CallWire`:
// before settlement the row doesn't exist -> 404; after settlement the row
// carries `signature`, `premiumLamports`, `refundLamports`, `breach`,
// `breachReason`, `settledAt`, `latencyMs` (lamports as decimal strings).

const LAMPORTS_PER_USDC = 1_000_000;

export interface SettledCall {
  signature: string;
  premiumLamports: number;
  premiumUsdc: number;
  refundLamports: number;
  refundUsdc: number;
  breach: boolean;
  breachReason: string | null;
  settledAt: string | null;
  latencyMs: number | null;
}

export type SettlementResult =
  | { kind: "settled"; call: SettledCall }
  | { kind: "pending"; pollsAttempted: number }
  | { kind: "skipped"; reason: string };

interface PollSettlementOpts {
  gatewayUrl: string;
  callId: string;
  // Total wall-clock budget. Default 30s when --wait is given with no value.
  windowMs?: number;
  // Delay between polls.
  intervalMs?: number;
  // Test seam - defaults to global fetch.
  fetchImpl?: typeof fetch;
  // Test seam - defaults to a real setTimeout-based sleep.
  sleep?: (ms: number) => Promise<void>;
  // Test seam - monotonic clock.
  now?: () => number;
}

const DEFAULT_WINDOW_MS = 30_000;
const DEFAULT_INTERVAL_MS = 3_000;

function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function parseWire(body: unknown): SettledCall | null {
  if (!body || typeof body !== "object") return null;
  const w = body as Record<string, unknown>;
  const sig = w.signature;
  if (typeof sig !== "string" || sig.length === 0) return null;
  const premiumLamports = toNum(w.premiumLamports);
  const refundLamports = toNum(w.refundLamports);
  return {
    signature: sig,
    premiumLamports,
    premiumUsdc: premiumLamports / LAMPORTS_PER_USDC,
    refundLamports,
    refundUsdc: refundLamports / LAMPORTS_PER_USDC,
    breach: Boolean(w.breach),
    breachReason: typeof w.breachReason === "string" ? w.breachReason : null,
    settledAt: typeof w.settledAt === "string" ? w.settledAt : null,
    latencyMs:
      typeof w.latencyMs === "number" || typeof w.latencyMs === "string"
        ? toNum(w.latencyMs)
        : null,
  };
}

export function solscanUrl(signature: string): string {
  return `https://solscan.io/tx/${signature}`;
}

// Validate the same way callsRoute/callsShowCommand do, so a bad call_id
// short-circuits to a skip rather than burning network round-trips.
const CALL_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function pollSettlement(
  opts: PollSettlementOpts,
): Promise<SettlementResult> {
  if (!CALL_ID_RE.test(opts.callId)) {
    return { kind: "skipped", reason: "call_id is not a server-assigned UUID" };
  }
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());

  const url = `${opts.gatewayUrl.replace(/\/$/, "")}/v1/calls/${opts.callId}`;
  const deadline = now() + windowMs;
  let polls = 0;

  // First poll happens immediately (the settler may already be done by the
  // time the CLI gets here on a busy batch); subsequent polls wait intervalMs.
  for (;;) {
    polls += 1;
    try {
      const resp = await fetchImpl(url);
      if (resp.ok) {
        let parsed: unknown;
        try {
          parsed = await resp.json();
        } catch {
          parsed = null;
        }
        const settled = parseWire(parsed);
        if (settled) return { kind: "settled", call: settled };
        // 200 but no signature yet - keep polling.
      }
      // 404 (row not written yet) / 502 / other transient - keep polling.
    } catch {
      // network blip - keep polling within the window.
    }
    if (now() + intervalMs >= deadline) {
      return { kind: "pending", pollsAttempted: polls };
    }
    await sleep(intervalMs);
  }
}

// Shared merge step used by the `pact <url> --wait` action and exercised
// directly in tests. Mutates `meta` in place from a SettlementResult and
// returns an optional human line for TTY mode (caller decides whether to
// print it). `waitSec` is only used to phrase the "still pending" line.
export function applySettlementToMeta(
  meta: Record<string, unknown>,
  result: SettlementResult,
  waitSec: number,
): { ttyLine?: string } {
  if (result.kind === "settled") {
    const c = result.call;
    meta.tx_signature = c.signature;
    meta.premium_lamports = c.premiumLamports;
    meta.premium_usdc = c.premiumUsdc;
    meta.refund_lamports = c.refundLamports;
    meta.refund_usdc = c.refundUsdc;
    meta.breach = c.breach;
    if (c.breachReason) meta.breach_reason = c.breachReason;
    if (c.settledAt) meta.settled_at = c.settledAt;
    if (c.latencyMs !== null) meta.settled_latency_ms = c.latencyMs;
    meta.solscan_url = solscanUrl(c.signature);
    delete meta.settlement_pending;
    delete meta.settlement_hint;
    let line = `[pact] settled on-chain: ${c.signature} — ${solscanUrl(c.signature)}`;
    if (c.breach && c.refundUsdc > 0) line += ` (refunded ${c.refundUsdc} USDC)`;
    return { ttyLine: line };
  }
  // pending / skipped: leave tx_signature null, add a pending marker + hint.
  meta.settlement_pending = true;
  const callId = typeof meta.call_id === "string" ? meta.call_id : null;
  meta.settlement_hint = callId
    ? `run \`pact calls show ${callId}\` later for the on-chain tx signature`
    : "settlement still pending; check the dashboard later";
  return {
    ttyLine: `[pact] settlement still pending after ${waitSec}s — ${meta.settlement_hint}`,
  };
}
