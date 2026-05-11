// pact pay — pay.sh wrapper with Pact protection coverage (0.2.0 design).
//
// What changed vs 0.1.x:
//
//   pact pay <args>
//      ↓
//   spawn `pay <args>` (real solana-foundation/pay)
//      ↓  pay handles x402 / MPP challenge, payment signing, retry
//      ↓  stdout/stderr tee'd to user terminal in real time
//      ↓  on pay exit:
//   classify upstream response (success / client_error / server_error /
//                               payment_failed)
//      ↓
//   emit [pact] summary lines: classifier outcome + chargeback signal
//
// What's still TODO (matches PAY-SH-INTEGRATION-STRATEGY.md):
//
//   - real on-chain refund settlement requires facilitator.pact.network,
//     which doesn't exist yet. For 0.2.0 we emit an honest "(refund
//     settlement available via facilitator.pact.network — coming soon)"
//     line on a breach. Same wrapper shape, just no settle_batch yet.
//
// Anti-goals (deliberately not reintroducing the 0.1.x behavior):
//   - parsing x402 challenges in pact-cli (pay does it)
//   - signing pact-allowance retry headers (out of scope without facilitator)
//   - per-tool curl-specific argument rewriting

import { makeEnvelope, type Envelope } from "../lib/envelope.ts";
import { resolveClusterConfig } from "../lib/solana.ts";
import { runPay, type PayShellFn } from "../lib/pay-shell.ts";
import {
  classifyPayResult,
  type Outcome,
  type PaymentSummary,
} from "../lib/pay-classifier.ts";

// Defense-in-depth gate, mirrored from 0.1.x: closed mainnet gate
// blocks pact pay so a stray invocation cannot end up signing or
// settling real USDC. Runs BEFORE we spawn pay.
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

// pay's documented non-mainnet flags (verified vs `pay --help` against
// solana-foundation/pay 0.16.0, 2026-05-11):
//
//   --sandbox  force network=localnet, hosted Surfpool RPC
//   --dev      hidden alias for --sandbox
//   --local    force network=localnet, localhost Surfpool RPC
//
// When any of these appear in the argv pact forwards to pay, the call
// has zero mainnet exposure and the closed PACT_MAINNET_ENABLED gate
// should not block it. The check stops at "--" so a wrapped tool's own
// `--sandbox` argument (e.g. `pact pay curl --sandbox http://...`)
// cannot bypass the gate by accident.
const PAY_NON_MAINNET_FLAGS = new Set(["--sandbox", "--dev", "--local"]);
function argvTargetsNonMainnet(args: string[]): boolean {
  for (const arg of args) {
    if (arg === "--") return false;
    if (PAY_NON_MAINNET_FLAGS.has(arg)) return true;
  }
  return false;
}

export interface PayCommandInput {
  args: string[];           // verbatim argv after `pact pay`, e.g. ["curl", "-s", "https://…"]
  pay?: PayShellFn;         // test override
  // Whether to emit the [pact] summary block to stderr at the end. The
  // default is true. --quiet mode (handled in index.ts) sets this false.
  emitSummary?: boolean;
  // Where to write the summary lines (default: process.stderr). Tests
  // capture into a buffer to assert content.
  summaryStream?: { write(s: string): unknown };
}

export interface PassthroughResult {
  kind: "passthrough";
  exitCode: number;
  outcome: Outcome;
  payment: PaymentSummary;
  upstreamStatus: number | null;
  reason: string;
}

export type PayCommandResult =
  | PassthroughResult
  | { kind: "envelope"; envelope: Envelope };

