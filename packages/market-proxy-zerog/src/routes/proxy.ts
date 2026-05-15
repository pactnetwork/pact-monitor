// Insured 0G-Compute proxy route. Ports the Solana market-proxy flow; the
// insurance core (wrapFetch) is reused verbatim — it already emits the exact
// SettlementEvent settler-evm consumes, with `agentPubkey = walletPubkey`.

import type { Context } from 'hono';
import { getAddress, isAddress } from 'viem';
import { wrapFetch, defaultClassifier } from '@pact-network/wrap';
import { getContext } from '../context.js';
import { makeComputeFetchImpl } from '../compute-fetch.js';

interface ChatBody {
  messages?: Array<{ role: string; content: string }>;
}

function readMessages(body: unknown): ChatBody['messages'] | null {
  if (!body || typeof body !== 'object') return null;
  const m = (body as ChatBody).messages;
  if (!Array.isArray(m) || m.length === 0) return null;
  for (const e of m) {
    if (!e || typeof e.role !== 'string' || typeof e.content !== 'string') {
      return null;
    }
  }
  return m;
}

export async function proxyRoute(c: Context): Promise<Response> {
  const ctx = getContext();
  const slug = c.req.param('slug') ?? '';

  // 1. Resolve endpoint (static provider map + on-chain pricing, cached).
  const ep = await ctx.resolveEndpoint(slug);
  if (!ep.ok) {
    return c.json({ error: ep.error }, ep.status);
  }

  // 2. Agent identity. Verified ECDSA path sets a checksummed address; the
  //    demo path (?pact_wallet=) is gated by PACT_PROXY_INSECURE_DEMO.
  const verified = (c.get as (k: string) => string | undefined)(
    'verifiedAgent',
  );
  let agent: `0x${string}` | undefined;
  if (verified) {
    agent = verified as `0x${string}`;
  } else {
    const q = c.req.query('pact_wallet');
    if (q) {
      if (ctx.env.PACT_PROXY_INSECURE_DEMO !== '1') {
        return c.json(
          {
            error: 'pact_auth_missing',
            message:
              '?pact_wallet= is gated by PACT_PROXY_INSECURE_DEMO. Send a signed x-pact-agent header.',
          },
          401,
        );
      }
      if (!isAddress(q)) {
        return c.json({ error: 'pact_auth_bad_sig', message: 'pact_wallet is not an EVM address' }, 401);
      }
      agent = getAddress(q);
    }
  }

  // 3. Read the body ONCE (Hono buffers; auth middleware already cloned).
  let parsed: unknown = null;
  try {
    parsed = await c.req.json();
  } catch {
    parsed = null;
  }
  const messages = readMessages(parsed);

  // 4. Provider endpoint/model (cached; primed at boot or lazily here — 5.A).
  await ctx.providerMeta.ensure();
  const meta = ctx.providerMeta.get(ep.provider);
  if (!meta) {
    return c.json({ error: 'provider_unavailable', provider: ep.provider }, 503);
  }

  // 5. Uninsured passthrough — no agent identity. Still serve the inference
  //    (faithful to the Solana passthrough) but charge nothing, emit nothing.
  if (!agent) {
    if (!messages) {
      return c.json({ error: 'invalid_request', message: 'expected { messages: [...] }' }, 400);
    }
    try {
      const r = await ctx.zerogCompute.callInferenceWith({
        provider: ep.provider,
        endpoint: meta.endpoint,
        model: ep.model,
        messages,
        teeVerify: ctx.env.ZEROG_COMPUTE_TEE_VERIFY,
      });
      return c.json(r.body as Record<string, unknown>, 200);
    } catch (err) {
      return c.json(
        { error: 'zerog_compute_failed', message: err instanceof Error ? err.message : String(err) },
        502,
      );
    }
  }

  // 6. Insured path requires a well-formed chat body.
  if (!messages) {
    return c.json({ error: 'invalid_request', message: 'expected { messages: [...] }' }, 400);
  }

  // 7. Force-breach demo (gated). Threading a pre-delay into the shim makes
  //    wrap's stopwatch include it → natural latency_breach.
  const demoBreach =
    c.req.query('demo_breach') === '1' &&
    ctx.env.PACT_PROXY_INSECURE_DEMO === '1';
  const preDelayMs = demoBreach
    ? ep.wrapConfig.sla_latency_ms + 300
    : undefined;

  const fetchImpl = makeComputeFetchImpl({
    zerogCompute: ctx.zerogCompute,
    provider: ep.provider,
    endpoint: meta.endpoint,
    model: ep.model,
    messages,
    preDelayMs,
    teeVerify: ctx.env.ZEROG_COMPUTE_TEE_VERIFY,
  });

  // 8. The insurance core. `walletPubkey` is already checksummed so
  //    settler-evm's getAddress() is a no-op and isAddress() passes
  //    (BLOCKER #3 cross-package contract).
  const result = await wrapFetch({
    endpointSlug: slug,
    walletPubkey: agent,
    upstreamUrl: `zerog-compute://${ep.provider}`,
    classifier: defaultClassifier,
    sink: ctx.sink,
    balanceCheck: ctx.balanceCheck,
    endpointConfig: ep.wrapConfig,
    fetchImpl,
    pool: slug,
  });

  // wrap already attached X-Pact-* on top of the synthetic upstream (whose
  // x-zerog-* survive via attachPactHeaders' header copy). CORS is applied
  // app-wide in index.ts.
  return result.response;
}
