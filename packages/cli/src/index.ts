#!/usr/bin/env bun
import { Command, CommanderError } from "commander";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveProjectName } from "./lib/project.ts";
import { detectMode, renderEnvelope } from "./lib/output.ts";
import { exitCodeFor, buildInternalErrorEnvelope, type Envelope } from "./lib/envelope.ts";
import {
  parsePositiveFloat,
  parsePositiveInt,
  parseUrlStrict,
  validateClusterStrict,
} from "./lib/validators.ts";
import { runCommand } from "./cmd/run.ts";
import { balanceCommand } from "./cmd/balance.ts";
import { approveCommand, revokeCommand } from "./cmd/approve.ts";
import { pauseCommand } from "./cmd/pause.ts";
import { agentsShowCommand, agentsWatchCommand } from "./cmd/agents.ts";
import { callsShowCommand } from "./cmd/calls.ts";
import { initCommand } from "./cmd/init.ts";
import { payCommand, coverageMeta } from "./cmd/pay.ts";
import { payCoverageStatusCommand } from "./cmd/pay-coverage.ts";
// Bundle skill assets into the compiled binary via Bun text imports.
// readFileSync(import.meta.url) does not work with `bun build --compile`
// because raw .md files are not embedded into the bunfs virtual filesystem.
import skillSrc from "./skill/SKILL.md" with { type: "text" };
import snippetSrc from "./skill/claude-md-snippet.md" with { type: "text" };

const VERSION = "0.2.3";
const DEFAULT_GATEWAY = process.env.PACT_GATEWAY_URL ?? "https://api.pactnetwork.io";
const DEFAULT_RPC = process.env.PACT_RPC_URL ?? "https://api.mainnet-beta.solana.com";
// v0.1.0 is mainnet-only. Mainnet still requires PACT_MAINNET_ENABLED=1 as a
// defensive speed-bump so first-invocation accidents can't route real USDC.
// Both --cluster and PACT_CLUSTER flow through validateClusterStrict so a
// closed gate short-circuits to a client_error envelope before any
// wallet/RPC side effect.
const DEFAULT_CLUSTER = "mainnet" as const;

function configDirFor(projectName: string): string {
  return join(homedir(), ".config", "pact", projectName);
}

function emit(env: Envelope, jsonFlag: boolean, quietFlag: boolean): never {
  const mode = detectMode({
    jsonFlag,
    quietFlag,
    isTTY: Boolean(process.stdout.isTTY),
  });
  const r = renderEnvelope({ mode, envelope: env });
  if (r.stdout) process.stdout.write(r.stdout + "\n");
  if (r.stderr) process.stderr.write(r.stderr + "\n");
  process.exit(exitCodeFor(env.status));
}

function emitClientError(message: string): never {
  // We may not have parsed --json/--quiet through commander yet, so detect
  // them directly from argv. Used for env-var rejection at module load and
  // commander parse-time errors via exitOverride.
  const wantsJson = process.argv.includes("--json");
  const wantsQuiet = process.argv.includes("--quiet");
  emit({ status: "client_error", body: { error: message } }, wantsJson, wantsQuiet);
}

// Reject unsupported PACT_CLUSTER values up front so neither the CLI option
// default nor any downstream code path sees "mainnet" in v0.1.0 (B2).
if (process.env.PACT_CLUSTER !== undefined && process.env.PACT_CLUSTER !== "") {
  try {
    validateClusterStrict(process.env.PACT_CLUSTER);
  } catch (err) {
    emitClientError(
      `PACT_CLUSTER=${process.env.PACT_CLUSTER}: ${(err as Error).message}`,
    );
  }
}

function resolveProjectOrDie(flag?: string): string {
  const r = resolveProjectName({ flag, cwd: process.cwd() });
  if (!r.ok) {
    emit(
      {
        status: "needs_project_name",
        body: { suggest: "pass --project or set PACT_PROJECT" },
      },
      true,
      false,
    );
  }
  return r.name;
}

const program = new Command();
// Required so `pact pay <tool> [...args]` can pass --flags through to the
// wrapped tool without commander trying to parse them as pact options.
program.enablePositionalOptions();
program
  .name("pact")
  .description("Insured paid API calls for AI agents")
  .version(VERSION)
  .option("--json", "structured envelope to stdout")
  .option("--quiet", "body to stdout only")
  .option("--project <name>", "explicit project name (overrides env/git)")
  .option("--gateway <url>", "override gateway URL", DEFAULT_GATEWAY)
  .option("--rpc <url>", "override Solana RPC URL", DEFAULT_RPC)
  .option(
    "--cluster <c>",
    "mainnet only in v0.1.0 (requires PACT_MAINNET_ENABLED=1)",
    validateClusterStrict,
    DEFAULT_CLUSTER,
  );

