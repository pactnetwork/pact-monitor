/**
 * Merchant SDK configuration types + validation.
 *
 * Mirrors the agent SDK config style: required fields throw at
 * `createPactMerchant()` boundary, optional fields fall back to per-network
 * defaults resolved in `factory.ts`.
 */
import type { Network } from "../network.js";
import type { PactSigner } from "../signer.js";
import { PactError, PactErrorCode } from "../errors.js";

export interface MerchantConfig {
  network: Network;
  /** Ed25519 signer whose pubkey is bound to the merchant's api_keys row. */
  signer: PactSigner;
  /** Backend bearer key issued with role='merchant'. */
  apiKey: string;
  /** Canonical hostname this merchant serves (used for endpoint resolution). */
  hostname: string;
  /**
   * Integration mode label. `"direct"` = merchant runs `merchant.middleware()`
   * on its own host. `"market"` = merchant registers an endpoint with the
   * Pact Market proxy and lets the proxy attribute calls. Default `"direct"`.
   *
   * INFORMATIONAL in this release — both modes accept all `MerchantInstance`
   * methods (`middleware`, `fastify`, `hono`, `register`, etc.) regardless of
   * the value. A future version may enforce semantics (direct mode disables
   * `register()`, market mode disables middleware methods). PR #223 review
   * Section F flagged this; documenting the intent here so consumers can
   * still set the field meaningfully today.
   */
  mode?: "direct" | "market";
  /** Override the resolved backend URL (per-network default otherwise). */
  backendUrl?: string;
  /** Optional payout ATA for revshare. Default: signer's ATA. Unused in Commit 1. */
  payoutAccount?: string;
  /** Install beforeExit/SIGTERM/SIGINT flush hooks. Default true. */
  installSignalHandlers?: boolean;
}

export interface ResolvedMerchantConfig extends MerchantConfig {
  mode: "direct" | "market";
  installSignalHandlers: boolean;
}

export function validateMerchantConfig(
  config: MerchantConfig,
): ResolvedMerchantConfig {
  if (!config) {
    throw new PactError(
      PactErrorCode.CONFIG_INVALID,
      "createPactMerchant: config object is required",
    );
  }
  if (!config.network) {
    throw new PactError(
      PactErrorCode.CONFIG_INVALID,
      "createPactMerchant: 'network' is required",
    );
  }
  if (!config.signer) {
    throw new PactError(
      PactErrorCode.SIGNER_MISSING,
      "createPactMerchant: 'signer' is required",
    );
  }
  if (!config.apiKey || typeof config.apiKey !== "string") {
    throw new PactError(
      PactErrorCode.CONFIG_INVALID,
      "createPactMerchant: 'apiKey' (merchant bearer key) is required",
    );
  }
  if (!config.hostname || typeof config.hostname !== "string") {
    throw new PactError(
      PactErrorCode.CONFIG_INVALID,
      "createPactMerchant: 'hostname' is required",
    );
  }
  return {
    ...config,
    mode: config.mode ?? "direct",
    installSignalHandlers: config.installSignalHandlers ?? true,
  };
}
