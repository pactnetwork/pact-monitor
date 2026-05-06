/**
 * Keypair I/O helpers — reads / writes solana CLI-format keypair files
 * (JSON arrays of 64 byte secret keys).
 */
import { Keypair } from "@solana/web3.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export function loadOrCreate(path: string): Keypair {
  if (existsSync(path)) return readKeypair(path);
  const kp = Keypair.generate();
  writeKeypair(path, kp);
  return kp;
}

export function readKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export function writeKeypair(path: string, kp: Keypair): void {
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)) + "\n", "utf8");
}
