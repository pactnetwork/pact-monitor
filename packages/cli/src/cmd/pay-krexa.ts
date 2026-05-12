// pact pay --krexa — Krexa Compute Gateway x402 flow.
//
// Krexa-published x402 services use a `PAYMENT-REQUIRED` header (no `X-`
// prefix) and a `PAYMENT-SIGNATURE` retry header carrying an on-chain
// USDC transfer signature, distinct from x402.org canonical. The
// solana-foundation `pay` binary doesn't recognise Krexa's flavor, so
// `--krexa` bypasses the normal pay-binary path entirely and runs a
// self-contained settle + retry flow against curl.
//
// Flow:
//
//   pact pay --krexa <curl-args>
//      ↓
//   spawn `curl -i -s <args>` and capture (status, headers, body)
//      ↓  if 402 + PAYMENT-REQUIRED challenge:
//   build USDC SPL TransferChecked from pact wallet ATA → payTo ATA,
//   sign, submit, await confirmation
//      ↓  inject `PAYMENT-SIGNATURE: <txSig>` and re-spawn curl
//      ↓
//   return Krexa result (signature + retry tool exit + retry status)
//
// Coverage side-call is deliberately skipped: Krexa runs without a
// Pact-aware gateway, so there is no allowance to debit and no
// facilitator-known endpoint to register against. POC scope only —
// see docs/krexa-x402-poc.md for the demo recipe and explicit
// non-goals (no replay protection, no ATA-creation fallback, etc.).

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import type { Subprocess } from "bun";

import { makeEnvelope, type Envelope } from "../lib/envelope.ts";
import { loadOrCreateWallet } from "../lib/wallet.ts";
import {
  HEADER_KREXA_RETRY,
  parseKrexaChallenge,
  selectKrexaSolanaRequirements,
  type KrexaChallenge,
} from "../lib/krexa-x402.ts";
import {
  defaultMainnetRpcUrl,
  settleKrexaPayment,
  USDC_DECIMALS,
} from "../lib/krexa-settle.ts";

export interface CurlSpawnResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export type CurlSpawnFn = (args: string[]) => Promise<CurlSpawnResult>;

export interface PayKrexaInput {
  args: string[]; // verbatim curl args (e.g. ["-X", "POST", "-H", "X-API-Key: ...", "https://..."]
  // Test override: spawn curl deterministically. Tests pass a stub that
  // returns a 402 challenge on the first call and an upstream success
  // on the second.
  spawnCurl?: CurlSpawnFn;
  // Test override: settle on-chain. Real implementation calls
  // settleKrexaPayment with a Connection to mainnet.
  settle?: (args: {
    payer: Keypair;
    mint: PublicKey;
    recipient: PublicKey;
    amountBaseUnits: bigint;
  }) => Promise<{ signature: string }>;
  // Test override: keypair. Real flow loads the project wallet.
  keypair?: Keypair;
  // Project config dir for wallet load (when no keypair injected).
  configDir?: string;
  // Optional preferred Krexa network slug (e.g. "solana-mainnet-beta").
  // When set, the matching offered requirement wins; otherwise first
  // Solana offer is taken.
  preferredNetwork?: string;
}

export type PayKrexaResult =
  | {
      kind: "krexa";
      exitCode: number;
      txSignature: string;
      recipient: string;
      amountBaseUnits: string;
      asset: string;
      network: string;
      upstreamStatus: number | null;
      // The upstream body bytes from the retried call — caller forwards
      // these to stdout so consumers piping to jq see the real payload.
      stdout: Uint8Array;
    }
  | { kind: "envelope"; envelope: Envelope };

