import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { InvalidArgumentError } from "commander";
import {
  parsePositiveFloat,
  parsePositiveInt,
  parseUrlStrict,
  validateClusterStrict,
} from "../src/lib/validators.ts";

describe("validateClusterStrict (mainnet-only + gate)", () => {
  const originalEnabled = process.env.PACT_MAINNET_ENABLED;
  beforeEach(() => {
    delete process.env.PACT_MAINNET_ENABLED;
  });
  afterEach(() => {
    if (originalEnabled === undefined) delete process.env.PACT_MAINNET_ENABLED;
    else process.env.PACT_MAINNET_ENABLED = originalEnabled;
  });

  test("rejects 'devnet' — v0.1.0 is mainnet-only", () => {
    expect(() => validateClusterStrict("devnet")).toThrow(InvalidArgumentError);
  });

  test("rejects 'mainnet' when PACT_MAINNET_ENABLED is not '1'", () => {
    expect(() => validateClusterStrict("mainnet")).toThrow(InvalidArgumentError);
  });

  test("rejection message for mainnet points at the PACT_MAINNET_ENABLED gate", () => {
    try {
      validateClusterStrict("mainnet");
      throw new Error("expected throw");
    } catch (err) {
      expect((err as Error).message).toContain("PACT_MAINNET_ENABLED");
      expect((err as Error).message).toContain("closed beta");
    }
  });

  test("accepts 'mainnet' when PACT_MAINNET_ENABLED=1", () => {
    process.env.PACT_MAINNET_ENABLED = "1";
    expect(validateClusterStrict("mainnet")).toBe("mainnet");
  });

  test("rejects arbitrary garbage values", () => {
    expect(() => validateClusterStrict("testnet")).toThrow(InvalidArgumentError);
    expect(() => validateClusterStrict("")).toThrow(InvalidArgumentError);
    expect(() => validateClusterStrict("DEVNET")).toThrow(InvalidArgumentError);
  });
});

