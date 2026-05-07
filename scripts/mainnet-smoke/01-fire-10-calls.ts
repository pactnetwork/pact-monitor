/**
 * 01-fire-10-calls.ts — fire 10 real mainnet calls through the market-proxy
 * with a mixed outcome distribution.
 *
 * Distribution (cost-tuned for real USDC; smoke-tier2 fires 50, we fire 10):
 *   7× ok               -> premium = endpoint.flat_premium_lamports
 *   1× latency_breach   -> ?demo_breach=1 (test agent must be in demo allowlist)
 *   1× server_error     -> hit a path the upstream returns 5xx for (best-effort)
 *   1× network_error    -> point upstream at an unresolvable hostname (best-effort)
 *
 * The classic `client_error` slot is intentionally skipped — the wrap classifier
 * sets premium = 0 for client errors, so the settler drops them and the
 * reconciler has nothing to compare. See smoke-tier2/05-fire-50-calls.ts for
 * the full mix. On real mainnet we'd be paying for a no-op.
 *
 * Per-call we record:
 *   - callId (32-char hex from X-Pact-Call-Id response header)
 *   - slug
 *   - sentAtMs
 *   - expectedOutcome
 *   - proxyStatus
 *   - premiumLamports / refundLamports / outcomeHeader (from X-Pact-* headers)
 *
 * After publishing, we wait `SETTLER_DRAIN_MS` (default 60s) for the settler
 * to drain. With MAX_BATCH_SIZE=3 and the settler's 5s flush timer, 10 events
 * spread across 5 slugs settle in <= 4 batches (~30s realistic). 60s gives
 * comfortable margin.
 */
import axios, { AxiosError, type AxiosResponse } from "axios";
import { loadConfig, MAINNET_ENDPOINT_SLUGS } from "./lib/config";
import { patchState, type CallOutcome, type FiredCall } from "./lib/state";

interface CallSpec {
  slug: string;
  expected: CallOutcome;
  /**
   * Path appended to `MARKET_PROXY_URL/v1/<slug>`. For JSON-RPC endpoints
   * (helius), the body method is what the proxy actually classifies.
   */
  path: string;
  method: "GET" | "POST";
  body?: unknown;
  /**
   * Extra query params to merge into the request URL beyond `pact_wallet`.
   */
  query?: Record<string, string>;
}

/**
 * Per-slug "ok" call template — chosen to be cheap, deterministic, and
 * always-200 against the real upstream. Update this table if any upstream
 * deprecates a path.
 */
const OK_CALL_TEMPLATES: Record<string, Omit<CallSpec, "slug" | "expected">> = {
  helius: {
    method: "POST",
    path: "/",
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "getBalance",
      params: ["11111111111111111111111111111111"],
    },
  },
  birdeye: {
    method: "GET",
    // Public-tier price endpoint (cheap; returns 200 + JSON).
    path: "/defi/price",
    query: { address: "So11111111111111111111111111111111111111112" },
  },
  jupiter: {
    method: "GET",
    // 1 lamport SOL -> USDC quote, near-zero impact, always 200.
    path: "/v6/quote",
    query: {
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amount: "1",
    },
  },
  elfa: {
    method: "GET",
    path: "/v1/health",
  },
  fal: {
    method: "GET",
    path: "/health",
  },
};

function pickTemplate(slug: string): Omit<CallSpec, "slug" | "expected"> {
  const t = OK_CALL_TEMPLATES[slug];
  if (!t) throw new Error(`No OK template for slug ${slug}`);
  return t;
}

/**
 * Build the 10-call sequence. Spread across 5 slugs (2 calls per slug);
 * the latency / server / network slots ride on top of the first slug for
 * predictability. Reorder via Fisher-Yates on top so we don't hammer one
 * slug in a row.
 */
function buildPlan(): CallSpec[] {
  const plan: CallSpec[] = [];

  // 7× ok calls, distributed across slugs
  for (let i = 0; i < 7; i++) {
    const slug = MAINNET_ENDPOINT_SLUGS[i % MAINNET_ENDPOINT_SLUGS.length];
    plan.push({ slug, expected: "ok", ...pickTemplate(slug) });
  }

  // 1× latency_breach via demo_breach=1 (requires test agent in demo allowlist)
  {
    const slug = "helius";
    const t = pickTemplate(slug);
    plan.push({
      slug,
      expected: "latency",
      ...t,
      query: { ...(t.query ?? {}), demo_breach: "1" },
    });
  }

  // 1× server_error: point at a path the upstream returns 5xx for. For
  // helius RPC, an unknown method returns -32601; for HTTP slugs, a known
  // 5xx-returning path. We fall back to a path designed to provoke a 5xx.
  // TBD: operator may need to wire a /__pact_smoke_5xx route on each upstream.
  plan.push({
    slug: "birdeye",
    expected: "server_error",
    method: "GET",
    path: "/__pact_smoke_5xx",
  });

  // 1× network_error: hit a slug whose upstreamBase is intentionally
  // unreachable for the smoke window (operator flips the upstream config
  // before this run, then flips back after). Best-effort.
  // TBD: requires operator coordination — see README "network_error".
  plan.push({
    slug: "jupiter",
    expected: "network_error",
    method: "GET",
    path: "/__pact_smoke_unreachable",
  });

  if (plan.length !== 10) {
    throw new Error(`expected 10 calls, got ${plan.length}`);
  }

  // Fisher-Yates shuffle so failure modes don't cluster
  for (let i = plan.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [plan[i], plan[j]] = [plan[j], plan[i]];
  }
  return plan;
}

