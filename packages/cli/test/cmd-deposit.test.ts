import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dump as yamlDump } from "js-yaml";
import { depositCommand } from "../src/cmd/deposit.ts";
import type { Policy } from "../src/lib/policy.ts";

describe("cmd/deposit: policy enforcement", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pact-deposit-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns auto_deposit_capped when per_deposit_max_usdc exceeded", async () => {
    const policy: Policy = {
      auto_deposit: {
        enabled: true,
        per_deposit_max_usdc: 0.5,
        session_total_max_usdc: 5.0,
      },
    };
    writeFileSync(join(dir, "policy.yaml"), yamlDump(policy));

    const env = await depositCommand({
      amountUsdc: 1.0,
      configDir: dir,
      rpcUrl: "https://api.devnet.solana.com",
      cluster: "devnet",
    });

    expect(env.status).toBe("auto_deposit_capped");
    const body = env.body as { reason: string; per_deposit_max_usdc: number };
    expect(body.reason).toBe("per_deposit_exceeded");
    expect(body.per_deposit_max_usdc).toBe(0.5);
  });

  test("records deposit and returns ok when policy allows", async () => {
    const policy: Policy = {
      auto_deposit: {
        enabled: true,
        per_deposit_max_usdc: 1.0,
        session_total_max_usdc: 5.0,
      },
    };
    writeFileSync(join(dir, "policy.yaml"), yamlDump(policy));

    let depositCalled = false;
    const env = await depositCommand({
      amountUsdc: 0.1,
      configDir: dir,
      rpcUrl: "https://api.devnet.solana.com",
      cluster: "devnet",
      submitDeposit: async (_amount: number) => {
        depositCalled = true;
        return { tx_signature: "mock-sig-123", confirmation_pending: false };
      },
    });

    expect(env.status).toBe("ok");
    expect(depositCalled).toBe(true);

    // Verify recordAutoDeposit updated the session total
    const sessionPath = join(dir, "auto_deposits_session.json");
    expect(existsSync(sessionPath)).toBe(true);
    const session = JSON.parse(readFileSync(sessionPath, "utf8"));
    expect(session.total_usdc).toBeCloseTo(0.1);
  });
});
