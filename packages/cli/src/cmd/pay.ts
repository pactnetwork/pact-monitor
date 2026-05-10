// pact pay <tool> [args...]
//
// Wrapper subcommand modeled on solana-foundation/pay's calling convention.
// On a 402 from the wrapped tool, parse the x402 or MPP challenge, sign a
// retry header using the project wallet, and re-invoke the tool. The wrapped
// tool's stdout/stderr/exit-code pass through cleanly so existing pipelines
// (curl … | jq, while curl …; do …) keep working.
//
// v0.1.0 supports `curl` only. Other tools (wget, http (HTTPie), claude,
// codex) are explicit non-MVP — they return a structured client_error so
// callers can detect the gap programmatically.

import { loadOrCreateWallet } from "../lib/wallet.ts";
import {
  runCurl,
  type RunOutcome,
  type SpawnFn,
} from "../lib/pay-runner.ts";
import {
  buildX402PaymentHeader,
  buildMppCredentialHeader,
} from "../lib/pay-auth.ts";
import { selectSolanaRequirements, type X402Challenge } from "../lib/x402.ts";
import { isSessionChallenge, type MppChallenge } from "../lib/mpp.ts";
import { makeEnvelope, type Envelope } from "../lib/envelope.ts";
import { resolveClusterConfig } from "../lib/solana.ts";

// Defense in depth: re-check the PACT_MAINNET_ENABLED gate at every entry that
// could sign or retry a payment. balance/approve/run already gate via
// resolveClusterConfig at point-of-use; pay also wraps an external tool, so
// the gate has to live both at command entry AND in each retry handler so a
// future refactor can't accidentally re-introduce a bypass.
function gateEnvelope(): { kind: "envelope"; envelope: Envelope } | null {
  const cfg = resolveClusterConfig();
  if ("error" in cfg) {
    return {
      kind: "envelope",
      envelope: makeEnvelope("client_error", { error: cfg.error }),
    };
  }
  return null;
}

const SUPPORTED_TOOLS = ["curl"] as const;

export interface PayCommandInput {
  tool: string;
  args: string[];
  configDir: string;
  // Optional: hint for selecting which `accepts[]` entry to use when the
  // server offers multiple Solana networks. The CLI's existing --cluster
  // flag flows through here.
  preferredNetwork?: string;
  spawn?: SpawnFn;
}

/**
 * Payment metadata attached to a passthrough result. When `kind` is `"none"`
 * the wrapped tool completed without ever hitting a 402 (e.g. cached upstream,
 * non-paid endpoint). When `kind` is `"x402"` or `"mpp"` we successfully signed
 * a retry header and the upstream returned a 2xx; index.ts uses this to
 * surface an `x402_payment_made` / `mpp_payment_made` envelope on --json.
 */
export type PaymentInfo =
  | { kind: "none" }
  | {
      kind: "x402";
      resource: string;
      recipient: string;
      amount: string;
      asset: string;
      network: string;
    }
  | {
      kind: "mpp";
      resource: string;
      recipient: string;
      amount: string;
      asset: string;
      network: string;
    };

export type PayCommandResult =
  | {
      kind: "passthrough";
      exitCode: number;
      stdout: Uint8Array;
      stderr: Uint8Array;
      bodyBytes: Uint8Array;
      payment: PaymentInfo;
    }
  | {
      kind: "envelope";
      envelope: Envelope;
    };

function clusterToX402Network(preferred?: string): string | undefined {
  if (!preferred) return undefined;
  if (preferred === "mainnet" || preferred === "mainnet-beta") return "solana";
  if (preferred === "devnet") return "solana-devnet";
  if (preferred === "testnet") return "solana-testnet";
  return preferred;
}

async function runWrappedTool(
  tool: string,
  args: string[],
  spawn?: SpawnFn,
  extraHeaders?: string[],
): Promise<RunOutcome> {
  // Single dispatch point; gives us a clean place to add wget/httpie wrappers
  // later without sprawl.
  if (tool === "curl") {
    return runCurl({ args, extraHeaders, spawn });
  }
  throw new Error(`unsupported tool: ${tool}`);
}

function selectMppChallenge(challenges: MppChallenge[]): MppChallenge | null {
  // v0.1.0: skip session challenges (Fiber channel state) — pick the first
  // one-shot charge offered. pay.sh's CLI currently does the same when
  // running without --auto-pay against multiple alternatives.
  return challenges.find((c) => !isSessionChallenge(c)) ?? null;
}