describe("--cluster mainnet end-to-end (gate enforcement)", () => {
  function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
    const base = { ...process.env } as Record<string, string>;
    delete base.PACT_MAINNET_ENABLED;
    base.PACT_CLUSTER = "";
    return { ...base, ...extra };
  }

  test("--cluster mainnet without PACT_MAINNET_ENABLED → client_error envelope", async () => {
    const proc = Bun.spawnSync({
      cmd: ["bun", "src/index.ts", "--json", "--cluster", "mainnet", "balance"],
      cwd: `${import.meta.dir}/..`,
      env: cleanEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = proc.stdout.toString().trim();
    expect(stdout.length).toBeGreaterThan(0);
    const env = JSON.parse(stdout);
    expect(env.status).toBe("client_error");
    expect(env.body.error).toContain("PACT_MAINNET_ENABLED");
    // No stack trace should leak (B3 invariant) — body has only `error`.
    expect(Object.keys(env.body)).toEqual(["error"]);
  });

  test("PACT_CLUSTER=mainnet rejected at module load when env gate is closed", async () => {
    const proc = Bun.spawnSync({
      cmd: ["bun", "src/index.ts", "--json", "balance"],
      cwd: `${import.meta.dir}/..`,
      env: cleanEnv({ PACT_CLUSTER: "mainnet" }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = proc.stdout.toString().trim();
    const env = JSON.parse(stdout);
    expect(env.status).toBe("client_error");
    expect(env.body.error).toContain("PACT_CLUSTER=mainnet");
    expect(env.body.error).toContain("PACT_MAINNET_ENABLED");
  });

  test("--cluster devnet → client_error (v0.1.0 is mainnet-only)", async () => {
    const proc = Bun.spawnSync({
      cmd: ["bun", "src/index.ts", "--json", "--cluster", "devnet", "balance"],
      cwd: `${import.meta.dir}/..`,
      env: cleanEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = proc.stdout.toString().trim();
    const env = JSON.parse(stdout);
    expect(env.status).toBe("client_error");
    expect(env.body.error).toContain("not supported");
  });

  test("bare `pact balance` (no --cluster) without gate → client_error envelope", async () => {
    // Default --cluster is mainnet; commander does not run the validator on
    // defaults, so the gate is enforced inside resolveClusterConfig at action
    // time. Smoke-tests that path so a first-invocation accident can't reach
    // mainnet.
    const proc = Bun.spawnSync({
      cmd: ["bun", "src/index.ts", "--json", "--project", "test", "balance"],
      cwd: `${import.meta.dir}/..`,
      env: cleanEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = proc.stdout.toString().trim();
    const env = JSON.parse(stdout);
    expect(env.status).toBe("client_error");
    expect(env.body.error).toContain("PACT_MAINNET_ENABLED");
  });
});

describe("parsePositiveFloat (H4)", () => {
  test("accepts positive finite floats", () => {
    expect(parsePositiveFloat("5")).toBe(5);
    expect(parsePositiveFloat("5.5")).toBe(5.5);
    expect(parsePositiveFloat("0.0001")).toBe(0.0001);
  });

  test("rejects NaN/Infinity/non-numeric", () => {
    expect(() => parsePositiveFloat("abc")).toThrow(InvalidArgumentError);
    expect(() => parsePositiveFloat("")).toThrow(InvalidArgumentError);
    expect(() => parsePositiveFloat("Infinity")).toThrow(InvalidArgumentError);
    expect(() => parsePositiveFloat("NaN")).toThrow(InvalidArgumentError);
  });

  test("rejects zero and negatives", () => {
    expect(() => parsePositiveFloat("0")).toThrow(InvalidArgumentError);
    expect(() => parsePositiveFloat("-1")).toThrow(InvalidArgumentError);
    expect(() => parsePositiveFloat("-0.5")).toThrow(InvalidArgumentError);
  });
});

describe("parsePositiveInt (H4)", () => {
  test("accepts positive integers", () => {
    expect(parsePositiveInt("1")).toBe(1);
    expect(parsePositiveInt("30")).toBe(30);
    expect(parsePositiveInt("999999")).toBe(999999);
  });

  test("rejects decimals (no silent truncation)", () => {
    expect(() => parsePositiveInt("1.5")).toThrow(InvalidArgumentError);
    expect(() => parsePositiveInt("0.1")).toThrow(InvalidArgumentError);
  });

  test("rejects zero, negatives, garbage", () => {
    expect(() => parsePositiveInt("0")).toThrow(InvalidArgumentError);
    expect(() => parsePositiveInt("-5")).toThrow(InvalidArgumentError);
    expect(() => parsePositiveInt("abc")).toThrow(InvalidArgumentError);
    expect(() => parsePositiveInt("")).toThrow(InvalidArgumentError);
    expect(() => parsePositiveInt("12abc")).toThrow(InvalidArgumentError);
  });
});

describe("parseUrlStrict (H4)", () => {
  test("accepts absolute URLs", () => {
    expect(parseUrlStrict("https://api.helius.xyz/v0/balances")).toBe(
      "https://api.helius.xyz/v0/balances",
    );
    expect(parseUrlStrict("http://localhost:3000/foo")).toBe(
      "http://localhost:3000/foo",
    );
  });

  test("rejects bare hostnames and malformed strings", () => {
    expect(() => parseUrlStrict("not a url")).toThrow(InvalidArgumentError);
    expect(() => parseUrlStrict("api.helius.xyz")).toThrow(InvalidArgumentError);
    expect(() => parseUrlStrict("")).toThrow(InvalidArgumentError);
    expect(() => parseUrlStrict("///")).toThrow(InvalidArgumentError);
  });
});

describe("CLI coercion end-to-end (H4)", () => {
  test("garbage URL → client_error envelope (not cli_internal_error)", async () => {
    const proc = Bun.spawnSync({
      cmd: ["bun", "src/index.ts", "--json", "not-a-url"],
      cwd: `${import.meta.dir}/..`,
      env: { ...process.env, PACT_CLUSTER: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = proc.stdout.toString().trim();
    const env = JSON.parse(stdout);
    expect(env.status).toBe("client_error");
    expect(env.status).not.toBe("cli_internal_error");
    expect(env.body.error).toContain("URL");
  });

  test("approve -5 → client_error envelope", async () => {
    const proc = Bun.spawnSync({
      cmd: ["bun", "src/index.ts", "--json", "approve", "-5"],
      cwd: `${import.meta.dir}/..`,
      env: { ...process.env, PACT_CLUSTER: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = proc.stdout.toString().trim();
    const env = JSON.parse(stdout);
    expect(env.status).toBe("client_error");
    expect(env.status).not.toBe("cli_internal_error");
  });

  test("approve abc → client_error envelope", async () => {
    const proc = Bun.spawnSync({
      cmd: ["bun", "src/index.ts", "--json", "approve", "abc"],
      cwd: `${import.meta.dir}/..`,
      env: { ...process.env, PACT_CLUSTER: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = proc.stdout.toString().trim();
    const env = JSON.parse(stdout);
    expect(env.status).toBe("client_error");
    expect(env.status).not.toBe("cli_internal_error");
    expect(env.body.error).toContain("greater than 0");
  });

  test("--timeout abc → client_error envelope", async () => {
    const proc = Bun.spawnSync({
      cmd: ["bun", "src/index.ts", "--json", "--timeout", "abc", "https://example.com/"],
      cwd: `${import.meta.dir}/..`,
      env: { ...process.env, PACT_CLUSTER: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = proc.stdout.toString().trim();
    const env = JSON.parse(stdout);
    expect(env.status).toBe("client_error");
    expect(env.status).not.toBe("cli_internal_error");
    expect(env.body.error).toContain("positive integer");
  });
});
