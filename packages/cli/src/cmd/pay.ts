// pact pay — pay.sh wrapper with Pact protection coverage (0.2.3 design).
//
// Flow:
//
//   pact pay <args>
//      ↓
//   spawn `pay <args>` (real solana-foundation/pay)
//      ↓  pay handles x402 / MPP challenge, payment signing, retry
//      ↓  stdout/stderr tee'd to user terminal in real time
//      ↓  on pay exit:
//   classify upstream response (success / client_error / server_error /
//                               payment_failed / tool_error)
//      ↓  if a payment was attempted and --no-coverage was not passed:
//   POST facilitator.pact.network/v1/coverage/register  (side-call —
//        the payment already settled directly with the merchant; this
//        records the receipt + prices the premium + issues a refund on a
//        covered failure, via the same on-chain settle_batch the gateway
//        path uses). Best-effort: a facilitator outage degrades to
//        "(coverage not recorded)" — never fails the command or changes
//        the exit code.
//      ↓
//   emit [pact] summary lines: classifier outcome + real coverage state
//
// The coverage model is the *side-call* model (docs/premium-coverage-mvp.md
// §B.1): pay already settled with the merchant; Pact records + settles
// coverage after. Premium is charged from the agent's `pact approve`
// allowance; refunds on a breach come from the subsidised `pay-default`
// pool.
//
// Anti-goals (deliberately not reintroducing the 0.1.x behavior):
//   - parsing x402 challenges in pact-cli (pay does it)
//   - signing pact-allowance retry headers (the facilitator handles
//     coverage out-of-band; pact-cli does not re-sign pay's retry)
//   - per-tool curl-specific argument rewriting

import { makeEnvelope, type Envelope } from "../lib/envelope.ts";
import { resolveClusterConfig } from "../lib/solana.ts";
import { loadOrCreateWallet } from "../lib/wallet.ts";
import {
  runPay,
  withVerboseFlag,
  withCurlStatusMarker,
  DEFAULT_PAY_PROBE,
  type PayShellFn,
  type PayProbeFn,
} from "../lib/pay-shell.ts";
import {
  classifyPayResult,
  type Outcome,
  type PaymentSummary,
} from "../lib/pay-classifier.ts";
import {
  buildCoveragePayload,
  shouldRegisterCoverage,
} from "../lib/x402-receipt.ts";
import {
  registerCoverage,
  type CoverageDecision,
  type RegisterCoverageInput,
} from "../lib/facilitator.ts";
import type { Keypair } from "@solana/web3.js";

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
  probe?: PayProbeFn;       // test override for the first-run probe
  // Whether to emit the [pact] summary block to stderr at the end. The
  // default is true. --quiet mode (handled in index.ts) sets this false.
  emitSummary?: boolean;
  // Where to write the summary lines (default: process.stderr). Tests
  // capture into a buffer to assert content. The first-run pay-setup
  // warning is also written through this stream so tests can assert
  // on it without grabbing process.stderr.
  summaryStream?: { write(s: string): unknown };

  // --- coverage (0.2.3) ---
  // Skip the facilitator side-call entirely (--no-coverage). The call
  // still happens and pay still settles with the merchant; Pact just
  // doesn't record/price/refund coverage for it.
  noCoverage?: boolean;
  // The project's config dir, used to load the pact wallet that signs
  // the facilitator side-call (this is the same wallet whose
  // `pact approve` allowance funds the premium). If undefined AND
  // PACT_PRIVATE_KEY is unset, coverage registration is skipped (we
  // can't sign without a key).
  configDir?: string;
  // The project name, sent as x-pact-project on the side-call.
  project?: string;
  // Test override: the keypair to sign the side-call with (skips disk
  // wallet loading). When set, `configDir` is not required.
  keypair?: Keypair;
  // Test override: the registerCoverage implementation.
  registerCoverageImpl?: (input: RegisterCoverageInput) => Promise<CoverageDecision>;
  // Test override: facilitator base URL (also overridable via
  // PACT_FACILITATOR_URL env var, which registerCoverage reads itself).
  facilitatorUrl?: string;
}

