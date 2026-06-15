/**
 * `createPact()` — wires every module into the `PactInstance` surface.
 *
 * The covered-call path: canonical hostname -> slug (discovery) -> proxied,
 * signed request -> X-Pact-* parsed -> durable buffer -> `failure` event.
 * The settled truth (`billed`/`refund`) arrives asynchronously from the
 * best-effort indexer poller. On-chain ops are the only methods that throw,
 * and they reject early on devnet/localnet when the program ID is unset
 * (plan blocker B1) rather than delegating to the wrong PDA.
 *
 * `pact.wrap()` (HTTP client adapters) is added in Phase 8.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import {
  getEndpointConfigPda,
  decodeEndpointConfig,
  slugBytes,
} from "@q3labs/pact-protocol-v1-client";
import { validateConfig, type PactConfig } from "./config.js";
import { resolveNetwork, type ResolvedNetwork } from "./network.js";
import {
  isEvmSigner,
  resolveSignFn,
  signerAddress,
  signerVm,
  type SolanaPactSigner,
} from "./signer.js";
import { canonicalHostname } from "./hostname.js";
import { SlugResolver } from "./slug-resolver.js";
import { selectStorage } from "./storage-select.js";
import { IndexerPoller, type SettledNotification } from "./indexer-poller.js";
import { PactEventEmitter, type PactEventMap, type PactEventName } from "./events.js";
import { LifecycleManager } from "./lifecycle.js";
import {
  createWebhookHandler,
  startWebhookServer,
  type WebhookHandlerRequest,
  type WebhookHandlerResponse,
} from "./webhook.js";
import { goldenFetch, type GoldenFetchDeps } from "./golden-fetch.js";
import { wrapClient } from "./adapters.js";
import {
  ensureAtaAndApprove,
  topUp as onChainTopUp,
  revoke as onChainRevoke,
  readInsurableState,
  startAutoTopUpWatcher,
  type OnChainContext,
  type AutoTopUpWatcher,
} from "./on-chain.js";
import { PactError, PactErrorCode } from "./errors.js";
import type {
  AgentPolicyState,
  AgentStats,
  ClaimRecord,
  PremiumEstimate,
} from "./state.js";

export interface PactFetchCallOptions {
  /**
   * Informational only on V1 proxy-routed calls: premium/refund are fixed by
   * the on-chain EndpointConfig, not by a declared value.
   */
  insure?: number | bigint;
  expectedSchema?: { type: string; required?: string[] };
  /** Resolve coverage against this host instead of the URL's host. */
  hostnameOverride?: string;
}

export interface PactInstance {
  fetch(
    url: string,
    init?: RequestInit,
    opts?: PactFetchCallOptions,
  ): Promise<Response>;
  setup(opts?: { allowanceUsdc?: number }): Promise<{ txSignature: string }>;
  topUp(allowanceUsdc: number): Promise<{ txSignature: string }>;
  revoke(): Promise<{ txSignature: string }>;
  policy(): Promise<AgentPolicyState>;
  claims(opts?: { since?: number; limit?: number }): Promise<ClaimRecord[]>;
  estimate(hostnameOrUrl: string): Promise<PremiumEstimate>;
  stats(): AgentStats;
  /** Route an existing ky / axios / got / fetch client through pact.fetch. */
  wrap<T>(client: T): T;
  /**
   * Framework-agnostic webhook receiver (serverless/Express/etc). Present
   * only when `config.webhook` is set. Verifies the indexer signature and
   * feeds the SAME reconcile sink as the poller (no double-emit).
   */
  webhookHandler?: (
    req: WebhookHandlerRequest,
  ) => Promise<WebhookHandlerResponse>;
  on<K extends PactEventName>(
    event: K,
    listener: (...args: PactEventMap[K]) => void,
  ): PactInstance;
  shutdown(): Promise<void>;
}

