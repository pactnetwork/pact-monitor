import { randomUUID } from "node:crypto";
import { Connection, PublicKey } from "@solana/web3.js";
import { fetchEndpoints, resolveSlug, invalidateCache } from "../lib/discovery.ts";
import { loadOrCreateWallet } from "../lib/wallet.ts";
import { loadEvmWallet, type EvmWalletLoadResult } from "../lib/evm-wallet.ts";
import { isEvmNetwork, faucetForNetwork } from "../lib/evm-faucets.ts";
import { signedRequest, type SignedRequestResult } from "../lib/transport.ts";
import { getUsdcAtaBalanceLamports, resolveClusterConfig } from "../lib/solana.ts";
import { type Envelope, type Outcome } from "../lib/envelope.ts";

export interface RunOpts {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  configDir: string;
  gatewayUrl: string;
  project: string;
  network?: string;
  rpcUrl?: string;
  raw?: boolean;
  skipBalanceCheck?: boolean;
  timeoutMs?: number;
  getBalanceLamports?: (pubkey: PublicKey) => Promise<bigint>;
  /** Optional EVM keypair override (forwarded from `--keypair` on an EVM call). */
  evmKeypairPath?: string;
  /**
   * Sink for the freshly-generated EVM wallet hint. Defaults to stderr so
   * tests can inject a spy. Only invoked when the wallet was just created.
   */
  printEvmInitHint?: (msg: string) => void;
}

/**
 * Result of the lazy EVM wallet check; exposed for tests. `halt:true` means
 * the wallet was just generated and the caller should stop before issuing any
 * network request so the user can fund the address.
 */
export interface EvmWalletInitResult {
  wallet: EvmWalletLoadResult;
  halt: boolean;
  hint: string | null;
}

/**
 * Resolve the EVM wallet for the call's --network, mirroring the Solana
 * loadOrCreateWallet UX: lazy generation on first contact, halt with a
 * funding hint, otherwise re-use silently. Returns null when --network is
 * not an EVM chain (Solana path is unchanged).
 */
export function ensureEvmWalletForCall(opts: {
  configDir: string;
  network: string | undefined;
  keypairPath?: string;
  print?: (msg: string) => void;
}): EvmWalletInitResult | null {
  if (!isEvmNetwork(opts.network)) return null;
  const wallet = loadEvmWallet({
    configDir: opts.configDir,
    network: opts.network,
    keypairPath: opts.keypairPath,
  });
  if (!wallet.created) return { wallet, halt: false, hint: null };
  const faucet = faucetForNetwork(opts.network) ?? "—";
  const hint = [
    "[pact] generated a new EVM wallet (shared across EVM chains):",
    `       address: ${wallet.address}`,
    `       file:    ${wallet.path}`,
    `       chain:   ${opts.network}`,
    `       faucet:  ${faucet}`,
    "[pact] fund the address above, then re-run your command.",
  ].join("\n");
  (opts.print ?? ((m: string) => process.stderr.write(m + "\n")))(hint);
  return { wallet, halt: true, hint };
}

