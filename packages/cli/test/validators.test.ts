import { describe, expect, test } from "bun:test";
import { InvalidArgumentError } from "commander";
import { validateClusterStrict } from "../src/lib/validators.ts";

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