export async function payCommand(
  input: PayCommandInput,
): Promise<PayCommandResult> {
  // Validate the wrapped tool BEFORE the mainnet gate. Unsupported tools
  // (e.g. `pact pay wget …`) never reach a signing path, so they don't
  // need the gate's defense-in-depth speed-bump — but they DO need to
  // exit non-zero so shell chains like `pact pay wgett … && next-step`
  // stop on a typo regardless of whether PACT_MAINNET_ENABLED is set.
  // Gating before this check meant the unsupported_tool exit code (50)
  // only fired when mainnet was already enabled (codex review on PR #131).
  if (!SUPPORTED_TOOLS.includes(input.tool as (typeof SUPPORTED_TOOLS)[number])) {
    return {
      kind: "envelope",
      envelope: makeEnvelope("unsupported_tool", {
        error: "unsupported_tool",
        tool: input.tool,
        supported: SUPPORTED_TOOLS,
        suggest:
          "v0.1.0 only wraps `curl`; other tools (wget, http, claude, codex) are coming",
      }),
    };
  }

  const gate = gateEnvelope();
  if (gate) return gate;

  const first = await runWrappedTool(input.tool, input.args, input.spawn);

  switch (first.kind) {
    case "tool_missing":
      return {
        kind: "envelope",
        envelope: makeEnvelope("tool_missing", {
          error: "tool_missing",
          tool: first.tool,
          suggest: `install ${first.tool} (e.g. \`brew install ${first.tool}\`)`,
        }),
      };

    case "completed":
      return {
        kind: "passthrough",
        exitCode: first.exitCode,
        stdout: first.stdout,
        stderr: first.stderr,
        bodyBytes: first.bodyBytes,
        payment: { kind: "none" },
      };

    case "rejected":
      return {
        kind: "envelope",
        envelope: makeEnvelope("client_error", {
          error: "payment_rejected",
          reason: first.reason,
          resource: first.resourceUrl,
        }),
      };

    case "unknown_402":
      return {
        kind: "envelope",
        envelope: makeEnvelope("client_error", {
          error: "unknown_402",
          resource: first.resourceUrl,
          suggest: "no recognized x402 / MPP challenge in the response",
        }),
      };

    case "x402":
      return await handleX402Retry(first, input);

    case "mpp":
      return await handleMppRetry(first, input);
  }
}

async function handleX402Retry(
  first: Extract<RunOutcome, { kind: "x402" }>,
  input: PayCommandInput,
): Promise<PayCommandResult> {
  const gate = gateEnvelope();
  if (gate) return gate;

  const challenge: X402Challenge = first.challenge;
  const preferred = clusterToX402Network(input.preferredNetwork);
  const reqs = selectSolanaRequirements(challenge, preferred);
  if (!reqs) {
    return {
      kind: "envelope",
      envelope: makeEnvelope("client_error", {
        error: "no_supported_network",
        offered: challenge.accepts.map((r) => r.network),
        resource: first.resourceUrl,
      }),
    };
  }

  const wallet = loadOrCreateWallet({ configDir: input.configDir });
  const header = buildX402PaymentHeader({
    keypair: wallet.keypair,
    resource: reqs.resource,
    recipient: reqs.payTo,
    amount: reqs.maxAmountRequired,
    asset: reqs.asset,
    network: reqs.network,
  });

  const second = await runWrappedTool(input.tool, input.args, input.spawn, [
    `${header.name}: ${header.value}`,
  ]);

  return finalizeRetry(second, first.resourceUrl, {
    kind: "x402",
    resource: reqs.resource,
    recipient: reqs.payTo,
    amount: reqs.maxAmountRequired,
    asset: reqs.asset,
    network: reqs.network,
  });
}

async function handleMppRetry(
  first: Extract<RunOutcome, { kind: "mpp" }>,
  input: PayCommandInput,
): Promise<PayCommandResult> {
  const gate = gateEnvelope();
  if (gate) return gate;

  const c = selectMppChallenge(first.challenges);
  if (!c) {
    return {
      kind: "envelope",
      envelope: makeEnvelope("client_error", {
        error: "session_challenge_unsupported",
        resource: first.resourceUrl,
        suggest:
          "MPP session challenges (intent=session) are not supported in v0.1.0",
      }),
    };
  }

  const network =
    c.charge.method_details?.network ??
    clusterToX402Network(input.preferredNetwork) ??
    "solana";

  const wallet = loadOrCreateWallet({ configDir: input.configDir });
  const header = buildMppCredentialHeader({
    keypair: wallet.keypair,
    resource: first.resourceUrl,
    recipient: c.charge.recipient,
    amount: c.charge.amount,
    asset: c.charge.currency,
    network,
  });

  const second = await runWrappedTool(input.tool, input.args, input.spawn, [
    `${header.name}: ${header.value}`,
  ]);

  return finalizeRetry(second, first.resourceUrl, {
    kind: "mpp",
    resource: first.resourceUrl,
    recipient: c.charge.recipient,
    amount: c.charge.amount,
    asset: c.charge.currency,
    network,
  });
}

function finalizeRetry(
  outcome: RunOutcome,
  resourceUrl: string,
  payment: PaymentInfo,
): PayCommandResult {
  switch (outcome.kind) {
    case "completed":
      return {
        kind: "passthrough",
        exitCode: outcome.exitCode,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        bodyBytes: outcome.bodyBytes,
        payment,
      };
    case "rejected":
      return {
        kind: "envelope",
        envelope: makeEnvelope("payment_failed", {
          error: "payment_rejected",
          reason: outcome.reason,
          resource: resourceUrl,
          scheme: payment.kind === "none" ? "unknown" : payment.kind,
        }),
      };
    case "tool_missing":
      // Should be unreachable — the first call would already have bailed.
      return {
        kind: "envelope",
        envelope: makeEnvelope("tool_missing", {
          error: "tool_missing",
          tool: outcome.tool,
        }),
      };
    case "x402":
    case "mpp":
    case "unknown_402":
      return {
        kind: "envelope",
        envelope: makeEnvelope("payment_failed", {
          error: "still_unpaid_after_retry",
          resource: resourceUrl,
          scheme: payment.kind === "none" ? "unknown" : payment.kind,
          suggest:
            "verifier did not accept the pact-allowance authorization; check that the upstream is Pact-aware",
        }),
      };
  }
}
