import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadOrCreatePolicy,
  recordAutoDeposit,
  canAutoDeposit,
  defaultPolicy,
} from "../src/lib/policy.ts";

describe("policy", () => {
  let dir: string;
  const origEnv = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pact-policy-test-"));
    delete process.env.PACT_AUTO_DEPOSIT_DISABLED;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env = { ...origEnv };
  });

  test("creates policy.yaml on first call with defaults", () => {
    loadOrCreatePolicy({ configDir: dir });
    expect(existsSync(join(dir, "policy.yaml"))).toBe(true);
    const txt = readFileSync(join(dir, "policy.yaml"), "utf8");
    expect(txt).toContain("per_deposit_max_usdc: 1");
    expect(txt).toContain("session_total_max_usdc: 5");
  });

  test("default policy is enabled with caps", () => {
    expect(defaultPolicy.auto_deposit.enabled).toBe(true);
    expect(defaultPolicy.auto_deposit.per_deposit_max_usdc).toBe(1.0);
    expect(defaultPolicy.auto_deposit.session_total_max_usdc).toBe(5.0);
  });

  test("canAutoDeposit accepts under both caps", () => {
    const policy = loadOrCreatePolicy({ configDir: dir });
    const r = canAutoDeposit({
      configDir: dir,
      policy,
      requestedUsdc: 0.5,
    });
    expect(r.allowed).toBe(true);
  });

  test("canAutoDeposit rejects over per-deposit cap", () => {
    const policy = loadOrCreatePolicy({ configDir: dir });
    const r = canAutoDeposit({
      configDir: dir,
      policy,
      requestedUsdc: 1.5,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("per_deposit_exceeded");
  });

  test("canAutoDeposit rejects when session cap would be breached", () => {
    const policy = loadOrCreatePolicy({ configDir: dir });
    recordAutoDeposit({ configDir: dir, amountUsdc: 4.5 });
    const r = canAutoDeposit({
      configDir: dir,
      policy,
      requestedUsdc: 1.0,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("session_total_exceeded");
  });

  test("PACT_AUTO_DEPOSIT_DISABLED forces disable", () => {
    process.env.PACT_AUTO_DEPOSIT_DISABLED = "1";
    const policy = loadOrCreatePolicy({ configDir: dir });
    const r = canAutoDeposit({
      configDir: dir,
      policy,
      requestedUsdc: 0.1,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("env_disabled");
  });

  test("recordAutoDeposit accumulates across calls", () => {
    recordAutoDeposit({ configDir: dir, amountUsdc: 1.0 });
    recordAutoDeposit({ configDir: dir, amountUsdc: 1.5 });
    const txt = readFileSync(join(dir, "auto_deposits_session.json"), "utf8");
    const parsed = JSON.parse(txt);
    expect(parsed.total_usdc).toBe(2.5);
  });
});