export async function payCommand(
  input: PayCommandInput,
): Promise<PayCommandResult> {
  // 1. Pact-side argument validation — `pact pay` must have at least one
  //    positional arg; otherwise we'd silently spawn `pay` with no
  //    arguments, which prints pay's help (confusing in --json mode).
  if (input.args.length === 0) {
    return {
      kind: "envelope",
      envelope: makeEnvelope("client_error", {
        error: "missing_args",
        message:
          "pact pay forwards its arguments to `pay` (solana-foundation/pay). Provide at least the wrapped tool, e.g. `pact pay curl https://...`.",
      }),
    };
  }

  // 2. Mainnet gate. Runs before the pay binary check so a closed gate
  //    short-circuits cleanly even on hosts without pay installed.
  //    Bypassed when pay's argv contains a documented non-mainnet flag
  //    (--sandbox / --dev / --local): such calls route to localnet via
  //    pay's own machinery and carry zero mainnet exposure, so the gate
  //    would be overly conservative.
  if (!argvTargetsNonMainnet(input.args)) {
    const gate = gateEnvelope();
    if (gate) return gate;
  }

  // 3. Spawn pay. The runner tee's stdout/stderr to the user's terminal
  //    in real time AND captures buffers for the classifier.
  let result;
  try {
    result = await runPay({ args: input.args, pay: input.pay });
  } catch (err) {
    // Most common cause: pay isn't on PATH. Surface a structured
    // envelope rather than a stack trace; same shape as the old
    // tool_missing case from 0.1.x so downstream consumers don't break.
    const message = err instanceof Error ? err.message : String(err);
    return {
      kind: "envelope",
      envelope: makeEnvelope("tool_missing", {
        error: "pay_unavailable",
        tool: "pay",
        message,
        suggest:
          "Install solana-foundation/pay: https://github.com/solana-foundation/pay",
      }),
    };
  }

  const stdoutText = new TextDecoder().decode(result.stdout);
  const stderrText = new TextDecoder().decode(result.stderr);
  const classified = classifyPayResult({
    payExitCode: result.exitCode,
    stdoutText,
    stderrText,
  });

  // 4. Pact summary block. Goes to stderr so --json consumers piping
  //    stdout into jq still get clean upstream bytes.
  if (input.emitSummary !== false) {
    const out = input.summaryStream ?? process.stderr;
    writePactSummary(out, classified);
  }

  return {
    kind: "passthrough",
    exitCode: result.exitCode,
    outcome: classified.outcome,
    payment: classified.payment,
    upstreamStatus: classified.upstreamStatus,
    reason: classified.reason,
  };
}

function writePactSummary(
  out: { write(s: string): unknown },
  classified: ReturnType<typeof classifyPayResult>,
): void {
  const tag = "[pact]";
  const lines: string[] = [];
  const { payment, outcome, upstreamStatus, reason } = classified;

  // Premium / classifier line, always present when a payment was
  // attempted. Premium is currently 0 in this build — the facilitator
  // doesn't exist yet, so we charge nothing extra.
  if (payment.attempted) {
    const amt =
      payment.amount && payment.asset
        ? `${payment.amount} ${payment.asset}`
        : "(amount unknown)";
    lines.push(`${tag} base ${amt} + premium 0.000 (facilitator not yet enabled)`);
  }

  const statusHint =
    upstreamStatus !== null ? `status=${upstreamStatus}` : "status=?";
  switch (outcome) {
    case "success":
      lines.push(`${tag} classifier: success  (${statusHint})`);
      break;
    case "server_error":
      lines.push(`${tag} classifier: server_error  (${statusHint}, reason=${reason || "n/a"})`);
      lines.push(`${tag} policy: refund_on_server_error`);
      lines.push(`${tag} (refund settlement available via facilitator.pact.network — coming soon)`);
      break;
    case "client_error":
      lines.push(`${tag} classifier: client_error  (${statusHint}, reason=${reason || "n/a"})`);
      lines.push(`${tag} (no refund: client errors are caller fault under default SLA)`);
      break;
    case "payment_failed":
      lines.push(`${tag} classifier: payment_failed  (${reason || "pay exit non-zero"})`);
      lines.push(`${tag} (no charge — pay's payment leg never settled)`);
      break;
  }

  for (const l of lines) out.write(l + "\n");
}