const DEFAULT_SPAWN_CURL: CurlSpawnFn = async (args) => {
  const proc: Subprocess = Bun.spawn(["curl", ...args], {
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutBuf = await new Response(
    proc.stdout as ReadableStream<Uint8Array>,
  ).bytes();
  const stderrBuf = await new Response(
    proc.stderr as ReadableStream<Uint8Array>,
  ).bytes();
  const exitCode = await proc.exited;
  return { exitCode, stdout: stdoutBuf, stderr: stderrBuf };
};

// Parse curl's `-i` output: HTTP/x.y status, header lines, blank line,
// body. Returns the status code (0 if none parsed), a lowercased-name
// header map, and the body. Tolerates multiple HTTP responses (e.g.
// from a 301 redirect chain) by keeping the final block.
export interface ParsedCurlResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
}

export function parseCurlIncludeOutput(raw: string): ParsedCurlResponse {
  // Split on header/body boundary: a CRLF pair. curl always emits CRLF.
  // For the final response, take the last `HTTP/` block before the body.
  const HEADER_BODY_SEPARATOR = /\r?\n\r?\n/;
  const parts = raw.split(HEADER_BODY_SEPARATOR);
  // The body is the last part; headers are everything before the last
  // `HTTP/` block.
  if (parts.length < 2) {
    return { statusCode: 0, headers: {}, body: raw };
  }
  const body = parts[parts.length - 1] ?? "";
  const headerBlocks = parts.slice(0, -1);
  const lastHeaderBlock = headerBlocks[headerBlocks.length - 1] ?? "";
  const lines = lastHeaderBlock.split(/\r?\n/);
  if (lines.length === 0) {
    return { statusCode: 0, headers: {}, body };
  }
  const statusLine = lines[0] ?? "";
  const statusMatch = statusLine.match(/HTTP\/[\d.]+\s+(\d{3})/);
  const statusCode = statusMatch ? Number(statusMatch[1]) : 0;
  const headers: Record<string, string | string[]> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx <= 0) continue;
    const name = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();
    const existing = headers[name];
    if (existing === undefined) {
      headers[name] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      headers[name] = [existing, value];
    }
  }
  return { statusCode, headers, body };
}

// Curl args carry the URL as the first non-flag token, but not all
// flags take a value, so a naive scan would misclassify e.g. `-d
// '{"...":"..."}'` if `-d` were absent. We use a small allow-list of
// the value-taking flags that appear in the documented demo recipe.
// Anything not in the list (and not starting with `-`) is the URL.
const VALUE_TAKING_FLAGS = new Set([
  "-X", "--request",
  "-H", "--header",
  "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode",
  "-A", "--user-agent",
  "-e", "--referer",
  "-u", "--user",
  "-o", "--output",
  "-T", "--upload-file",
  "--connect-timeout",
  "--max-time",
  "--retry", "--retry-delay", "--retry-max-time",
  "-b", "--cookie",
  "-c", "--cookie-jar",
  "--cacert", "--capath", "--cert", "--key", "--keytype",
  "--proxy", "-x",
  "--resolve",
]);

export function extractUrlFromCurlArgs(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      // Everything after `--` is positional; first one is the URL.
      return args[i + 1] ?? null;
    }
    if (a.startsWith("-")) {
      // Skip flag value if this flag takes one. Long `--flag=value`
      // forms carry the value inline so don't consume the next token.
      if (a.includes("=")) continue;
      if (VALUE_TAKING_FLAGS.has(a)) {
        i++;
        continue;
      }
      continue;
    }
    return a;
  }
  return null;
}