export async function runCommand(opts: RunOpts): Promise<Envelope> {
  // --raw is a true direct upstream call: no discovery, no balance check, no
  // gateway, no Pact signing, no premium. The user is calling whatever URL
  // they passed, uninsured, with their own headers/method/body. The mainnet
  // gate (PACT_MAINNET_ENABLED=1) still fires upstream of this function via
  // validateClusterStrict in src/index.ts at commander parse time, so a
  // raw call without the gate set never reaches this branch.
  if (opts.raw) {
    return rawDirectCall(opts);
  }

  // EVM lazy-gen parity with Solana (project_cli_evm_wallet_init): on the
  // first --network <evm-chain> call with no wallet on disk, generate +
  // persist the shared EVM key, print the funding hint to stderr, and
  // return an `ok` envelope so the CLI exits 0 without touching the gateway.
  // Re-runs (wallet present) fall through to the normal call path.
  const evmInit = ensureEvmWalletForCall({
    configDir: opts.configDir,
    network: opts.network,
    keypairPath: opts.evmKeypairPath,
    print: opts.printEvmInitHint,
  });
  if (evmInit?.halt) {
    return {
      status: "ok",
      body: {
        evm_wallet_created: true,
        address: evmInit.wallet.address,
        network: opts.network,
        next: "fund the address with native gas + USDC, then re-run",
      },
    };
  }

  let endpoints;
  try {
    endpoints = await fetchEndpoints({
      configDir: opts.configDir,
      gatewayUrl: opts.gatewayUrl,
    });
  } catch (err) {
    return {
      status: "discovery_unreachable",
      body: { gateway_url: opts.gatewayUrl, error: (err as Error).message },
    };
  }

  let slug: string;
  let upstreamPath: string;
  let provider: { premiumBps: number } | null = null;

  const r = resolveSlug({ url: opts.url, endpoints: endpoints.endpoints });
  if (!r.ok) {
    if (r.reason === "no_provider") {
      return {
        status: "no_provider",
        body: {
          hostname: r.hostname,
          reason:
            "Endpoint not yet onboarded. Request access via the Pact team — v0.1.0 has no auto-provision flow.",
          suggest: "use --raw for an uninsured call",
        },
      };
    }
    return {
      status: "endpoint_paused",
      body: { hostname: r.hostname },
    };
  }
  slug = r.slug;
  upstreamPath = r.upstreamPath;
  provider = endpoints.endpoints.find((e: { slug: string }) => e.slug === r.slug) ?? null;

  const wallet = loadOrCreateWallet({ configDir: opts.configDir });

  if (!opts.skipBalanceCheck && provider) {
    const pubkey = wallet.keypair.publicKey;
    let balanceLamports: bigint;
    if (opts.getBalanceLamports) {
      balanceLamports = await opts.getBalanceLamports(pubkey);
    } else {
      const cfg = resolveClusterConfig();
      if ("error" in cfg) {
        return { status: "client_error", body: { error: cfg.error } };
      }
      const rpcUrl = opts.rpcUrl ?? "https://api.mainnet-beta.solana.com";
      const connection = new Connection(rpcUrl, "confirmed");
      balanceLamports = await getUsdcAtaBalanceLamports({
        connection,
        agentPubkey: pubkey,
        mint: cfg.mint,
      });
    }
    const estimatedPremium = BigInt(Math.max(100, Math.ceil(provider.premiumBps * 1_000_000 / 10000)));
    if (balanceLamports < estimatedPremium) {
      return {
        status: "needs_funding",
        body: {
          wallet: pubkey.toBase58(),
          needed_usdc: Number(estimatedPremium) / 1_000_000,
          current_balance_usdc: Number(balanceLamports) / 1_000_000,
          deposit_url: `https://dashboard.pactnetwork.io/agents/${pubkey.toBase58()}`,
        },
      };
    }
  }

  let resp: SignedRequestResult;
  try {
    resp = await signedRequest({
      gatewayUrl: opts.gatewayUrl,
      slug,
      upstreamPath,
      method: opts.method,
      headers: opts.headers,
      body: opts.body,
      keypair: wallet.keypair,
      project: opts.project,
      network: opts.network,
      timeoutMs: opts.timeoutMs,
    });
  } catch (err) {
    return {
      status: "server_error",
      body: { error: (err as Error).message },
      meta: {
        slug,
        outcome: "server_error",
        latency_ms: -1,
        tx_signature: null,
      },
    };
  }

  if (resp.status === 401 && (resp.headers["x-pact-error"] === "signature_rejected" || resp.body.includes("signature_rejected"))) {
    return {
      status: "signature_rejected",
      body: { hint: "clock skew likely; try `sudo ntpdate` or surface to user" },
    };
  }

  // Cache-invalidating retry on 404/410/423 with a Pact-* header. Note:
  // --raw early-returns above and never reaches this path.
  if (
    (resp.status === 404 && resp.body.includes("unknown_slug")) ||
    resp.status === 410 ||
    resp.status === 423
  ) {
    invalidateCache(opts.configDir);
    if (resp.status === 423) {
      return {
        status: "endpoint_paused",
        body: { slug },
      };
    }
    // refresh and retry once for 404/410
    const refreshed = await fetchEndpoints({
      configDir: opts.configDir,
      gatewayUrl: opts.gatewayUrl,
      forceRefresh: true,
    });
    const r2 = resolveSlug({ url: opts.url, endpoints: refreshed.endpoints });
    if (r2.ok) {
      const retry = await signedRequest({
        gatewayUrl: opts.gatewayUrl,
        slug: r2.slug,
        upstreamPath: r2.upstreamPath,
        method: opts.method,
        headers: opts.headers,
        body: opts.body,
        keypair: wallet.keypair,
        project: opts.project,
        network: opts.network,
        timeoutMs: opts.timeoutMs,
      });
      return buildEnvelope(retry, r2.slug);
    }
  }

  return buildEnvelope(resp, slug);
}

