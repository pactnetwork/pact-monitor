/**
 * `PactConfig` — the `createPact()` input, V1-mapped from the design draft
 * §11. V2/oracle-only fields are intentionally dropped:
 *  - `autoProvision`            (V1 pools are operator-registered)
 *  - `insureDefault` semantics  (V1 premium/refund are endpoint-fixed by the
 *                                on-chain EndpointConfig; declared value is
 *                                informational only)
 *  - `priorityFeeStrategy`      (no agent-submitted settlement tx in V1)
 *  - Policy/oracle/claim fields (no Policy PDA, no agent claim submit)
 *
 * `apiKey` is accepted but RESERVED: the Pact Market proxy authenticates via
 * the ed25519 request signature, not a bearer key (verify-signature.ts has no
 * API-key check). It is kept so a future proxy gate is a no-op for callers.
 */
import bs58 from "bs58";

import { PactError, PactErrorCode } from "./errors.js";
import type { Network } from "./network.js";
import type { PactSigner } from "./signer.js";
import type { PactStorage } from "./storage.js";
import type { WebhookConfig } from "./webhook.js";

export interface AutoTopUpConfig {
  /** Re-approve when delegated allowance drops below this (USDC base units). */
  thresholdLamports: bigint;
  /** Allowance to restore to, in whole USDC. */
  refillUsdc: number;
}

export interface PactConfig {
  /** "mainnet" | "devnet" | "localnet". Selects defaults; see network.ts. */
  network: Network;
  /** Keypair (server agents) or wallet-adapter-shaped object. */
  signer: PactSigner;

  /** Reserved; unused by the V1 proxy. See note above. */
  apiKey?: string;
  /** Sign covered proxy requests (ed25519). Default true. */
  signRequests?: boolean;
  /**
   * Raw 64-byte ed25519 secret for request signing when `signer` is a wallet
   * adapter that cannot expose it. Ignored for `Keypair` signers.
   */
  requestSigningSecretKey?: Uint8Array;

  /** Override the program ID (required for devnet/localnet on-chain ops; B1). */
  programId?: string;
  /** Override the USDC mint. */
  usdcMint?: string;
  /** Override the Solana RPC URL. */
  rpcUrl?: string;
  /** Override the Pact Market proxy base URL. */
  proxyBaseUrl?: string;
  /** Override the indexer base URL (best-effort; B2). */
  indexerBaseUrl?: string;

  /** SPL approve allowance set by setup(), whole USDC. Default 1. */
  defaultAllowanceUsdc?: number;
  /** Auto re-approve when allowance is low. Off by default. */
  autoTopUp?: AutoTopUpConfig;

  /** Sent as the `x-pact-project` header (proxy requires it). Default "default". */
  project?: string;

  /**
   * Local durable observation buffer path (Node). Default
   * ~/.pact/sdk-observations.jsonl. Ignored when `storage` is given or in a
   * browser (no node:fs) where an in-memory store is used instead.
   */
  storagePath?: string;
  /**
   * Explicit storage backend (full override). Supply this for a custom or
   * browser store; otherwise the SDK picks FsObservationBuffer (Node) or an
   * in-memory store (browser/serverless) automatically.
   */
  storage?: PactStorage;
  /** Indexer reconciliation poll interval (ms). Default 15000. */
  indexerPollIntervalMs?: number;
  /** Install beforeExit/SIGTERM/SIGINT flush hooks. Default true. */
  installSignalHandlers?: boolean;
  /** Latency (ms) above which a 2xx is treated as a local failure hint. Default 5000. */
  latencyThresholdMs?: number;

  /**
   * Opt-in webhook receiver (latency optimization over the poller). The
   * poller stays the durable source of truth; both feed ONE idempotent sink.
   * Multi-instance caveat: a webhook is only deduped against the buffer of
   * the process that owns it — in a multi-replica/serverless deployment where
   * the webhook lands on a different process than the poller, run poller-only
   * (omit `webhook`) or give each replica its own durable storage.
   */
  webhook?: WebhookConfig;

  /** Injected for tests. */
  fetchImpl?: typeof fetch;
}

export interface ResolvedConfig {
  network: Network;
  signer: PactSigner;
  apiKey?: string;
  signRequests: boolean;
  requestSigningSecretKey?: Uint8Array;
  programId?: string;
  usdcMint?: string;
  rpcUrl?: string;
  proxyBaseUrl?: string;
  indexerBaseUrl?: string;
  defaultAllowanceUsdc: number;
  autoTopUp?: AutoTopUpConfig;
  project: string;
  /** undefined in a browser (no node:fs) — selectStorage uses memory then. */
  storagePath?: string;
  storage?: PactStorage;
  indexerPollIntervalMs: number;
  installSignalHandlers: boolean;
  latencyThresholdMs: number;
  webhook?: WebhookConfig;
  fetchImpl: typeof fetch;
}

