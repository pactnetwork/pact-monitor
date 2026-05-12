import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

export interface WalletLoadResult {
  keypair: Keypair;
  created: boolean;
  source: "disk" | "env";
}

export function walletPath(configDir: string): string {
  return join(configDir, "wallet.json");
}

const SECRET_KEY_ERROR =
  "PACT_PRIVATE_KEY must be a base58-encoded secret key, a JSON byte-array keypair, or a path to a keypair file";

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function isRegularFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function bytesFromJsonArray(input: string): Uint8Array | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return null;
  }
  if (
    Array.isArray(parsed) &&
    parsed.every(
      (n) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 255,
    )
  ) {
    // Exact-length validation happens in parseSecretKeyInput so a wrong-length
    // array (e.g. a 32-byte seed) yields the clear error rather than a crash.
    return Uint8Array.from(parsed as number[]);
  }
  return null;
}

/**
 * Parse a secret-key input that may be:
 *  - a base58-encoded 64-byte secret key (Phantom-style export);
 *  - a JSON byte array [n, n, …] of length 64 (the `solana-keygen` keypair
 *    file format — 32 secret + 32 public bytes);
 *  - a path to a readable file containing either of the above (e.g.
 *    `PACT_PRIVATE_KEY=~/keys/agent.json`).
 *
 * Always returns a 64-byte Uint8Array suitable for `Keypair.fromSecretKey`.
 * Throws a clear error (not the raw "Non-base58 character") on failure.
 *
 * `depth` guards against pathological symlink/file loops.
 */
export function parseSecretKeyInput(input: string, depth = 0): Uint8Array {
  const trimmed = input.trim();
  if (!trimmed) throw new Error(SECRET_KEY_ERROR);

  // 1. JSON byte array (solana-keygen keypair file contents).
  const fromArray = bytesFromJsonArray(trimmed);
  if (fromArray) {
    if (fromArray.length !== 64) throw new Error(SECRET_KEY_ERROR);
    return fromArray;
  }

  // 2. Path to an existing readable file containing either format.
  if (depth < 4) {
    const candidate = expandHome(trimmed);
    if (isRegularFile(candidate)) {
      let contents: string;
      try {
        contents = readFileSync(candidate, "utf8");
      } catch {
        throw new Error(SECRET_KEY_ERROR);
      }
      return parseSecretKeyInput(contents, depth + 1);
    }
  }

  // 3. base58-encoded secret key.
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(trimmed);
  } catch {
    throw new Error(SECRET_KEY_ERROR);
  }
  if (decoded.length !== 64) throw new Error(SECRET_KEY_ERROR);
  return decoded;
}

/** Build a Keypair from any supported secret-key input format. */
export function keypairFromInput(input: string): Keypair {
  return Keypair.fromSecretKey(parseSecretKeyInput(input));
}

export function loadOrCreateWallet(opts: {
  configDir: string;
  /** Explicit keypair file path/contents (from `--keypair`); precedes PACT_PRIVATE_KEY. */
  keypairPath?: string;
}): WalletLoadResult {
  if (opts.keypairPath) {
    return {
      keypair: keypairFromInput(opts.keypairPath),
      created: false,
      source: "env",
    };
  }

  const env = process.env.PACT_PRIVATE_KEY;
  if (env) {
    return {
      keypair: keypairFromInput(env),
      created: false,
      source: "env",
    };
  }

  const path = walletPath(opts.configDir);
  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { secretKey: string };
    return {
      // The disk wallet stores { secretKey: "<base58>" }; route the value
      // through the tolerant parser so a hand-edited wallet.json holding a
      // byte array or file path still works.
      keypair: keypairFromInput(raw.secretKey),
      created: false,
      source: "disk",
    };
  }

  if (!existsSync(opts.configDir)) {
    mkdirSync(opts.configDir, { recursive: true, mode: 0o700 });
  }
  const kp = Keypair.generate();
  writeFileSync(
    path,
    JSON.stringify({ secretKey: bs58.encode(kp.secretKey) }, null, 2),
    { mode: 0o600 },
  );
  chmodSync(path, 0o600);
  return { keypair: kp, created: true, source: "disk" };
}
