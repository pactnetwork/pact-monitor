import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { loadOrCreateWallet, walletPath, parseSecretKeyInput, keypairFromInput } from "../src/lib/wallet.ts";
import { writeFileSync } from "node:fs";

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

  test("env override accepts a JSON byte-array keypair (solana-keygen format)", () => {
    const kp = Keypair.generate();
    process.env.PACT_PRIVATE_KEY = JSON.stringify(Array.from(kp.secretKey));
    const result = loadOrCreateWallet({ configDir: dir });
    expect(result.source).toBe("env");
    expect(result.keypair.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
    expect(existsSync(walletPath(dir))).toBe(false);
  });

  test("env override accepts a path to a base58 keypair file", () => {
    const kp = Keypair.generate();
    const file = join(dir, "b58.key");
    writeFileSync(file, bs58.encode(kp.secretKey));
    process.env.PACT_PRIVATE_KEY = file;
    const result = loadOrCreateWallet({ configDir: dir });
    expect(result.source).toBe("env");
    expect(result.keypair.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  test("env override accepts a path to a JSON byte-array keypair file", () => {
    const kp = Keypair.generate();
    const file = join(dir, "kp.json");
    writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)));
    process.env.PACT_PRIVATE_KEY = file;
    const result = loadOrCreateWallet({ configDir: dir });
    expect(result.source).toBe("env");
    expect(result.keypair.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  test("keypairPath option takes precedence over PACT_PRIVATE_KEY", () => {
    const envKp = Keypair.generate();
    const fileKp = Keypair.generate();
    process.env.PACT_PRIVATE_KEY = bs58.encode(envKp.secretKey);
    const file = join(dir, "explicit.json");
    writeFileSync(file, JSON.stringify(Array.from(fileKp.secretKey)));
    const result = loadOrCreateWallet({ configDir: dir, keypairPath: file });
    expect(result.keypair.publicKey.toBase58()).toBe(fileKp.publicKey.toBase58());
  });

  test("garbage env var throws the clear error, not 'Non-base58 character'", () => {
    process.env.PACT_PRIVATE_KEY = "this-is-not-base58-or-the-right-length!!!";
    expect(() => loadOrCreateWallet({ configDir: dir })).toThrow(
      /base58-encoded secret key, a JSON byte-array keypair, or a path to a keypair file/,
    );
  });

  describe("parseSecretKeyInput", () => {
    test("base58 secret key round-trips", () => {
      const kp = Keypair.generate();
      const bytes = parseSecretKeyInput(bs58.encode(kp.secretKey));
      expect(bytes.length).toBe(64);
      expect(Keypair.fromSecretKey(bytes).publicKey.toBase58()).toBe(
        kp.publicKey.toBase58(),
      );
    });

    test("JSON byte array round-trips", () => {
      const kp = Keypair.generate();
      const bytes = parseSecretKeyInput(JSON.stringify(Array.from(kp.secretKey)));
      expect(bytes.length).toBe(64);
      expect(keypairFromInput(JSON.stringify(Array.from(kp.secretKey))).publicKey.toBase58()).toBe(
        kp.publicKey.toBase58(),
      );
    });

    test("whitespace is tolerated", () => {
      const kp = Keypair.generate();
      const bytes = parseSecretKeyInput("  " + bs58.encode(kp.secretKey) + "\n");
      expect(bytes.length).toBe(64);
    });

    test("32-byte (seed-only) JSON array is rejected with the clear error", () => {
      const seed = JSON.stringify(Array.from(Keypair.generate().secretKey.slice(0, 32)));
      expect(() => parseSecretKeyInput(seed)).toThrow(/JSON byte-array keypair/);
    });

    test("a 64-byte length is enforced for base58 input", () => {
      // bs58 of an arbitrary 32-byte buffer decodes fine but is the wrong length.
      const short = bs58.encode(Buffer.alloc(32, 7));
      expect(() => parseSecretKeyInput(short)).toThrow(/keypair file/);
    });

    test("garbage throws a clear error", () => {
      expect(() => parseSecretKeyInput("!!! definitely not valid !!!")).toThrow(
        /base58-encoded secret key, a JSON byte-array keypair, or a path to a keypair file/,
      );
      expect(() => parseSecretKeyInput("!!! definitely not valid !!!")).not.toThrow(
        /Non-base58 character/,
      );
    });

    test("empty input throws a clear error", () => {
      expect(() => parseSecretKeyInput("   ")).toThrow(/keypair file/);
    });
  });

});
