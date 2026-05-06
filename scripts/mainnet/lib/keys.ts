import { Keypair } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

/**
 * Resolve a keypair path. Accepts ~/-prefixed paths and absolute paths.
 */
export function resolveKeyPath(p: string): string {
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

/**
 * Read a Solana keypair JSON file. Throws with a helpful message if missing.
 */
export function readKeypair(path: string): Keypair {
  const full = resolveKeyPath(path);
  let raw: string;
  try {
    raw = readFileSync(full, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new Error(
        `Keypair file not found: ${full}\n` +
          `Generate with: solana-keygen new --no-bip39-passphrase --silent --outfile ${full}`,
      );
    }
    throw e;
  }
  const bytes = JSON.parse(raw);
  if (!Array.isArray(bytes) || bytes.length !== 64) {
    throw new Error(
      `Invalid keypair file at ${full}: expected JSON array of 64 bytes, got ${bytes.length ?? "non-array"}`,
    );
  }
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}