interface FireResult {
  call: FiredCall;
}

async function fireOne(
  proxyBase: string,
  walletPubkey: string,
  spec: CallSpec,
): Promise<FireResult> {
  const url = new URL(`${proxyBase}/v1/${spec.slug}${spec.path}`);
  url.searchParams.set("pact_wallet", walletPubkey);
  for (const [k, v] of Object.entries(spec.query ?? {})) {
    url.searchParams.set(k, v);
  }
  const sentAtMs = Date.now();
  let res: AxiosResponse<unknown> | undefined;
  let proxyStatus = 0;
  try {
    const r = await axios.request({
      url: url.toString(),
      method: spec.method,
      data: spec.body,
      headers: {
        "content-type": spec.body ? "application/json" : undefined,
      },
      // Don't throw on 4xx/5xx — we WANT to record them.
      validateStatus: () => true,
      timeout: 30_000,
    });
    res = r;
    proxyStatus = r.status;
  } catch (e) {
    // Network error / DNS / timeout — proxy never responded.
    proxyStatus = 0;
    void (e as AxiosError);
  }

  const headers = (res?.headers ?? {}) as Record<string, string>;
  const callId = (headers["x-pact-call-id"] ?? "").toString();
  const premium = (headers["x-pact-premium"] ?? "0").toString();
  const refund = (headers["x-pact-refund"] ?? "0").toString();
  const outcomeHeader = (headers["x-pact-outcome"] ?? "").toString();

  return {
    call: {
      callId,
      slug: spec.slug,
      expectedOutcome: spec.expected,
      sentAtMs,
      proxyStatus,
      premiumLamports: premium,
      refundLamports: refund,
      outcomeHeader,
    },
  };
}

async function main() {
  const cfg = loadConfig();
  const wallet = cfg.testAgent.publicKey.toBase58();
  const plan = buildPlan();

  console.log(`=== Pact Network mainnet smoke fire (10 calls) ===`);
  console.log(`  Proxy:    ${cfg.marketProxyUrl}`);
  console.log(`  Wallet:   ${wallet}`);
  console.log(`  Drain:    ${cfg.settlerDrainMs}ms after last publish\n`);

  const calls: FiredCall[] = [];
  for (let i = 0; i < plan.length; i++) {
    const spec = plan[i];
    process.stdout.write(
      `  [${String(i + 1).padStart(2)}/10] ${spec.slug.padEnd(8)} ${spec.expected.padEnd(14)} ... `,
    );
    const r = await fireOne(cfg.marketProxyUrl, wallet, spec);
    calls.push(r.call);
    console.log(
      `status=${r.call.proxyStatus} outcome=${r.call.outcomeHeader || "(none)"} callId=${r.call.callId.slice(0, 12) || "(none)"}`,
    );
    // Pace publishes so the settler's batcher fills serially rather than
    // bunching all 10 into one or two batches. 1.5s between calls => the
    // 5s flush timer can drain whatever it has before the next one arrives.
    await new Promise((r) => setTimeout(r, 1_500));
  }

  patchState({ firedAt: new Date().toISOString(), calls });

  console.log(`\nWaiting ${cfg.settlerDrainMs}ms for the settler to drain ...`);
  await new Promise((r) => setTimeout(r, cfg.settlerDrainMs));

  // Quick sanity printout of expected vs observed outcomes
  console.log("\nObserved outcome headers (vs expected):");
  for (const c of calls) {
    console.log(
      `  ${c.slug.padEnd(8)} ${c.expectedOutcome.padEnd(14)} -> ${c.outcomeHeader || "(missing)"}`,
    );
  }

  console.log("\n=== fire COMPLETE — proceed to 02-reconcile ===");
}

main().catch((e) => {
  console.error("\nFIRE FAILED:", e instanceof Error ? e.message : e);
  if (e instanceof Error && e.stack) console.error(e.stack);
  process.exit(1);
});