// Route commander parse errors (invalid --cluster, unknown options, missing
// args, etc.) through emit() as client_error envelopes so --json consumers
// always see structured output instead of a stack trace on stderr (B2).
program.exitOverride((err: CommanderError) => {
  if (
    err.code === "commander.helpDisplayed" ||
    err.code === "commander.help" ||
    err.code === "commander.version"
  ) {
    process.exit(err.exitCode);
  }
  emitClientError(err.message);
});
program.configureOutput({
  // Suppress commander's default stderr writes; the envelope is the contract.
  writeErr: () => {},
});

// `pact <url>` is the default action when first arg is a URL
program
  .argument("[url]", "URL to call through pact gateway", parseUrlStrict)
  .option("--method <m>", "HTTP method", "GET")
  .option("--header <h...>", "HTTP header (repeatable)")
  .option("-d, --data <body>", "request body")
  .option(
    "--raw",
    "call the upstream URL directly, uninsured (no gateway, no Pact signing, no premium)",
  )
  .option("--timeout <sec>", "timeout seconds (positive integer)", parsePositiveInt, 30)
  .action(async (url, options) => {
    if (!url) {
      program.help();
      return;
    }
    const project = resolveProjectOrDie(options.project ?? program.opts().project);
    const headers: Record<string, string> = {};
    for (const h of (options.header ?? []) as string[]) {
      const [k, ...rest] = h.split(":");
      headers[k.trim().toLowerCase()] = rest.join(":").trim();
    }
    const env = await runCommand({
      url,
      method: options.method,
      headers,
      body: options.data,
      configDir: configDirFor(project),
      gatewayUrl: program.opts().gateway,
      project,
      rpcUrl: program.opts().rpc,
      raw: options.raw,
      timeoutMs: (options.timeout as number) * 1000,
    });
    emit(env, Boolean(program.opts().json), Boolean(program.opts().quiet));
  });

program
  .command("balance")
  .description("Show this project's wallet balance")
  .action(async () => {
    const project = resolveProjectOrDie(program.opts().project);
    const env = await balanceCommand({
      configDir: configDirFor(project),
      rpcUrl: program.opts().rpc,
    });
    emit(env, Boolean(program.opts().json), Boolean(program.opts().quiet));
  });

program
  .command("approve")
  .description(
    "Grant SPL Token Approve allowance to SettlementAuthority delegate (USDC)",
  )
  .argument("<usdc>", "max allowance in USDC (positive number)", parsePositiveFloat)
  .action(async (usdc: number) => {
    const project = resolveProjectOrDie(program.opts().project);
    const env = await approveCommand({
      amountUsdc: usdc,
      configDir: configDirFor(project),
      rpcUrl: program.opts().rpc,
    });
    emit(env, Boolean(program.opts().json), Boolean(program.opts().quiet));
  });

program
  .command("revoke")
  .description("Revoke the SPL Token Approve allowance for SettlementAuthority")
  .action(async () => {
    const project = resolveProjectOrDie(program.opts().project);
    const env = await revokeCommand({
      configDir: configDirFor(project),
      rpcUrl: program.opts().rpc,
    });
    emit(env, Boolean(program.opts().json), Boolean(program.opts().quiet));
  });

program
  .command("pause")
  .description(
    "Admin: pause the protocol kill switch (requires PACT_PRIVATE_KEY = ProtocolConfig.authority)",
  )
  .action(async () => {
    const env = await pauseCommand({
      rpcUrl: program.opts().rpc,
    });
    emit(env, Boolean(program.opts().json), Boolean(program.opts().quiet));
  });

program
  .command("agents")
  .description("Inspect an agent's wallet (balance + allowance)")
  .argument("[subcommand]", "show|watch", "show")
  .argument("[pubkey]", "wallet pubkey (defaults to this project's agent)")
  .option("--watch", "stream live events (SSE)")
  .action(async (subcommand: string, pubkey: string | undefined, options) => {
    const project = resolveProjectOrDie(program.opts().project);
    if (options.watch || subcommand === "watch") {
      await agentsWatchCommand({
        configDir: configDirFor(project),
        gatewayUrl: program.opts().gateway,
        pubkey,
        onEvent: (e) => process.stdout.write(JSON.stringify(e) + "\n"),
      });
      return;
    }
    const env = await agentsShowCommand({
      configDir: configDirFor(project),
      gatewayUrl: program.opts().gateway,
      pubkey,
    });
    emit(env, Boolean(program.opts().json), Boolean(program.opts().quiet));
  });

