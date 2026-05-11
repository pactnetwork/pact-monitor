// pact-dummy-upstream — a deliberately flaky HTTP "price quote" API.
//
// This is the demo/test target for Pact Network premium coverage. The whole
// point of the service is the query-string toggles on `GET /quote/:symbol`:
// they let Pact's coverage flow be exercised deterministically (agent paid →
// upstream 5xx'd → refund must trigger; latency SLA breach; x402 paywall;
// arbitrary status / body echoes).
//
// Conventions mirror packages/market-proxy: Hono + @hono/node-server +
// TypeScript + multi-stage pnpm Dockerfile. This service is much simpler —
// no DB, no Solana, no env beyond PORT.

import { Hono } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import {
  buildX402Accept,
  buildX402Challenge,
  encodeAcceptHeader,
} from "./x402.js";

const SERVICE = "pact-dummy-upstream";
const DEFAULT_PRICE = "287.90";
const DEFAULT_CURRENCY = "USD";

// Max latency we'll honor on ?latency= — keeps a demo from hanging forever
// (and a Cloud Run request from timing out the container).
const MAX_LATENCY_MS = 10_000;

// HTTP statuses that, per the spec, MUST NOT carry a response body. We echo
// these with an empty body so Hono / undici don't choke.
const CONTENTLESS_STATUSES = new Set([101, 204, 205, 304]);
function isContentless(status: number): boolean {
  return CONTENTLESS_STATUSES.has(status) || (status >= 100 && status < 200);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Parse `?latency=<ms>` → clamped int in [0, MAX_LATENCY_MS], or null if
// absent / not a non-negative integer.
function parseLatency(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(0, Math.trunc(n)), MAX_LATENCY_MS);
}

// Parse `?status=<3-digit>` → int in [100, 599], or null if absent /
// invalid (we ignore garbage rather than 400-ing — the toggle is a demo aid).
function parseStatus(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  if (!/^\d{3}$/.test(raw)) return null;
  const n = Number(raw);
  if (n < 100 || n > 599) return null;
  return n;
}

