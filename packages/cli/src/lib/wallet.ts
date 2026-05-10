import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
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

export function loadOrCreateWallet(opts: { configDir: string }): WalletLoadResult {
  const env = process.env.PACT_PRIVATE_KEY;
  if (env) {
    const secret = bs58.decode(env);
    if (secret.length !== 64) {
      throw new Error("PACT_PRIVATE_KEY must be a 64-byte base58 secretKey");
    }
    return {
      keypair: Keypair.fromSecretKey(secret),
      created: false,
      source: "env",
    };
  }

  const path = walletPath(opts.configDir);
  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { secretKey: string };
    const secret = bs58.decode(raw.secretKey);
    return {
      keypair: Keypair.fromSecretKey(secret),
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
