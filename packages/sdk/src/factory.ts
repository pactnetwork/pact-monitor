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
} from "@pact-network/protocol-v1-client";
import { validateConfig, type PactConfig } from "./config.js";
import { resolveNetwork, type ResolvedNetwork } from "./network.js";
import { resolveSecretKey, signerPublicKey } from "./signer.js";
import { canonicalHostname } from "./hostname.js";
import { SlugResolver } from "./slug-resolver.js";
import { ObservationBuffer } from "./observation-buffer.js";
import { IndexerPoller } from "./indexer-poller.js";
import { PactEventEmitter, type PactEventMap, type PactEventName } from "./events.js";
import { LifecycleManager } from "./lifecycle.js";
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
  /** Route an existing ky / axios / fetch client through pact.fetch. */
  wrap<T>(client: T): T;
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
      `On-chain ops need a program ID, but it is unconfirmed for "${net.network}" ` +
        `(plan blocker B1: every prior devnet deploy is marked ORPHAN). ` +
        `Pass createPact({ programId: "<confirmed devnet/localnet program id>" }). ` +
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

  const agentPubkey = signerPublicKey(cfg.signer);
  const secretKey = resolveSecretKey(cfg.signer, cfg.requestSigningSecretKey);
  const usdcMint = new PublicKey(net.usdcMint);

  const resolver = new SlugResolver({
    proxyBaseUrl: net.proxyBaseUrl,
    fetchImpl: cfg.fetchImpl,
  });
  const buffer = new ObservationBuffer(cfg.storagePath);
  const emitter = new PactEventEmitter();

  let connection: Connection | null = null;
  const conn = (): Connection => {
    connection ??= new Connection(net.rpcUrl, "confirmed");
    return connection;
  };
  const onChainCtx = (): OnChainContext => ({
    connection: conn(),
    signer: cfg.signer,
    programId: requireProgramId(net),
    usdcMint,
  });

  const poller = new IndexerPoller({
    indexerBaseUrl: net.indexerBaseUrl,
    agentPubkey,
    buffer,
    intervalMs: cfg.indexerPollIntervalMs,
    fetchImpl: cfg.fetchImpl,
    onRefund: (e) => emitter.emit("refund", e),
    onBilled: (e) => emitter.emit("billed", e),
    onError: () => {
      /* best-effort (B2): refunds still settle on-chain regardless */
    },
  });

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
  });
  lifecycle.install();
  poller.start();
  void poller.flush(); // resume any pending observations from a prior run

  const goldenDeps: GoldenFetchDeps = {
    resolver,
    proxyBaseUrl: net.proxyBaseUrl,
    project: cfg.project,
    signRequests: cfg.signRequests,
    agentPubkey,
    secretKey,
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