export async function payKrexaCommand(
  input: PayKrexaInput,
): Promise<PayKrexaResult> {
  if (input.args.length === 0) {
    return {
      kind: "envelope",
      envelope: makeEnvelope("client_error", {
        error: "missing_args",
        message:
          "pact pay --krexa forwards its arguments to curl. Provide at least the target URL, e.g. `pact pay --krexa -X POST https://...`.",
      }),
    };
  }

  const url = extractUrlFromCurlArgs(input.args);
  if (!url) {
    return {
      kind: "envelope",
      envelope: makeEnvelope("client_error", {
        error: "missing_url",
        message:
          "pact pay --krexa could not locate a URL in the forwarded curl arguments.",
      }),
    };
  }

  const spawn = input.spawnCurl ?? DEFAULT_SPAWN_CURL;

  // First call: probe for the 402 challenge. `-i` includes headers in
  // stdout; `-s` suppresses progress meter so the body parse is clean.
  const probeArgs = ["-i", "-s", ...input.args];
  let first;
  try {
    first = await spawn(probeArgs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      kind: "envelope",
      envelope: makeEnvelope("tool_missing", {
        error: "curl_unavailable",
        tool: "curl",
        message,
        suggest: "install curl and ensure it is on PATH",
      }),
    };
  }

  const firstText = new TextDecoder().decode(first.stdout);
  const probed = parseCurlIncludeOutput(firstText);

  // Not a 402, or a 402 with no Krexa challenge — passthrough behaviour:
  // forward stdout to the caller (sans the `-i` headers) and report.
  // The original POC was a curl wrapper, so non-402 responses simply
  // round-trip the upstream body and report status.
  const challenge = parseKrexaChallenge({
    headers: probed.headers,
    body: probed.body,
  });

  if (probed.statusCode !== 402 || !challenge) {
    if (probed.statusCode === 0) {
      // Header parse failed — emit a structured error rather than
      // silently passing garbage through.
      return {
        kind: "envelope",
        envelope: makeEnvelope("server_error", {
          error: "krexa_probe_failed",
          message:
            "curl -i did not return a parseable HTTP response; cannot determine if Krexa challenge is required",
          curl_exit_code: first.exitCode,
        }),
      };
    }
    // Non-402 or 402-without-krexa: surface as an envelope. Do NOT
    // proceed to settle.
    return {
      kind: "envelope",
      envelope: makeEnvelope(
        probed.statusCode >= 500
          ? "server_error"
          : probed.statusCode >= 400
            ? "client_error"
            : "ok",
        {
          message:
            "krexa challenge not detected; no on-chain settlement performed",
          upstream_status: probed.statusCode,
          resource: url,
          body_preview: probed.body.slice(0, 512),
        },
      ),
    };
  }

  const requirements = selectKrexaSolanaRequirements(
    challenge,
    input.preferredNetwork,
  );
  if (!requirements) {
    return {
      kind: "envelope",
      envelope: makeEnvelope("client_error", {
        error: "no_supported_network",
        offered: challenge.accepts.map((r) => r.network),
        resource: url,
      }),
    };
  }

  // Resolve signing key — same precedence as the rest of the CLI: the
  // explicit keypair override wins (tests), then the on-disk wallet
  // loaded from configDir, then PACT_PRIVATE_KEY env (loadOrCreateWallet
  // reads it). A missing key is a hard fail here — Krexa settlement
  // *requires* on-chain signing, unlike the regular pay coverage flow
  // which can soft-skip the side-call.
  let keypair: Keypair;
  try {
    keypair = input.keypair ?? loadOrCreateWallet({ configDir: input.configDir ?? "" }).keypair;
  } catch (err) {
    return {
      kind: "envelope",
      envelope: makeEnvelope("client_error", {
        error: "wallet_unavailable",
        message:
          "pact pay --krexa needs a Pact wallet to sign the on-chain USDC transfer. Run `pact init` or set PACT_PRIVATE_KEY.",
        reason: err instanceof Error ? err.message : String(err),
      }),
    };
  }

  let settleResult: { signature: string };
  try {
    if (input.settle) {
      settleResult = await input.settle({
        payer: keypair,
        mint: new PublicKey(requirements.asset),
        recipient: new PublicKey(requirements.payTo),
        amountBaseUnits: BigInt(requirements.amountBaseUnits),
      });
    } else {
      const connection = new Connection(defaultMainnetRpcUrl(), "confirmed");
      settleResult = await settleKrexaPayment({
        connection,
        payer: keypair,
        mint: new PublicKey(requirements.asset),
        recipient: new PublicKey(requirements.payTo),
        amountBaseUnits: BigInt(requirements.amountBaseUnits),
        decimals: USDC_DECIMALS,
      });
    }
  } catch (err) {
    return {
      kind: "envelope",
      envelope: makeEnvelope("payment_failed", {
        error: "krexa_settlement_failed",
        resource: url,
        reason: err instanceof Error ? err.message : String(err),
        recipient: requirements.payTo,
        amount: requirements.amountBaseUnits,
        asset: requirements.asset,
        suggest:
          "verify wallet has USDC + SOL on mainnet and that the RPC endpoint (KREXA_RPC_URL) is reachable",
      }),
    };
  }

  // Second call: same curl args + PAYMENT-SIGNATURE header injected.
  // Drop the `-i` so the body lands on stdout without HTTP headers
  // bleeding into a consumer's pipe. We still capture stdout so
  // callers receive the upstream bytes through the result, not
  // straight to process.stdout (the index.ts emit() owns that
  // decision in --json vs passthrough modes).
  const retryArgs = [
    "-s",
    "-o", "-",
    "-w", "\nHTTP_STATUS:%{http_code}\n",
    "-H", `${HEADER_KREXA_RETRY}: ${settleResult.signature}`,
    ...input.args,
  ];
  const second = await spawn(retryArgs);
  const secondText = new TextDecoder().decode(second.stdout);
  // The `-w` template appends `\nHTTP_STATUS:<code>\n` after the body;
  // peel it off and surface the code separately.
  const statusMatch = secondText.match(/\nHTTP_STATUS:(\d{3})\n?$/);
  const retryStatus = statusMatch ? Number(statusMatch[1]) : null;
  const cleanBody = statusMatch
    ? secondText.slice(0, secondText.length - statusMatch[0].length)
    : secondText;

  return {
    kind: "krexa",
    exitCode: second.exitCode,
    txSignature: settleResult.signature,
    recipient: requirements.payTo,
    amountBaseUnits: requirements.amountBaseUnits,
    asset: requirements.asset,
    network: requirements.network,
    upstreamStatus: retryStatus,
    stdout: new TextEncoder().encode(cleanBody),
  };
}