export interface PassthroughResult {
  kind: "passthrough";
  exitCode: number;
  outcome: Outcome;
  payment: PaymentSummary;
  upstreamStatus: number | null;
  reason: string;
  // The coverage decision from the facilitator side-call, when one was
  // made. null when no payment was attempted, --no-coverage was passed,
  // or no signing key was resolvable.
  coverage: CoverageDecision | null;
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

  // 2b. First-run pay-setup warning. On macOS, pay's first invocation
  //     pops a Touch ID prompt asking the user to authorize provisioning
  //     a Solana keypair into the Keychain. Surfacing a one-line heads-up
  //     before we spawn pay turns an unexpected biometric prompt into an
  //     expected one. Probe errors are swallowed inside the probe itself
  //     so this branch can never block the main flow.
  //
  //     The default probe is skipped when the caller injected a fake pay
  //     binary (i.e. tests) to keep the harness hermetic; tests that
  //     specifically exercise the first-run warning pass an explicit
  //     `probe` override.
  if (input.emitSummary !== false) {
    const probe =
      input.probe ?? (input.pay === undefined ? DEFAULT_PAY_PROBE : null);
    if (probe) {
      const { initialized } = await probe();
      if (!initialized) {
        const out = input.summaryStream ?? process.stderr;
        out.write(
          "[pact] pay.sh has not been initialized on this host. The first " +
            "invocation will prompt for Touch ID to provision a Solana keypair " +
            "into your macOS Keychain. See " +
            "https://github.com/solana-foundation/pay#setup for details.\n",
        );
      }
    }
  }