const HTML_INDEX = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>pact-dummy-upstream</title>
<style>
  body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; max-width: 760px; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; color: #222; }
  h1 { font-size: 1.4rem; }
  code, pre { background: #f4f4f4; border-radius: 4px; }
  code { padding: 0.1rem 0.3rem; }
  pre { padding: 0.75rem 1rem; overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  th, td { text-align: left; border-bottom: 1px solid #ddd; padding: 0.4rem 0.6rem; vertical-align: top; }
  th { background: #fafafa; }
  .muted { color: #777; }
</style>
</head>
<body>
<h1>pact-dummy-upstream</h1>
<p>A deliberately flaky price-quote API. It is the demo/test target for
<strong>Pact Network</strong> premium coverage — the query-string toggles below
let the coverage flow (agent paid &rarr; upstream failed &rarr; refund) be
exercised deterministically.</p>

<h2>Routes</h2>
<ul>
  <li><code>GET /health</code> &rarr; <code>{"status":"ok","service":"${SERVICE}"}</code></li>
  <li><code>GET /quote/:symbol</code> &rarr; a JSON price quote (toggles below)</li>
  <li><code>GET /</code> &rarr; this page</li>
</ul>

<h2><code>/quote/:symbol</code> toggles</h2>
<table>
  <tr><th>query</th><th>effect</th></tr>
  <tr><td><span class="muted">(none)</span></td><td>200 JSON quote: <code>{"symbol":"AAPL","price":"${DEFAULT_PRICE}","currency":"${DEFAULT_CURRENCY}","source":"${SERVICE}","ts":&lt;unix ms&gt;}</code></td></tr>
  <tr><td><code>?fail=1</code></td><td>503 <code>{"error":"upstream_unavailable","symbol":...}</code> — the "agent paid, upstream 5xx'd, refund must trigger" case</td></tr>
  <tr><td><code>?status=&lt;100-599&gt;</code></td><td>respond with that HTTP status code</td></tr>
  <tr><td><code>?latency=&lt;ms&gt;</code></td><td>sleep that many ms before responding (clamped 0&ndash;${MAX_LATENCY_MS}) — for latency-SLA-breach demos</td></tr>
  <tr><td><code>?body=&lt;string&gt;</code></td><td>return that string verbatim as <code>text/plain</code> instead of the JSON quote</td></tr>
  <tr><td><code>?x402=1</code></td><td>402 Payment Required with an x402-style challenge (<code>accepts</code> array + <code>PAYMENT-REQUIRED</code> header) so <code>pay</code> / <code>pact pay</code> would attempt payment</td></tr>
</table>
<p class="muted">Toggles compose, e.g. <code>?fail=1&amp;latency=2000</code> sleeps then 503s.
Precedence: <code>x402</code> &rarr; <code>status</code> &rarr; <code>fail</code> &rarr; <code>body</code> &rarr; default quote
(latency is applied first, regardless).</p>

<h2>Example curls</h2>
<pre>curl -s http://localhost:8080/health
curl -s http://localhost:8080/quote/AAPL
curl -si http://localhost:8080/quote/AAPL?fail=1            # 503
curl -si http://localhost:8080/quote/AAPL?status=502        # 502
curl -s  http://localhost:8080/quote/AAPL?latency=1500      # ~1.5s delay
curl -s  'http://localhost:8080/quote/AAPL?body=hello'      # text/plain "hello"
curl -si http://localhost:8080/quote/AAPL?x402=1            # 402 + x402 challenge
curl -si 'http://localhost:8080/quote/AAPL?fail=1&latency=2000'  # composes</pre>
</body>
</html>
`;

export function quoteJson(symbol: string): {
  symbol: string;
  price: string;
  currency: string;
  source: string;
  ts: number;
} {
  return {
    symbol: symbol.toUpperCase(),
    price: DEFAULT_PRICE,
    currency: DEFAULT_CURRENCY,
    source: SERVICE,
    ts: Date.now(),
  };
}

export function createApp(): Hono {
  const app = new Hono();

  app.get("/", (c) => c.html(HTML_INDEX));

  app.get("/health", (c) => c.json({ status: "ok", service: SERVICE }));

  app.get("/quote/:symbol", async (c) => {
    const rawSymbol = c.req.param("symbol") ?? "";
    const symbol = rawSymbol.toUpperCase();
    const q = c.req.query();

    // 1. Latency is applied first, regardless of which response branch wins
    //    — a latency-SLA-breach demo wants the delay even on a 503.
    const latency = parseLatency(q.latency);
    if (latency !== null && latency > 0) {
      await sleep(latency);
    }

    // 2. x402 paywall — highest precedence: a paid call should never be
    //    masked by a ?status= echo.
    if (q.x402 === "1") {
      const resourceUrl = c.req.url;
      const accept = buildX402Accept(resourceUrl);
      const challenge = buildX402Challenge(resourceUrl);
      c.header("WWW-Authenticate", 'x402 realm="pact-dummy-upstream"');
      c.header("PAYMENT-REQUIRED", encodeAcceptHeader(accept));
      return c.json(challenge, 402);
    }

    // 3. Arbitrary status echo. Content-less statuses (101/204/205/304, 1xx)
    //    get an empty body; everything else gets a small JSON echo.
    const status = parseStatus(q.status);
    if (status !== null) {
      if (isContentless(status)) {
        return c.newResponse(null, status as StatusCode);
      }
      return c.newResponse(
        JSON.stringify({ status, symbol, source: SERVICE, ts: Date.now() }),
        status as StatusCode,
        { "content-type": "application/json" },
      );
    }

    // 4. The canonical "upstream is down" case — agent paid, upstream 5xx'd,
    //    Pact's refund must trigger.
    if (q.fail === "1") {
      return c.json(
        { error: "upstream_unavailable", symbol, source: SERVICE, ts: Date.now() },
        503,
      );
    }

    // 5. Verbatim body echo (text/plain).
    if (typeof q.body === "string") {
      return c.text(q.body, 200);
    }

    // 6. Default: a 200 JSON price quote.
    return c.json(quoteJson(symbol));
  });

  return app;
}