function requireProgramId(net: ResolvedNetwork): PublicKey {
  if (!net.programId) {
    throw new PactError(
      PactErrorCode.CONFIG_INVALID,
      `On-chain ops need a program ID, but none is configured for ` +
        `"${net.network}" (only mainnet ships a canonical default; localnet ` +
        `is sed-replaced per-env; devnet has no default because its deploy's ` +
        `declare_id! mismatches its address so settle_batch reverts — see ` +
        `network.ts). Pass createPact({ programId: "<program id>" }). ` +
        `Covered proxy calls do NOT require this.`,
    );
  }
  return new PublicKey(net.programId);
}

const USDC_PER_LAMPORT = 1_000_000;

export async function createPact(config: PactConfig): Promise<PactInstance> {
  const cfg = validateConfig(config);
  const net = resolveNetwork(cfg.network, {
    programId: cfg.programId,
    usdcMint: cfg.usdcMint,
    proxyBaseUrl: cfg.proxyBaseUrl,
    indexerBaseUrl: cfg.indexerBaseUrl,
    rpcUrl: cfg.rpcUrl,
  });

  const agentPubkey = signerAddress(cfg.signer);
  const sign = resolveSignFn(cfg.signer, cfg.requestSigningSecretKey);
  const vm = signerVm(cfg.signer);
  const usdcMint = new PublicKey(net.usdcMint);

  const resolver = new SlugResolver({
    proxyBaseUrl: net.proxyBaseUrl,
    fetchImpl: cfg.fetchImpl,
  });
  const buffer = await selectStorage({
    storage: cfg.storage,
    storagePath: cfg.storagePath,
    memoryPersistKey: `pact:obs:${agentPubkey}`,
  });
  const emitter = new PactEventEmitter();

  let connection: Connection | null = null;
  const conn = (): Connection => {
    connection ??= new Connection(net.rpcUrl, "confirmed");
    return connection;
  };
  const onChainCtx = (): OnChainContext => {
    if (isEvmSigner(cfg.signer)) {
      throw new PactError(
        PactErrorCode.CONFIG_INVALID,
        "On-chain ops (setup/topUp/revoke) require a Solana signer; got an " +
          "EVM signer. EVM agents only need on-chain registration on their " +
          "own chain — not via this SDK.",
      );
    }
    return {
      connection: conn(),
      signer: cfg.signer as SolanaPactSigner,
      programId: requireProgramId(net),
      usdcMint,
    };
  };

  // The ONE reconciliation critical section. Both the poller and the webhook
  // receiver route through this. Idempotent by construction: it re-reads
  // `buffer.loadPending()` (fresh, not a stale snapshot) so a call already
  // reconciled by the other path emits AT MOST ONCE; `markReconciled` is
  // itself idempotent. JS is single-threaded so this runs to completion
  // without interleave. (Multi-instance caveat documented on `config.webhook`.)
  function recordSettled(n: SettledNotification): void {
    if (!buffer.loadPending().some((p) => p.callId === n.callId)) return;
    if (n.premiumLamports > 0n) {
      emitter.emit("billed", {
        callId: n.callId,
        slug: n.slug,
        premiumLamports: n.premiumLamports,
        settledAt: n.settledAt,
        txSignature: n.txSignature,
      });
    }
    if (n.breach && n.refundLamports > 0n) {
      emitter.emit("refund", {
        callId: n.callId,
        slug: n.slug,
        refundLamports: n.refundLamports,
        settledAt: n.settledAt,
        txSignature: n.txSignature,
      });
    }
    buffer.markReconciled(n.callId);
  }

  const poller = new IndexerPoller({
    indexerBaseUrl: net.indexerBaseUrl,
    agentPubkey,
    buffer,
    intervalMs: cfg.indexerPollIntervalMs,
    fetchImpl: cfg.fetchImpl,
    onSettled: recordSettled,
    onError: () => {
      /* best-effort (B2): refunds still settle on-chain regardless */
    },
  });

  let webhookServer: { close: () => Promise<void> } | null = null;
  let webhookHandler:
    | ((req: WebhookHandlerRequest) => Promise<WebhookHandlerResponse>)
    | undefined;
  if (cfg.webhook) {
    webhookHandler = createWebhookHandler({
      config: cfg.webhook,
      reconcile: recordSettled,
    });
    if (cfg.webhook.port != null) {
      webhookServer = await startWebhookServer({
        config: cfg.webhook,
        reconcile: recordSettled,
      });
    }
  }

  let autoTopUp: AutoTopUpWatcher | undefined;
  if (cfg.autoTopUp) {
    const ctx = onChainCtx(); // throws early (B1) if program ID is unset
    autoTopUp = startAutoTopUpWatcher({
      ctx,
      thresholdLamports: cfg.autoTopUp.thresholdLamports,
      refillLamports: BigInt(
        Math.floor(cfg.autoTopUp.refillUsdc * USDC_PER_LAMPORT),
      ),
      intervalMs: cfg.indexerPollIntervalMs,
      onLowBalance: (s) =>
        emitter.emit("low-balance", {
          allowanceLamports: s.allowance,
          ataBalanceLamports: s.ataBalance,
          thresholdLamports: cfg.autoTopUp!.thresholdLamports,
        }),
      onError: () => {},
    });
  }

  const lifecycle = new LifecycleManager({
    poller,
    autoTopUp,
    installSignalHandlers: cfg.installSignalHandlers,
    onShutdown: () => webhookServer?.close(),
  });
  lifecycle.install();
  poller.start();
  void poller.flush(); // resume any pending observations from a prior run

  const goldenDeps: GoldenFetchDeps = {
    resolver,
    proxyBaseUrl: net.proxyBaseUrl,
    project: cfg.project,
    network: cfg.endpointNetwork,
    signRequests: cfg.signRequests,
    agentPubkey,
    vm,
    sign,
    fetchImpl: cfg.fetchImpl,
  };

  async function indexerJson<T>(path: string): Promise<T> {
    let resp: Response;
    try {
      resp = await cfg.fetchImpl(`${net.indexerBaseUrl}${path}`);
    } catch (err) {
      throw new PactError(
        PactErrorCode.INDEXER_UNREACHABLE,
        `indexer request failed: ${(err as Error).message}`,
        { cause: err, retryable: true },
      );
    }
    if (!resp.ok) {
      throw new PactError(
        PactErrorCode.INDEXER_UNREACHABLE,
        `indexer returned ${resp.status}`,
        { retryable: true },
      );
    }
    return (await resp.json()) as T;
  }

  const instance: PactInstance = {
    async fetch(url, init, opts) {
      const res = await goldenFetch(goldenDeps, url, init, opts?.hostnameOverride);
      const ts = new Date().toISOString();
      if (res.degraded) {
        emitter.emit("degraded", {
          reason: res.degradedReason ?? "degraded",
          url,
          ts,
        });
        return res.response;
      }
      const p = res.pactHeaders;
      const outcome = p?.outcome ?? null;
      const breach = outcome != null && outcome !== "ok";
      if (res.callId) {
        buffer.append({
          callId: res.callId,
          agentPubkey,
          slug: res.slug ?? p?.pool ?? "",
          host: res.host ?? "",
          ts,
          premiumLamports: p?.premiumLamports?.toString() ?? null,
          refundLamports: p?.refundLamports?.toString() ?? null,
          outcome,
          breach,
          reconciled: false,
        });
      }
      if (breach) {
        emitter.emit("failure", {
          callId: res.callId,
          slug: res.slug ?? "",
          url,
          outcome: outcome as string,
          premiumLamports: p?.premiumLamports ?? null,
          refundLamports: p?.refundLamports ?? null,
          ts,
        });
      }
      return res.response;
    },

    async setup(o) {
      const usdc = o?.allowanceUsdc ?? cfg.defaultAllowanceUsdc;
      const lamports = BigInt(Math.floor(usdc * USDC_PER_LAMPORT));
      const r = await ensureAtaAndApprove(onChainCtx(), lamports);
      return { txSignature: r.txSignature };
    },

    async topUp(allowanceUsdc) {
      const lamports = BigInt(Math.floor(allowanceUsdc * USDC_PER_LAMPORT));
      const r = await onChainTopUp(onChainCtx(), lamports);
      return { txSignature: r.txSignature };
    },

    async revoke() {
      return { txSignature: await onChainRevoke(onChainCtx()) };
    },

    async policy() {
      const programId = requireProgramId(net);
      const st = await readInsurableState({
        connection: conn(),
        agentPubkey: new PublicKey(agentPubkey),
        programId,
        usdcMint,
      });
      let agg = {
        totalPremiumsLamports: "0",
        totalRefundsLamports: "0",
        callCount: "0",
        lastCallAt: null as string | null,
      };
      try {
        agg = await indexerJson(
          `/api/agents/${encodeURIComponent(agentPubkey)}`,
        );
      } catch {
        // best-effort (B2): on-chain state is authoritative for eligibility
      }
      return {
        agentPubkey,
        ataPubkey: st.ata.toBase58(),
        ataBalanceLamports: st.ataBalance,
        allowanceLamports: st.allowance,
        eligible: st.eligible,
        reason: st.reason,
        totalPremiumsLamports: safeBig(agg.totalPremiumsLamports),
        totalRefundsLamports: safeBig(agg.totalRefundsLamports),
        callCount: safeBig(agg.callCount),
        lastCallAt: agg.lastCallAt ? new Date(agg.lastCallAt) : null,
      };
    },

    async claims(o) {
      const limit = o?.limit ?? 50;
      const rows = await indexerJson<
        Array<{
          callId: string;
          endpointSlug: string;
          refundLamports: string;
          breach: boolean;
          settledAt: string;
          signature: string;
          ts: string;
        }>
      >(`/api/agents/${encodeURIComponent(agentPubkey)}/calls?limit=${limit}`);
      const since = o?.since;
      return rows
        .filter(
          (r) =>
            r.breach &&
            safeBig(r.refundLamports) > 0n &&
            (since == null || new Date(r.ts).getTime() >= since),
        )
        .map((r) => ({
          callId: r.callId,
          slug: r.endpointSlug,
          refundLamports: safeBig(r.refundLamports),
          settledAt: new Date(r.settledAt),
          txSignature: r.signature,
        }));
    },

    async estimate(hostnameOrUrl) {
      const host = canonicalHostname(hostnameOrUrl);
      const resolution = await resolver.resolve(host);
      if (!resolution.ok) {
        throw new PactError(
          resolution.reason === "paused"
            ? PactErrorCode.ENDPOINT_PAUSED
            : PactErrorCode.ENDPOINT_NOT_REGISTERED,
          `estimate: ${host} is ${resolution.reason}`,
        );
      }
      const programId = requireProgramId(net);
      const [pda] = getEndpointConfigPda(
        programId,
        slugBytes(resolution.entry.slug),
      );
      const acct = await conn().getAccountInfo(pda);
      if (!acct) {
        throw new PactError(
          PactErrorCode.ENDPOINT_NOT_REGISTERED,
          `estimate: no on-chain EndpointConfig for slug "${resolution.entry.slug}"`,
        );
      }
      const ec = decodeEndpointConfig(acct.data);
      return {
        slug: resolution.entry.slug,
        flatPremiumLamports: ec.flatPremiumLamports,
        percentBps: ec.percentBps,
        slaLatencyMs: ec.slaLatencyMs,
        imputedCostLamports: ec.imputedCostLamports,
        paused: ec.paused,
      };
    },

    stats() {
      return buffer.stats();
    },

    wrap(client) {
      return wrapClient(client, (url, init) => instance.fetch(url, init));
    },

    webhookHandler,

    on(event, listener) {
      emitter.on(event, listener);
      return instance;
    },

    shutdown() {
      return lifecycle.shutdown();
    },
  };

  return instance;
}

function safeBig(s: string | null | undefined): bigint {
  if (!s) return 0n;
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
}