  // 3. Spawn pay. The runner tee's stdout/stderr to the user's terminal
  //    in real time AND captures buffers for the classifier. We prepend
  //    -v so pay emits its tracing lines (Paying.../Payment signed...),
  //    without which the classifier sees an empty stderr and reports
  //    payment.attempted=false on every settled call (#157). When the
  //    wrapped tool is curl, we ALSO append `-w '[pact-http-status=…]'`
  //    so the upstream HTTP status reaches the classifier — plain curl
  //    forwards exit 0 even on a 5xx, so without this the SLA-breach
  //    refund path can never trigger via `pact pay curl`.
  let result;
  try {
    result = await runPay({
      args: withCurlStatusMarker(withVerboseFlag(input.args)),
      pay: input.pay,
    });
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

  // 4. Coverage side-call. Only when a payment was actually attempted
  //    (a free passthrough has nothing to cover), --no-coverage was not
  //    passed, and we can resolve a signing key (the pact wallet, whose
  //    `pact approve` allowance funds the premium). Best-effort: a
  //    facilitator outage degrades to a soft line, never fails.
  let coverage: CoverageDecision | null = null;
  if (input.noCoverage !== true && shouldRegisterCoverage(classified)) {
    const keypair = resolveSigningKey(input);
    if (keypair) {
      const payload = buildCoveragePayload({
        agentPubkey: keypair.publicKey.toBase58(),
        classified,
      });
      const reg = input.registerCoverageImpl ?? registerCoverage;
      try {
        coverage = await reg({
          keypair,
          project: input.project ?? "pact-pay",
          payload,
          facilitatorUrl: input.facilitatorUrl,
        });
      } catch (err) {
        // registerCoverage already swallows network errors into a
        // "facilitator_unreachable" decision; this catch is belt-and-
        // braces for an unexpected throw (e.g. a bad test mock). Same
        // graceful-degrade behaviour: synthesize an unreachable shape.
        coverage = {
          coverageId: null,
          status: "facilitator_unreachable",
          premiumBaseUnits: "0",
          refundBaseUnits: "0",
          reason: err instanceof Error ? err.message : String(err),
          callId: null,
        };
      }
    }
  }

  // 5. Pact summary block. Goes to stderr so --json consumers piping
  //    stdout into jq still get clean upstream bytes.
  if (input.emitSummary !== false) {
    const out = input.summaryStream ?? process.stderr;
    writePactSummary(out, classified, coverage, input.noCoverage === true);
  }

  return {
    kind: "passthrough",
    exitCode: result.exitCode,
    outcome: classified.outcome,
    payment: classified.payment,
    upstreamStatus: classified.upstreamStatus,
    reason: classified.reason,
    coverage,
  };
}

function resolveSigningKey(input: PayCommandInput): Keypair | null {
  if (input.keypair) return input.keypair;
  // PACT_PRIVATE_KEY works even without a configDir; loadOrCreateWallet
  // reads it first. A configDir is only needed for the on-disk wallet.
  if (!input.configDir && !process.env.PACT_PRIVATE_KEY) return null;
  try {
    return loadOrCreateWallet({ configDir: input.configDir ?? "" }).keypair;
  } catch {
    return null;
  }
}

// Format USDC base units (decimal string) as a human-readable decimal
// with 3+ significant fractional digits trimmed of trailing zeros, e.g.
// "1000" → "0.001", "50000" → "0.050". Falls back to the raw string on
// a parse failure.
const USDC_DECIMALS = 6;
function fmtBaseUnits(baseUnits: string): string {
  let n: bigint;
  try {
    n = BigInt(baseUnits);
  } catch {
    return baseUnits;
  }
  const base = BigInt(10) ** BigInt(USDC_DECIMALS);
  const neg = n < 0n;
  if (neg) n = -n;
  const whole = n / base;
  const frac = (n % base).toString().padStart(USDC_DECIMALS, "0");
  // Keep at least 3 fractional digits (so "0.001" not "0"), trim beyond.
  const trimmed = frac.replace(/0+$/, "");
  const fracOut = trimmed.length >= 3 ? trimmed : frac.slice(0, 3);
  return `${neg ? "-" : ""}${whole}.${fracOut}`;
}

function writePactSummary(
  out: { write(s: string): unknown },
  classified: ReturnType<typeof classifyPayResult>,
  coverage: CoverageDecision | null,
  noCoverage: boolean,
): void {
  const tag = "[pact]";
  const lines: string[] = [];
  const { payment, outcome, upstreamStatus, reason } = classified;

  // Base / premium / coverage line, present when a payment was
  // attempted.
  if (payment.attempted) {
    const base =
      payment.amount && payment.asset
        ? `${payment.amount} ${payment.asset}`
        : "(amount unknown)";

    if (noCoverage) {
      lines.push(`${tag} base ${base} (coverage skipped: --no-coverage)`);
    } else if (coverage === null) {
      // No signing key resolvable (no pact wallet / PACT_PRIVATE_KEY).
      lines.push(
        `${tag} base ${base} (coverage skipped: no pact wallet — run \`pact init\` / set PACT_PRIVATE_KEY)`,
      );
    } else if (coverage.status === "facilitator_unreachable") {
      lines.push(
        `${tag} base ${base} (coverage not recorded: facilitator unreachable${coverage.reason ? ` — ${coverage.reason}` : ""})`,
      );
    } else if (coverage.status === "rejected") {
      lines.push(
        `${tag} base ${base} (coverage rejected: ${coverage.reason || "facilitator rejected the receipt"})`,
      );
    } else if (coverage.status === "uncovered") {
      lines.push(
        `${tag} base ${base} + premium 0.000 (uncovered: ${coverage.reason || "no covered pool"})`,
      );
      if (coverage.reason === "no_allowance" || coverage.reason === "needs_funding") {
        lines.push(`${tag} (run \`pact approve\` to enable coverage)`);
      }
    } else {
      // settlement_pending — coverage is real.
      const premium = fmtBaseUnits(coverage.premiumBaseUnits);
      const idSuffix = coverage.coverageId ? ` (coverage ${coverage.coverageId})` : "";
      lines.push(`${tag} base ${base} + premium ${premium} (covered: pool pay-default)${idSuffix}`);
    }
  }

  const statusHint =
    upstreamStatus !== null ? `status=${upstreamStatus}` : "status=?";
  switch (outcome) {
    case "success":
      lines.push(`${tag} classifier: success  (${statusHint})`);
      break;
    case "server_error":
      lines.push(`${tag} classifier: server_error  (${statusHint}, reason=${reason || "n/a"})`);
      appendBreachLines(lines, tag, "server_error", coverage, noCoverage, payment.attempted);
      break;
    case "client_error":
      lines.push(`${tag} classifier: client_error  (${statusHint}, reason=${reason || "n/a"})`);
      lines.push(`${tag} (no refund: client errors are caller fault under default SLA)`);
      break;
    case "payment_failed":
      lines.push(`${tag} classifier: payment_failed  (${reason || "pay exit non-zero"})`);
      lines.push(`${tag} (no charge — pay's payment leg never settled)`);
      break;
    case "tool_error":
      lines.push(`${tag} classifier: tool_error  (${reason || "wrapped tool exit non-zero"})`);
      lines.push(`${tag} (no charge — wrapped tool failed before any 402 challenge)`);
      break;
  }

  for (const l of lines) out.write(l + "\n");
}

function appendBreachLines(
  lines: string[],
  tag: string,
  verdict: string,
  coverage: CoverageDecision | null,
  noCoverage: boolean,
  paymentAttempted: boolean,
): void {
  if (!paymentAttempted) {
    lines.push(`${tag} policy: refund_on_${verdict} (no payment attempted — nothing to refund)`);
    return;
  }
  if (noCoverage) {
    lines.push(`${tag} policy: refund_on_${verdict} — coverage skipped (--no-coverage)`);
    return;
  }
  if (coverage === null) {
    lines.push(`${tag} policy: refund_on_${verdict} — coverage skipped (no pact wallet)`);
    return;
  }
  if (coverage.status === "facilitator_unreachable") {
    lines.push(
      `${tag} policy: refund_on_${verdict} — coverage not recorded (facilitator unreachable)`,
    );
    return;
  }
  if (coverage.status === "rejected") {
    lines.push(
      `${tag} policy: refund_on_${verdict} — coverage rejected (${coverage.reason || "facilitator rejected the receipt"})`,
    );
    return;
  }
  if (coverage.status === "uncovered") {
    lines.push(
      `${tag} policy: refund_on_${verdict} — uncovered (${coverage.reason || "no covered pool"})`,
    );
    if (coverage.reason === "no_allowance" || coverage.reason === "needs_funding") {
      lines.push(`${tag} (run \`pact approve\` to enable coverage)`);
    }
    return;
  }
  // settlement_pending — refund is real.
  const refund = fmtBaseUnits(coverage.refundBaseUnits);
  const idSuffix = coverage.coverageId ? ` (coverage ${coverage.coverageId})` : "";
  lines.push(
    `${tag} policy: refund_on_${verdict} — refund ${refund} settling on-chain${idSuffix}`,
  );
  const statusRef = coverage.coverageId
    ? `pact pay coverage ${coverage.coverageId}`
    : coverage.callId
      ? `pact calls ${coverage.callId}`
      : "pact pay coverage <id>";
  lines.push(`${tag} check status: ${statusRef}`);
}

// Build the `coverage` block for the --json envelope's `meta`. Returns
// undefined when there's no coverage decision to report.
export function coverageMeta(
  coverage: CoverageDecision | null,
): Record<string, unknown> | undefined {
  if (!coverage) return undefined;
  return {
    id: coverage.coverageId,
    status: coverage.status,
    premiumBaseUnits: coverage.premiumBaseUnits,
    refundBaseUnits: coverage.refundBaseUnits,
    pool: "pay-default",
    reason: coverage.reason,
    ...(coverage.callId ? { callId: coverage.callId } : {}),
  };
}
