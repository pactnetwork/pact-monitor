import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadEvmWallet,
  parseEvmPrivateKeyInput,
  sharedEvmWalletPath,
  chainEvmWalletPath,
} from "../src/lib/evm-wallet.ts";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const NET = "arc-testnet";
const OTHER_NET = "base-sepolia";

describe("evm-wallet", () => {
  let dir: string;
  const origEnv = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pact-evm-wallet-test-"));
    delete process.env.PACT_EVM_PRIVATE_KEY;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env = { ...origEnv };
  });

  test("fresh-gen creates shared wallet file with 0600 mode and {address,privateKey}", () => {
    const result = loadEvmWallet({ configDir: dir, network: NET });
    expect(result.created).toBe(true);
    expect(result.source).toBe("disk");
    expect(result.path).toBe(sharedEvmWalletPath(dir));
    expect(result.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(result.privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);

    const mode = statSync(result.path).mode & 0o777;
    expect(mode).toBe(0o600);

    const raw = JSON.parse(readFileSync(result.path, "utf8")) as {
      address: string;
      privateKey: string;
    };
    expect(raw.address).toBe(result.address);
    expect(raw.privateKey).toBe(result.privateKey);
    // Address derived from the persisted private key must round-trip.
    const derived = privateKeyToAccount(raw.privateKey as `0x${string}`);
    expect(derived.address).toBe(result.address as `0x${string}`);
  });

  test("re-use reads existing shared file unchanged", () => {
    const a = loadEvmWallet({ configDir: dir, network: NET });
    const b = loadEvmWallet({ configDir: dir, network: NET });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.source).toBe("disk");
    expect(b.address).toBe(a.address);
    expect(b.privateKey).toBe(a.privateKey);
  });

  test("per-chain override file beats shared file", () => {
    loadEvmWallet({ configDir: dir, network: NET });
    const overridePk = generatePrivateKey();
    const overrideAddr = privateKeyToAccount(overridePk).address;
    writeFileSync(
      chainEvmWalletPath(dir, NET),
      JSON.stringify({ address: overrideAddr, privateKey: overridePk }),
    );
    const result = loadEvmWallet({ configDir: dir, network: NET });
    expect(result.created).toBe(false);
    expect(result.source).toBe("disk");
    expect(result.path).toBe(chainEvmWalletPath(dir, NET));
    expect(result.address).toBe(overrideAddr);
    expect(result.privateKey).toBe(overridePk);
  });

  test("per-chain override is scoped to that network only", () => {
    const shared = loadEvmWallet({ configDir: dir, network: NET });
    const overridePk = generatePrivateKey();
    writeFileSync(
      chainEvmWalletPath(dir, NET),
      JSON.stringify({
        address: privateKeyToAccount(overridePk).address,
        privateKey: overridePk,
      }),
    );
    const onArc = loadEvmWallet({ configDir: dir, network: NET });
    const onBase = loadEvmWallet({ configDir: dir, network: OTHER_NET });
    expect(onArc.privateKey).toBe(overridePk);
    expect(onBase.privateKey).toBe(shared.privateKey);
  });

  test("PACT_EVM_PRIVATE_KEY env beats disk", () => {
    loadEvmWallet({ configDir: dir, network: NET });
    const envPk = generatePrivateKey();
    process.env.PACT_EVM_PRIVATE_KEY = envPk;
    const result = loadEvmWallet({ configDir: dir, network: NET });
    expect(result.source).toBe("env");
    expect(result.created).toBe(false);
    expect(result.privateKey).toBe(envPk);
  });

  test("envOverride argument wins over process.env (explicit injection)", () => {
    const envPk = generatePrivateKey();
    process.env.PACT_EVM_PRIVATE_KEY = generatePrivateKey();
    const result = loadEvmWallet({
      configDir: dir,
      network: NET,
      envOverride: envPk,
    });
    expect(result.source).toBe("env");
    expect(result.privateKey).toBe(envPk);
  });

  test("--keypair (keypairPath) wins over env and disk", () => {
    loadEvmWallet({ configDir: dir, network: NET });
    process.env.PACT_EVM_PRIVATE_KEY = generatePrivateKey();
    const flagPk = generatePrivateKey();
    const result = loadEvmWallet({
      configDir: dir,
      network: NET,
      keypairPath: flagPk,
    });
    expect(result.source).toBe("flag");
    expect(result.privateKey).toBe(flagPk);
  });

  test("--keypair accepts a path to a JSON wallet file", () => {
    const filePk = generatePrivateKey();
    const fileAddr = privateKeyToAccount(filePk).address;
    const file = join(dir, "explicit-key.json");
    writeFileSync(file, JSON.stringify({ address: fileAddr, privateKey: filePk }));
    const result = loadEvmWallet({
      configDir: dir,
      network: NET,
      keypairPath: file,
    });
    expect(result.source).toBe("flag");
    expect(result.address).toBe(fileAddr);
    expect(result.privateKey).toBe(filePk);
  });

  test("created:true only on the first gen — second call is created:false", () => {
    expect(existsSync(sharedEvmWalletPath(dir))).toBe(false);
    const a = loadEvmWallet({ configDir: dir, network: NET });
    const b = loadEvmWallet({ configDir: dir, network: NET });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
  });

  describe("parseEvmPrivateKeyInput", () => {
    test("accepts 0x-prefixed hex", () => {
      const pk = generatePrivateKey();
      expect(parseEvmPrivateKeyInput(pk)).toBe(pk);
    });

    test("accepts bare hex (adds 0x)", () => {
      const pk = generatePrivateKey();
      const bare = pk.slice(2);
      expect(parseEvmPrivateKeyInput(bare)).toBe(pk);
    });

    test("accepts {privateKey} JSON object", () => {
      const pk = generatePrivateKey();
      expect(
        parseEvmPrivateKeyInput(JSON.stringify({ privateKey: pk, address: "0x0" })),
      ).toBe(pk);
    });

    test("garbage input throws the clear error", () => {
      expect(() => parseEvmPrivateKeyInput("not-a-key")).toThrow(
        /0x-prefixed 32-byte hex private key/,
      );
    });

    test("empty input throws the clear error", () => {
      expect(() => parseEvmPrivateKeyInput("   ")).toThrow(
        /0x-prefixed 32-byte hex private key/,
      );
    });
  });
});
