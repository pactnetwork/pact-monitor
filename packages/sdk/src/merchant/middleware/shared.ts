/**
 * Framework-agnostic merchant middleware core.
 *
 * Each framework adapter (express/fastify/hono) reduces to:
 *   1. parse inbound X-Pact-Pubkey + X-Pact-Started-At;
 *   2. on response-finished, classify + fire-and-forget observation POST;
 *   3. before response is sent, when an agent is attributed, stamp the
 *      response with X-Pact-Proxied-By + X-Pact-Proxied-Sig.
 *
 * The adapter supplies thin shims for reading the inbound headers, reading
 * the response status, and stamping outbound headers; the rest is shared.
 */
import {
  defaultClassify,
  type Classification,
} from "../classifier.js";
import { signProxiedBy, type ProxiedByMessage } from "../attestation.js";
import type { MerchantClient } from "../client.js";

export interface PricingEntry {
  amountUsd: number;
}
export type PricingMap = Record<string, PricingEntry>;

export interface ClassifyResponseInput {
  statusCode: number;
  latencyMs: number;
  matchedPath: string;
  hostname: string;
}

/**
 * Optional merchant-supplied classifier hint. Return `undefined` to defer
 * to the default classifier. The backend re-runs the default classifier as
 * the authoritative classification regardless of this hint (spec §4).
 */
export type ClassifyResponseFn = (
  input: ClassifyResponseInput,
) => Classification | undefined;

export interface MiddlewareOptions {
  pricing: PricingMap;
  classifyResponse?: ClassifyResponseFn;
  latencyThresholdMs?: number;
}

export interface InboundContext {
  /** Agent pubkey from X-Pact-Pubkey, or null when absent. */
  agentPubkey: string | null;
  /**
   * Canonical start time in ms epoch. Falls back to Date.now() when the
   * inbound X-Pact-Started-At header is missing or unparseable.
   */
  startedAt: number;
  /** Matched route key used for pricing + endpoint identity. */
  matchedPath: string;
}

export interface MiddlewareDeps {
  client: MerchantClient;
  merchantPubkey: string;
  secretKey: Uint8Array | null;
  hostname: string;
}

export interface PreparedAttestation {
  headerName: string;
  headerSig: string;
  headerValueBy: string;
  headerValueSig: string;
}

export function parseInbound(
  headers: Record<string, string | string[] | undefined>,
  matchedPath: string,
): InboundContext {
  const get = (k: string): string | undefined => {
    const v = headers[k] ?? headers[k.toLowerCase()];
    if (Array.isArray(v)) return v[0];
    return v;
  };
  const agent = get("x-pact-pubkey");
  const startedRaw = get("x-pact-started-at");
  const startedNum = startedRaw ? Number(startedRaw) : NaN;
  return {
    agentPubkey: agent && agent.length > 0 ? agent : null,
    startedAt: Number.isFinite(startedNum) ? startedNum : Date.now(),
    matchedPath,
  };
}

/**
 * Build the attestation headers when an agent is attributed. Returns null
 * when no agent header is present (nothing to attribute) or the merchant
 * signer cannot expose a secret key.
 */
export function buildAttestation(
  deps: MiddlewareDeps,
  inbound: InboundContext,
  statusCode: number,
): PreparedAttestation | null {
  if (!inbound.agentPubkey) return null;
  if (!deps.secretKey) return null;
  const msg: ProxiedByMessage = {
    merchantPubkey: deps.merchantPubkey,
    agentPubkey: inbound.agentPubkey,
    startedAt: inbound.startedAt,
    endpoint: inbound.matchedPath,
    statusCode,
  };
  const sig = signProxiedBy(msg, deps.secretKey);
  return {
    headerName: "X-Pact-Proxied-By",
    headerSig: "X-Pact-Proxied-Sig",
    headerValueBy: deps.merchantPubkey,
    headerValueSig: sig,
  };
}

/**
 * Classify a finished response. Composes the merchant hint with the default.
 */
export function classifyFinished(
  options: MiddlewareOptions,
  input: ClassifyResponseInput,
): Classification {
  const hint = options.classifyResponse?.(input);
  if (hint) return hint;
  return defaultClassify({
    statusCode: input.statusCode,
    latencyMs: input.latencyMs,
    latencyThresholdMs: options.latencyThresholdMs,
  });
}

/**
 * Fire-and-forget observation POST. Errors are swallowed so a backend hiccup
 * never affects the agent's response — the golden rule (spec §10) applies
 * symmetrically on the merchant side.
 */
export function postObservationFireAndForget(
  deps: MiddlewareDeps,
  options: MiddlewareOptions,
  inbound: InboundContext,
  statusCode: number,
  latencyMs: number,
  logger?: { warn?: (msg: unknown) => void },
): void {
  if (!(inbound.matchedPath in options.pricing)) return;
  const classification = classifyFinished(options, {
    statusCode,
    latencyMs,
    matchedPath: inbound.matchedPath,
    hostname: deps.hostname,
  });
  const body: Record<string, unknown> = {
    hostname: deps.hostname,
    endpoint: inbound.matchedPath,
    startedAt: inbound.startedAt,
    statusCode,
    latencyMs,
    classification,
  };
  if (inbound.agentPubkey) body.agentPubkey = inbound.agentPubkey;
  void deps.client.postObservation(body).catch((err: unknown) => {
    logger?.warn?.({ err, msg: "merchant observation post failed (degraded)" });
  });
}