function buildEnvelope(
  resp: SignedRequestResult,
  slug: string,
): Envelope {
  let outcome: Outcome;
  if (resp.status >= 200 && resp.status < 300) outcome = "ok";
  else if (resp.status >= 400 && resp.status < 500) outcome = "client_error";
  else outcome = "server_error";

  let parsedBody: unknown = resp.body;
  try {
    parsedBody = JSON.parse(resp.body);
  } catch {
    /* keep raw */
  }

  const callId = resp.callId ?? `call_${randomUUID()}`;
  const callIdSource: "gateway" | "local_fallback" = resp.callId ? "gateway" : "local_fallback";

  // Premium / refund / settlement state are emitted by the gateway as response
  // headers (see packages/wrap/src/headers.ts). Fetch lowercases header keys,
  // and signedRequest preserves that, so read them lowercased. Missing headers
  // default to 0 / false for old-gateway tolerance.
  const premiumLamports = Number.parseInt(resp.headers["x-pact-premium"] ?? "", 10);
  const premiumLamportsSafe = Number.isFinite(premiumLamports) ? premiumLamports : 0;
  const refundLamports = Number.parseInt(resp.headers["x-pact-refund"] ?? "", 10);
  const refundLamportsSafe = Number.isFinite(refundLamports) ? refundLamports : 0;
  const settlementPending = resp.headers["x-pact-settlement-pending"] === "1";

  // tx_signature is null in the immediate envelope: the gateway acknowledges
  // the call synchronously but settle_batch is submitted asynchronously by the
  // settler (typically 5-60s later). The on-chain signature surfaces in the
  // indexer's GET /api/calls/:id once settlement lands.
  return {
    status: outcome,
    body: parsedBody,
    meta: {
      slug,
      call_id: callId,
      call_id_source: callIdSource,
      latency_ms: resp.latencyMs,
      outcome,
      premium_lamports: premiumLamportsSafe,
      premium_usdc: premiumLamportsSafe / 1_000_000,
      refund_lamports: refundLamportsSafe,
      settlement_pending: settlementPending,
      tx_signature: null,
      settlement_eta_sec: 8,
    },
  };
}

// --raw: direct upstream fetch, uninsured. No discovery, no balance check,
// no Pact gateway, no Pact signing headers, no premium. The user's URL is
// called as-is with their headers/method/body. Outcome envelope mirrors the
// gateway path (ok / client_error / server_error) so --json consumers see
// the same shape, with call_id_source="local_fallback" because there's no
// gateway to assign a call id and slug="raw" to indicate the bypass.
async function rawDirectCall(opts: RunOpts): Promise<Envelope> {
  // Defense-in-depth: re-check the closed-beta gate at point-of-use. Commander's
  // --cluster validator only fires when the user passes --cluster explicitly;
  // a bare `pact --raw <url>` defaults to "mainnet" without coercion, so the
  // gate must be re-checked here. Mirrors the same call resolveClusterConfig()
  // does on the gateway path. (Earlier codex review on PR #64 flagged the
  // analogous gap in pact pay; this closes the same hole for --raw.)
  const cfg = resolveClusterConfig();
  if ("error" in cfg) {
    return { status: "client_error", body: { error: cfg.error } };
  }

  const timeoutMs = opts.timeoutMs ?? 30000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const startedAt = Date.now();

  let status: number;
  let bodyText: string;
  try {
    const resp = await fetch(opts.url, {
      method: opts.method,
      headers: opts.headers,
      body: opts.body && opts.body.length > 0 ? opts.body : undefined,
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    status = resp.status;
    bodyText = await resp.text();
  } catch (err) {
    clearTimeout(timer);
    return {
      status: "server_error",
      body: { error: (err as Error).message, url: opts.url, raw: true },
      meta: {
        slug: "raw",
        call_id: `call_${randomUUID()}`,
        call_id_source: "local_fallback",
        latency_ms: Date.now() - startedAt,
        outcome: "server_error",
        tx_signature: null,
        raw: true,
      },
    };
  }

  let outcome: Outcome;
  if (status >= 200 && status < 300) outcome = "ok";
  else if (status >= 400 && status < 500) outcome = "client_error";
  else outcome = "server_error";

  let parsedBody: unknown = bodyText;
  try {
    parsedBody = JSON.parse(bodyText);
  } catch {
    /* keep raw text */
  }

  return {
    status: outcome,
    body: parsedBody,
    meta: {
      slug: "raw",
      call_id: `call_${randomUUID()}`,
      call_id_source: "local_fallback",
      latency_ms: Date.now() - startedAt,
      outcome,
      tx_signature: null,
      raw: true,
    },
  };
}
