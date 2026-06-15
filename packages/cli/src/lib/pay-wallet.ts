// Integration with solana-foundation/pay's account store.
//
// Why: 0.2.x stored a separate Pact keypair under
// `~/.config/pact/<project>/wallet.json`. Users had to fund TWO wallets — pay's
// (for the merchant x402 payment) and Pact's (for the premium allowance + the
// facilitator side-call signature). For `pact pay <args>`, that's incoherent:
// the agent that pays the merchant should be the same agent Pact charges
// premium against. 0.3.0 collapses to one wallet — pay's.
//
// How: pay stores accounts in `~/.config/pay/accounts.yml` (plain YAML, one
// flag per active account). pay also exposes `pay account export <name> -`,
// which prints the 64-byte keypair as a JSON byte array to stdout (the same
// format `solana-keygen` writes). We read the YAML to find the active account,
// then shell out to pay for the keypair. On macOS the export triggers a
// Touch ID prompt the first time per session; the Keychain caches the auth
// for ~5 minutes after that so subsequent invocations are silent.
//
// Scope: this is used ONLY for the `pact pay` codepath. The bare
// `pact <url>` gateway flow still uses `loadOrCreateWallet` — there's no pay
// involvement there, no need to require it.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { Keypair } from "@solana/web3.js";
import yaml from "js-yaml";

import { keypairFromInput } from "./wallet.ts";

export const PAY_ACCOUNTS_YML = join(homedir(), ".config", "pay", "accounts.yml");

// Subset of the on-disk schema we depend on. Anything else in the YAML is
// passed through unchanged — we only read.
//
// version: 2
// accounts:
//   <cluster>:                 # "mainnet" | "devnet" | "testnet" | "localnet"
//     <name>:
//       keystore: keychain | gnome-keyring | file
//       active: true            # optional, marks the default account
//       auth_required: true     # optional, indicates Touch ID / passphrase
//       pubkey: "<base58>"
interface PayAccountsFile {
  version?: number;
  accounts?: Record<string, Record<string, {
    keystore?: string;
    active?: boolean;
    auth_required?: boolean;
    pubkey?: string;
  }>>;
}

export interface PayActiveAccount {
  name: string;
  cluster: string;
  pubkey: string;
  keystore: string | null;
  authRequired: boolean;
}

/**
 * Read `~/.config/pay/accounts.yml` and return the active account for the
 * given cluster (or for whichever cluster has one if `cluster` is omitted —
 * pay 0.13 only writes one cluster section at a time today, but the schema
 * supports multiple). Returns null when pay isn't set up on this host.
 */
export function resolvePayActiveAccount(opts: {
  cluster?: "mainnet" | "devnet" | "testnet" | "localnet";
  accountsPath?: string;
} = {}): PayActiveAccount | null {
  const path = opts.accountsPath ?? PAY_ACCOUNTS_YML;
  if (!existsSync(path)) return null;

  let parsed: PayAccountsFile;
  try {
    parsed = yaml.load(readFileSync(path, "utf8")) as PayAccountsFile;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !parsed.accounts) return null;

  const clusters = opts.cluster ? [opts.cluster] : Object.keys(parsed.accounts);
  for (const cluster of clusters) {
    const bucket = parsed.accounts[cluster];
    if (!bucket) continue;
    for (const [name, entry] of Object.entries(bucket)) {
      if (entry?.active === true && entry.pubkey) {
        return {
          name,
          cluster,
          pubkey: entry.pubkey,
          keystore: entry.keystore ?? null,
          authRequired: entry.auth_required === true,
        };
      }
    }
  }
  return null;
}

export interface PayKeypairResult {
  keypair: Keypair;
  account: PayActiveAccount;
}

/**
 * Shell out to `pay account export <name> -` and parse the resulting JSON
 * byte array into a Keypair.
 *
 * `pay` writes the 64-byte secret-key array to stdout. On macOS the export
 * triggers a Touch ID prompt (or however the user configured `auth_required`);
 * we surface that prompt directly to the user's terminal by inheriting stdin
 * and stderr.
 *
 * Throws on:
 *   - `pay` not on PATH (caller should surface a helpful message)
 *   - pay exits non-zero (auth denied / account missing)
 *   - stdout isn't a parseable 64-element byte array
 */