const VALID_NETWORKS = new Set<Network>(["mainnet", "devnet", "localnet"]);

function defaultStoragePath(): string | undefined {
  // Node-only: a browser has no node:fs, so leave it undefined and let
  // selectStorage() fall back to an in-memory store.
  const proc = (
    globalThis as {
      process?: {
        versions?: { node?: string };
        env?: Record<string, string | undefined>;
        cwd?: () => string;
      };
    }
  ).process;
  if (!proc?.versions?.node) return undefined;
  const home =
    proc.env?.HOME ?? proc.env?.USERPROFILE ?? proc.cwd?.() ?? ".";
  return `${home}/.pact/sdk-observations.jsonl`;
}

/**
 * Validate and normalize. Throws `PactError(CONFIG_INVALID)` synchronously
 * before any network/chain call (golden rule does not apply to construction).
 */
export function validateConfig(config: PactConfig): ResolvedConfig {
  if (!config || typeof config !== "object") {
    throw new PactError(
      PactErrorCode.CONFIG_INVALID,
      "createPact: config object is required",
    );
  }
  if (!VALID_NETWORKS.has(config.network)) {
    throw new PactError(
      PactErrorCode.CONFIG_INVALID,
      `createPact: network must be one of mainnet|devnet|localnet (got ${String(config.network)})`,
    );
  }
  const signer = config.signer;
  if (
    !signer ||
    typeof signer.publicKey?.toBase58 !== "function"
  ) {
    throw new PactError(
      PactErrorCode.SIGNER_MISSING,
      "createPact: a signer with a publicKey is required",
    );
  }

  // A malformed request-signing secret must fail HERE (construction), not
  // later inside goldenFetch where throwing would violate the golden rule.
  const rsk = config.requestSigningSecretKey;
  if (rsk !== undefined) {
    if (!(rsk instanceof Uint8Array) || rsk.length !== 64) {
      throw new PactError(
        PactErrorCode.CONFIG_INVALID,
        `createPact: requestSigningSecretKey must be a 64-byte ed25519 ` +
          `secret key (got ${
            rsk instanceof Uint8Array ? `${rsk.length} bytes` : typeof rsk
          })`,
      );
    }
    // ed25519 secret = seed(32) || pubkey(32). The trailing 32 bytes must
    // match the signer's public key, else every covered call would 401.
    const derived = bs58.encode(rsk.slice(32));
    const declared = signer.publicKey.toBase58();
    if (derived !== declared) {
      throw new PactError(
        PactErrorCode.CONFIG_INVALID,
        `createPact: requestSigningSecretKey public key (${derived}) does ` +
          `not match signer.publicKey (${declared})`,
      );
    }
  }

  const defaultAllowanceUsdc = config.defaultAllowanceUsdc ?? 1;
  if (
    typeof defaultAllowanceUsdc !== "number" ||
    !Number.isFinite(defaultAllowanceUsdc) ||
    defaultAllowanceUsdc < 0
  ) {
    throw new PactError(
      PactErrorCode.CONFIG_INVALID,
      `createPact: defaultAllowanceUsdc must be a non-negative number (got ${String(defaultAllowanceUsdc)})`,
    );
  }

  if (
    config.webhook !== undefined &&
    (typeof config.webhook.indexerSigningKey !== "string" ||
      config.webhook.indexerSigningKey.length === 0)
  ) {
    throw new PactError(
      PactErrorCode.CONFIG_INVALID,
      "createPact: webhook.indexerSigningKey (bs58 ed25519 pubkey) is " +
        "required when `webhook` is set",
    );
  }

  const indexerPollIntervalMs = config.indexerPollIntervalMs ?? 15_000;
  if (
    typeof indexerPollIntervalMs !== "number" ||
    indexerPollIntervalMs < 1_000
  ) {
    throw new PactError(
      PactErrorCode.CONFIG_INVALID,
      `createPact: indexerPollIntervalMs must be >= 1000 (got ${String(indexerPollIntervalMs)})`,
    );
  }

  return {
    network: config.network,
    signer,
    apiKey: config.apiKey,
    signRequests: config.signRequests ?? true,
    requestSigningSecretKey: config.requestSigningSecretKey,
    programId: config.programId,
    usdcMint: config.usdcMint,
    rpcUrl: config.rpcUrl,
    proxyBaseUrl: config.proxyBaseUrl,
    indexerBaseUrl: config.indexerBaseUrl,
    defaultAllowanceUsdc,
    autoTopUp: config.autoTopUp,
    project: config.project ?? "default",
    storagePath: config.storagePath ?? defaultStoragePath(),
    storage: config.storage,
    indexerPollIntervalMs,
    installSignalHandlers: config.installSignalHandlers ?? true,
    latencyThresholdMs: config.latencyThresholdMs ?? 5_000,
    webhook: config.webhook,
    fetchImpl: config.fetchImpl ?? globalThis.fetch,
  };
}
