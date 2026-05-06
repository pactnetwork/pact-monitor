#!/usr/bin/env bun
import { Command } from "commander";
import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { resolveProjectName } from "./lib/project.ts";
import { detectMode, renderEnvelope } from "./lib/output.ts";
import { exitCodeFor, buildInternalErrorEnvelope, type Envelope } from "./lib/envelope.ts";
import { runCommand } from "./cmd/run.ts";
import { balanceCommand } from "./cmd/balance.ts";
import { depositCommand } from "./cmd/deposit.ts";
import { agentsShowCommand, agentsWatchCommand } from "./cmd/agents.ts";
import { initCommand } from "./cmd/init.ts";

const VERSION = "0.1.0";
const DEFAULT_GATEWAY = process.env.PACT_GATEWAY_URL ?? "https://market.pactnetwork.io";
const DEFAULT_RPC = process.env.PACT_RPC_URL ?? "https://api.devnet.solana.com";
const DEFAULT_CLUSTER = (process.env.PACT_CLUSTER ?? "devnet") as "devnet" | "mainnet";

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
  // @ts-expect-error narrowed in branch above by emit() never-return
  return r.name;
}

const program = new Command();
program
  .name("pact")
  .description("Insured paid API calls for AI agents")
  .version(VERSION)
  .option("--json", "structured envelope to stdout")
  .option("--quiet", "body to stdout only")
  .option("--project <name>", "explicit project name (overrides env/git)")
  .option("--gateway <url>", "override gateway URL", DEFAULT_GATEWAY)
  .option("--rpc <url>", "override Solana RPC URL", DEFAULT_RPC)
  .option("--cluster <c>", "devnet|mainnet", DEFAULT_CLUSTER);

// `pact <url>` is the default action when first arg is a URL
program
  .argument("[url]", "URL to call through pact gateway")
  .option("--method <m>", "HTTP method", "GET")
  .option("--header <h...>", "HTTP header (repeatable)")
  .option("-d, --data <body>", "request body")
  .option("--raw", "skip slug rewriting (uninsured)")
  .option("--timeout <sec>", "timeout seconds", "30")
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
      cluster: program.opts().cluster,
      raw: options.raw,
      timeoutMs: parseInt(options.timeout) * 1000,
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
      cluster: program.opts().cluster,
    });
    emit(env, Boolean(program.opts().json), Boolean(program.opts().quiet));
  });

program
  .command("deposit <usdc>")
  .description("Deposit USDC into this project's agent wallet")
  .action(async (usdc: string) => {
    const project = resolveProjectOrDie(program.opts().project);
    const env = await depositCommand({
      amountUsdc: parseFloat(usdc),
      configDir: configDirFor(project),
      rpcUrl: program.opts().rpc,
      cluster: program.opts().cluster,
    });
    emit(env, Boolean(program.opts().json), Boolean(program.opts().quiet));
  });

program
  .command("agents")
  .description("Inspect an agent's calls and balance")
  .argument("[subcommand]", "show|watch", "show")
  .argument("[pubkey]", "pubkey or call_id (defaults to this project's agent)")
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
  .command("init")
  .description("Install Pact skill into this project")
  .action(async () => {
    const skillSrc = readFileSync(
      new URL("./skill/SKILL.md", import.meta.url),
      "utf8",
    );
    const snippetSrc = readFileSync(
      new URL("./skill/claude-md-snippet.md", import.meta.url),
      "utf8",
    );
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