export async function exportPayKeypair(opts: {
  name: string;
  // Test override: injectable spawn that returns the same {exitCode,stdout,stderr}
  // shape as a real pay export. Used by pay-wallet.test.ts to avoid touching
  // the real binary.
  payShell?: (args: string[]) => Promise<{ exitCode: number; stdout: Uint8Array; stderr: Uint8Array }>;
}): Promise<Keypair> {
  const args = ["account", "export", opts.name, "-"];

  let result: { exitCode: number; stdout: Uint8Array; stderr: Uint8Array };
  if (opts.payShell) {
    result = await opts.payShell(args);
  } else {
    result = await runPayCapture(args);
  }

  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    throw new Error(
      `pay account export ${opts.name} - exited ${result.exitCode}` +
        (stderr ? `: ${stderr}` : ""),
    );
  }

  const stdout = new TextDecoder().decode(result.stdout).trim();
  // pay's stdout is a JSON byte array; keypairFromInput accepts that format
  // directly (parseSecretKeyInput's first branch).
  try {
    return keypairFromInput(stdout);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`pay account export returned unparseable keypair: ${msg}`);
  }
}

/**
 * Spawn `pay <args>` with stdin/stderr inherited (so a Touch ID prompt or
 * passphrase request reaches the user's terminal) and stdout captured. The
 * pay-shell module already does this for the run-pay flow, but that wrapper
 * tees stdout to the user's tty too — we don't want that here because the
 * stdout IS the keypair we're parsing.
 */
async function runPayCapture(args: string[]): Promise<{
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}> {
  return await new Promise((resolve, reject) => {
    const proc = spawn("pay", args, { stdio: ["inherit", "pipe", "pipe"] });
    const stdoutChunks: Uint8Array[] = [];
    const stderrChunks: Uint8Array[] = [];
    proc.stdout?.on("data", (c: Buffer) => stdoutChunks.push(new Uint8Array(c)));
    proc.stderr?.on("data", (c: Buffer) => stderrChunks.push(new Uint8Array(c)));
    proc.on("error", reject);
    proc.on("close", (code) => {
      const concat = (chunks: Uint8Array[]) => {
        const len = chunks.reduce((n, c) => n + c.byteLength, 0);
        const out = new Uint8Array(len);
        let off = 0;
        for (const c of chunks) {
          out.set(c, off);
          off += c.byteLength;
        }
        return out;
      };
      resolve({
        exitCode: code ?? 0,
        stdout: concat(stdoutChunks),
        stderr: concat(stderrChunks),
      });
    });
  });
}

export type UnifiedWalletSource = "pay" | "env";

export interface UnifiedWalletResult {
  keypair: Keypair;
  source: UnifiedWalletSource;
  /**
   * The pay account this wallet was sourced from, when available. Useful for
   * surfacing the pubkey + name in error messages and the [pact] summary.
   */
  payAccount?: PayActiveAccount;
}

/**
 * Resolve a signing keypair for the `pact pay` codepath, preferring pay's
 * active account.
 *
 * Resolution order:
 *   1. `PACT_PRIVATE_KEY` env var (explicit override always wins — useful in
 *      CI, headless runners, automation).
 *   2. Pay's active account on the given cluster, via `pay account export
 *      <name> -`. Triggers a Touch ID prompt on macOS the first time per
 *      session.
 *
 * Throws when neither path resolves a key. The error message tells the user
 * exactly how to fix it.
 */
export async function loadUnifiedWallet(opts: {
  cluster: "mainnet" | "devnet" | "testnet" | "localnet";
  // Test overrides.
  accountsPath?: string;
  payShell?: (args: string[]) => Promise<{
    exitCode: number;
    stdout: Uint8Array;
    stderr: Uint8Array;
  }>;
}): Promise<UnifiedWalletResult> {
  // 1. Env-var override.
  const env = process.env.PACT_PRIVATE_KEY;
  if (env) {
    return { keypair: keypairFromInput(env), source: "env" };
  }

  // 2. Pay's active account.
  const account = resolvePayActiveAccount({
    cluster: opts.cluster,
    accountsPath: opts.accountsPath,
  });
  if (!account) {
    throw new Error(
      `pact pay needs a wallet. Either:\n` +
        `  - Set up pay (https://pay.sh) and create a ${opts.cluster} account, OR\n` +
        `  - Set PACT_PRIVATE_KEY to a base58 secret key, JSON byte-array, or keypair path.`,
    );
  }

  const keypair = await exportPayKeypair({
    name: account.name,
    payShell: opts.payShell,
  });

  // Sanity check: pay's recorded pubkey should match the exported keypair's
  // public key. A mismatch means accounts.yml is stale relative to the
  // keystore — surface clearly rather than signing with a different key
  // than the user thinks.
  const derivedPubkey = keypair.publicKey.toBase58();
  if (derivedPubkey !== account.pubkey) {
    throw new Error(
      `pay account ${account.name} pubkey mismatch: accounts.yml has ${account.pubkey} ` +
        `but the keypair exports to ${derivedPubkey}. Re-run \`pay account list\` to sync.`,
    );
  }

  return { keypair, source: "pay", payAccount: account };
}
