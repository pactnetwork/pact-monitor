import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { loadOrCreateWallet, walletPath } from "../src/lib/wallet.ts";

describe("wallet", () => {
  let dir: string;
  const origEnv = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pact-wallet-test-"));
    delete process.env.PACT_PRIVATE_KEY;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env = { ...origEnv };
  });

  test("creates wallet on first call when missing", () => {
    const result = loadOrCreateWallet({ configDir: dir });
    expect(result.created).toBe(true);
    expect(result.keypair.publicKey).toBeDefined();
    expect(existsSync(walletPath(dir))).toBe(true);
  });

  test("file mode is 0600 after create", () => {
    loadOrCreateWallet({ configDir: dir });
    const mode = statSync(walletPath(dir)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("loads existing wallet on second call", () => {
    const a = loadOrCreateWallet({ configDir: dir });
    const b = loadOrCreateWallet({ configDir: dir });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(a.keypair.publicKey.toBase58()).toBe(b.keypair.publicKey.toBase58());
  });

  test("env override skips disk", () => {
    const kp = Keypair.generate();
    process.env.PACT_PRIVATE_KEY = bs58.encode(kp.secretKey);
    const result = loadOrCreateWallet({ configDir: dir });
    expect(result.created).toBe(false);
    expect(result.source).toBe("env");
    expect(result.keypair.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
    expect(existsSync(walletPath(dir))).toBe(false);
  });

  test("persisted format is base58 secretKey JSON", () => {
    loadOrCreateWallet({ configDir: dir });
    const raw = readFileSync(walletPath(dir), "utf8");
    const parsed = JSON.parse(raw);
    expect(typeof parsed.secretKey).toBe("string");
    expect(bs58.decode(parsed.secretKey).length).toBe(64);
  });
});