program
  .command("calls")
  .description("Inspect a single insured call by its UUID")
  .argument("[subcommand]", "show", "show")
  .argument("<call_id>", "UUIDv4 returned in X-Pact-Call-Id on a wrapped call")
  .action(async (subcommand: string, callId: string) => {
    if (subcommand !== "show") {
      emit(
        {
          status: "client_error",
          body: {
            error: "unknown_subcommand",
            subcommand,
            message: "calls subcommand must be 'show'",
          },
        },
        Boolean(program.opts().json),
        Boolean(program.opts().quiet),
      );
      return;
    }
    const env = await callsShowCommand({
      gatewayUrl: program.opts().gateway,
      callId,
    });
    emit(env, Boolean(program.opts().json), Boolean(program.opts().quiet));
  });

program
  .command("pay")
  .description(
    "Wrap solana-foundation/pay with Pact protection coverage (classifier + facilitator coverage registration)",
  )
  .argument("[args...]", "arguments forwarded verbatim to `pay` (or `coverage <id>` to check a coverage registration)")
  // Declare --json on pay (mirrors `run` and `balance`) so commander parses
  // it before passThroughOptions hands the rest to pay. Without this,
  // `pact pay --json curl ...` would forward `--json` as a pay argument.
  .option("--json", "structured envelope to stdout (suppresses raw passthrough)")
  // --no-coverage: skip the facilitator side-call entirely. The call
  // still happens and pay still settles with the merchant; Pact just
  // doesn't record/price/refund coverage for it. Commander parses this
  // as `options.coverage === false` (negated boolean).
  .option("--no-coverage", "skip the facilitator coverage registration side-call")
  .allowUnknownOption(true)
  .passThroughOptions(true)
  .action(async (args: string[], options) => {
    const wantsJson = Boolean(options?.json) || Boolean(program.opts().json);
    const isQuiet = Boolean(program.opts().quiet);

    // `pact pay coverage <id>` — a pay-coverage status lookup, not a
    // wrapped-tool invocation. Recognised when the first positional is
    // exactly "coverage".
    if (args.length >= 1 && args[0] === "coverage") {
      const coverageId = args[1];
      if (!coverageId) {
        emit(
          {
            status: "client_error",
            body: {
              error: "missing_coverage_id",
              message: "usage: pact pay coverage <coverageId>",
            },
          },
          wantsJson,
          isQuiet,
        );
        return;
      }
      const env = await payCoverageStatusCommand({ coverageId });
      emit(env, wantsJson, isQuiet);
      return;
    }

    // Resolve the project (best-effort) so we can locate the pact
    // wallet that signs the facilitator side-call. `pact pay` works
    // without a project today; if resolution fails we just skip
    // coverage registration (the [pact] line says so).
    const proj = resolveProjectName({
      flag: program.opts().project,
      cwd: process.cwd(),
    });
    const projectName = proj.ok ? proj.name : undefined;
    const configDir = projectName ? configDirFor(projectName) : undefined;

    const result = await payCommand({
      args,
      // In --json mode we suppress the [pact] stderr lines so the
      // structured envelope is the only thing a consumer needs to read.
      // In passthrough mode the lines go to stderr alongside pay's own
      // verbose output. Same for --quiet.
      emitSummary: !wantsJson && !isQuiet,
      // Commander negated boolean: `--no-coverage` → options.coverage === false.
      noCoverage: options?.coverage === false,
      configDir,
      project: projectName,
    });

    if (result.kind === "passthrough") {
      // Passthrough's contract: the wrapped tool's exit code wins. In
      // --json mode we still surface the classifier + payment summary
      // inside a structured envelope (status = classifier outcome) but
      // exit with pay's exit code, not the envelope-status mapping.
      if (wantsJson) {
        const meta = coverageMeta(result.coverage);
        const env: Envelope = {
          status:
            result.outcome === "success"
              ? "ok"
              : result.outcome === "payment_failed"
                ? "payment_failed"
                : result.outcome === "client_error"
                  ? "client_error"
                  : result.outcome === "tool_error"
                    ? "tool_error"
                    : "server_error",
          body: {
            tool_exit_code: result.exitCode,
            classifier: result.outcome,
            upstream_status: result.upstreamStatus,
            reason: result.reason,
            payment: result.payment,
          },
          ...(meta ? { meta: { coverage: meta } } : {}),
        };
        process.stdout.write(JSON.stringify(env) + "\n");
        process.exit(result.exitCode);
      }
      // Default passthrough: pay's stdout/stderr already went directly
      // to the user via the tee. Just exit with pay's code.
      process.exit(result.exitCode);
    }
    emit(result.envelope, wantsJson, isQuiet);
  });

program
  .command("init")
  .description("Install Pact skill into this project")
  .action(async () => {
    const env = await initCommand({
      cwd: process.cwd(),
      skillSrc,
      snippetSrc,
    });
    emit(env, Boolean(program.opts().json), Boolean(program.opts().quiet));
  });

program.parseAsync().catch((err) => {
  emit(buildInternalErrorEnvelope(err), true, false);
});
