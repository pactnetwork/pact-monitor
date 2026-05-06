import { describe, expect, test } from "bun:test";
import { InvalidArgumentError } from "commander";
import {
  parsePositiveFloat,
  parsePositiveInt,
  parseUrlStrict,
  validateClusterStrict,
} from "../src/lib/validators.ts";

describe("validateClusterStrict (B2)", () => {
  test("accepts 'devnet'", () => {
    expect(validateClusterStrict("devnet")).toBe("devnet");
  });

  test("rejects 'mainnet' with InvalidArgumentError", () => {
    expect(() => validateClusterStrict("mainnet")).toThrow(InvalidArgumentError);
  });

  test("rejected message names mainnet gating to Friday harden", () => {
    try {
      validateClusterStrict("mainnet");
      throw new Error("expected throw");
    } catch (err) {
      expect((err as Error).message).toContain("not supported in v0.1.0");
      expect((err as Error).message).toContain("devnet");
    }
  });

  test("rejects arbitrary garbage values", () => {
    expect(() => validateClusterStrict("testnet")).toThrow(InvalidArgumentError);
    expect(() => validateClusterStrict("")).toThrow(InvalidArgumentError);
    expect(() => validateClusterStrict("DEVNET")).toThrow(InvalidArgumentError);
  });
});

describe("--cluster mainnet end-to-end (B2)", () => {
  test("CLI emits client_error envelope on stdout in --json mode", async () => {
    const proc = Bun.spawnSync({
      cmd: ["bun", "src/index.ts", "--json", "--cluster", "mainnet", "balance"],
      cwd: `${import.meta.dir}/..`,
      env: { ...process.env, PACT_CLUSTER: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = proc.stdout.toString().trim();
    expect(stdout.length).toBeGreaterThan(0);
    const env = JSON.parse(stdout);
    expect(env.status).toBe("client_error");
    expect(env.body.error).toContain("devnet");
    // No stack trace should leak (B3 invariant) — body has only `error`.
    expect(Object.keys(env.body)).toEqual(["error"]);
  });

  test("PACT_CLUSTER=mainnet rejected at module load with client_error envelope", async () => {
    const proc = Bun.spawnSync({
      cmd: ["bun", "src/index.ts", "--json", "balance"],
      cwd: `${import.meta.dir}/..`,
      env: { ...process.env, PACT_CLUSTER: "mainnet" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = proc.stdout.toString().trim();
    const env = JSON.parse(stdout);
    expect(env.status).toBe("client_error");
    expect(env.body.error).toContain("PACT_CLUSTER=mainnet");
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
