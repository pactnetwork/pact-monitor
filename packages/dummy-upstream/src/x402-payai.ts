// PayAI-backed x402 handler for the dummy upstream.
//
// When `DUMMY_X402_USE_PAYAI=1` is set, the `?x402=1` toggle on
// `/quote/:symbol` is wired through PayAI's hosted facilitator
// (https://facilitator.payai.network) instead of the legacy emulation.
//
// Concretely: pay-cli's signed `PAYMENT-SIGNATURE` envelope is verified
// against the facilitator, then on success the same envelope is settled
// on-chain — moving real USDC from the agent's wallet to the configured
// treasury address (`DUMMY_X402_PAY_TO`, default = pay-default coverage
// pool vault `J55fpAi…`).
//
// This is "Option B" of the dummy refund-flow design:
//   - On `?x402=1` (no further toggle): MODE A — verify → return 200 →
//     settle. Agent pays into pool; no breach; no refund. Premium gets
//     charged by Pact, net cost to agent = premium only.
//   - On `?x402=1&fail=1`: MODE C — verify → SETTLE FIRST → return 503.
//     Agent is debited the full amount, gets nothing. Pact's classifier
//     sees server_error and issues a refund from the same pool vault
//     (since `treasuryAddress` IS the pool vault). Net cost to agent =
//     premium only; the 0.005 USDC round-trips through the pool.
//
// Why settle BEFORE the 503 on `?fail=1`: this is the genuine "agent
// paid, got nothing" scenario Pact's coverage protects against. Settling
// AFTER the failure (MODE B) would be a no-op for Pact (no payment leg,
// no refund). Pre-settling reproduces the real-world pattern of an
// eagerly-settling merchant who then crashes — the worst-of-both case
// for the agent, and the case Pact actually insures.
//
// Treasury / pool vault note: `DUMMY_X402_PAY_TO` should be set to the
// pay-default coverage pool's on-chain USDC vault. On mainnet that's
// `J55fpAivCj6LTy4DEK6WaeoTxhB2hCrLRWtkoS774Gon`. It is NOT a standard
// derived ATA — it's a freshly-generated keypair bound to the
// CoveragePool PDA via `InitializeAccount3` at endpoint-registration
// time. Read it off-chain from `CoveragePool.usdcVault`. See
// `packages/dummy-upstream/scripts/dummy-coverage-pool.ts` for the
// reference derivation.

import { X402PaymentHandler } from "x402-solana/server";
import type {
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "x402-solana/server";

// SPL Token mints we'll accept. Same set the existing emulation uses;
// kept here so the handler is self-contained and one swap of the env
// `DUMMY_X402_PAYAI_NETWORK` (solana | solana-devnet) gets you the right
// chain config. The mainnet pool vault we settle into only holds
// mainnet USDC; setting devnet here is for local-dev sanity checks
// only — point `DUMMY_X402_PAY_TO` at a devnet vault if you flip.
const USDC_MINT_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_MINT_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

/** Same atomic amount the legacy emulation announces — 0.005 USDC. */
export const PAYAI_DEMO_AMOUNT_ATOMIC = "5000";

export interface PayAIConfig {
  /** "solana" (mainnet) | "solana-devnet". Defaults to mainnet. */
  network: "solana" | "solana-devnet";
  /** Where settled USDC lands. For Option B this is the pool USDC vault. */
  treasuryAddress: string;
  /** PayAI facilitator URL. Defaults to the hosted endpoint. */
  facilitatorUrl: string;
  /** Solana RPC. Defaults to mainnet/devnet public endpoint. */
  rpcUrl: string;
  /** Optional PayAI auth — bypasses free-tier rate limits. */
  apiKeyId?: string;
  apiKeySecret?: string;
}

/** Resolve config from env vars. Returns null if PayAI is not enabled. */
export function payAIConfigFromEnv(): PayAIConfig | null {
  if (process.env.DUMMY_X402_USE_PAYAI !== "1") return null;
  const network =
    process.env.DUMMY_X402_PAYAI_NETWORK === "solana-devnet"
      ? "solana-devnet"
      : "solana";
  const treasuryAddress =
    process.env.DUMMY_X402_PAY_TO ??
    // Default to the mainnet pay-default coverage pool vault. This is the
    // address where Option B routes ALL funds — every successful settle
    // here is a credit to the same pool Pact debits refunds from. The
    // result is a self-balancing demo: payment → pool, refund-on-breach
    // ← pool, modulo Pact's premium.
    "J55fpAivCj6LTy4DEK6WaeoTxhB2hCrLRWtkoS774Gon";
  const facilitatorUrl =
    process.env.DUMMY_X402_FACILITATOR_URL ?? "https://facilitator.payai.network";
  const rpcUrl =
    process.env.DUMMY_X402_RPC_URL ??
    (network === "solana"
      ? "https://api.mainnet-beta.solana.com"
      : "https://api.devnet.solana.com");
  return {
    network,
    treasuryAddress,
    facilitatorUrl,
    rpcUrl,
    apiKeyId: process.env.PAYAI_API_KEY_ID,
    apiKeySecret: process.env.PAYAI_API_KEY_SECRET,
  };
}

/** Build the SDK handler once per process. */
export function makeX402Handler(config: PayAIConfig): X402PaymentHandler {
  return new X402PaymentHandler({
    network: config.network,
    treasuryAddress: config.treasuryAddress,
    facilitatorUrl: config.facilitatorUrl,
    rpcUrl: config.rpcUrl,
    apiKeyId: config.apiKeyId,
    apiKeySecret: config.apiKeySecret,
  });
}

/** USDC asset descriptor for the configured network. */
export function usdcAsset(network: "solana" | "solana-devnet"): {
  address: string;
  decimals: 6;
} {
  return {
    address: network === "solana" ? USDC_MINT_MAINNET : USDC_MINT_DEVNET,
    decimals: 6,
  };
}

/**
 * Build per-call payment requirements. The amount and description are
 * fixed for this demo target — pay-cli reads `accepts[0]` to know how
 * much to pre-sign, so consistency across requests matters.
 */
export async function buildRequirements(
  handler: X402PaymentHandler,
  network: "solana" | "solana-devnet",
  resourceUrl: string,
): Promise<PaymentRequirements> {
  return handler.createPaymentRequirements(
    {
      amount: PAYAI_DEMO_AMOUNT_ATOMIC,
      asset: usdcAsset(network),
      description:
        "pact-dummy-upstream — Option B demo (funds settle into pay-default coverage pool vault; refund-on-breach repays from the same vault)",
      mimeType: "application/json",
    },
    resourceUrl,
  );
}

/** Re-export the SDK types our callers need. */
export type { PaymentRequirements, SettleResponse, VerifyResponse, X402PaymentHandler };
