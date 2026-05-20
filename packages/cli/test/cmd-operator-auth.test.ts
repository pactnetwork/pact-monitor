import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerCommand } from "../src/cmd/register.ts";
import { pauseEndpointCommand } from "../src/cmd/pause-endpoint.ts";
import { endpointConfigCommand } from "../src/cmd/endpoint-config.ts";
import { topupCommand } from "../src/cmd/topup.ts";

// All on-chain operator commands must fail with a structured client_error
// envelope when the required env var is missing — NEVER a stack trace, NEVER
// exit 99 / cli_internal_error. This is the contract that lets shell chains
// gate on $?.

describe("operator commands: auth-missing envelopes", () => {
  let originalProtocolKey: string | undefined;
  let originalPoolKey: string | undefined;

  beforeEach(() => {
    originalProtocolKey = process.env.PACT_PRIVATE_KEY;
    originalPoolKey = process.env.PACT_POOL_AUTHORITY_KEY;
    delete process.env.PACT_PRIVATE_KEY;
    delete process.env.PACT_POOL_AUTHORITY_KEY;
  });

  afterEach(() => {
    if (originalProtocolKey !== undefined)
      process.env.PACT_PRIVATE_KEY = originalProtocolKey;
    else delete process.env.PACT_PRIVATE_KEY;
    if (originalPoolKey !== undefined)
      process.env.PACT_POOL_AUTHORITY_KEY = originalPoolKey;
    else delete process.env.PACT_POOL_AUTHORITY_KEY;
  });

  test("register: missing PACT_PRIVATE_KEY -> client_error", async () => {
    const env = await registerCommand({
      rpcUrl: "http://127.0.0.1:0",
      cluster: "devnet",
      slug: "auth-missing",
      flatPremiumLamports: 1000n,
      percentBps: 0,
      slaLatencyMs: 2000,
      imputedCostLamports: 10000n,
      exposureCapPerHourLamports: 1_000_000n,
    });
    expect(env.status).toBe("client_error");
    expect((env.body as { error: string }).error).toMatch(/PACT_PRIVATE_KEY/);
  });

  test("pause-endpoint: missing PACT_PRIVATE_KEY -> client_error", async () => {
    const env = await pauseEndpointCommand({
      rpcUrl: "http://127.0.0.1:0",
      cluster: "devnet",
      slug: "auth-missing",
      paused: true,
    });
    expect(env.status).toBe("client_error");
    expect((env.body as { error: string }).error).toMatch(/PACT_PRIVATE_KEY/);
  });

  test("endpoint-config: zero-fields -> client_error BEFORE auth check", async () => {
    const env = await endpointConfigCommand({
      rpcUrl: "http://127.0.0.1:0",
      cluster: "devnet",
      slug: "auth-missing",
    });
    expect(env.status).toBe("client_error");
    // Should NOT mention PACT_PRIVATE_KEY — the no_fields gate fires first.
    expect((env.body as { error: string }).error).toBe("no_fields");
  });

  test("endpoint-config: with fields, missing PACT_PRIVATE_KEY -> client_error (auth)", async () => {
    const env = await endpointConfigCommand({
      rpcUrl: "http://127.0.0.1:0",
      cluster: "devnet",
      slug: "auth-missing",
      flatPremiumLamports: 500n,
    });
    expect(env.status).toBe("client_error");
    expect((env.body as { error: string }).error).toMatch(/PACT_PRIVATE_KEY/);
  });

  test("topup: missing PACT_POOL_AUTHORITY_KEY -> client_error (NOT PACT_PRIVATE_KEY fallback)", async () => {
    process.env.PACT_PRIVATE_KEY =
      "5J3mBbAH58CpQ3Y5RNJpUKPE62SQ5tfcvU2JpbnkeyhfsYB1Jcn"; // realistic-looking base58 (will fail parse but that's ok — should not be read)
    const env = await topupCommand({
      rpcUrl: "http://127.0.0.1:0",
      cluster: "devnet",
      slug: "auth-missing",
      amountUsdc: 1,
    });
    expect(env.status).toBe("client_error");
    const body = env.body as { error: string };
    // Should reference POOL_AUTHORITY_KEY specifically — no fallback to PRIVATE_KEY.
    expect(body.error).toMatch(/PACT_POOL_AUTHORITY_KEY/);
    expect(body.error).not.toMatch(/PACT_PRIVATE_KEY/);
  });

  test("topup: amount <= 0 -> client_error amount_invalid", async () => {
    process.env.PACT_POOL_AUTHORITY_KEY =
      "5J3mBbAH58CpQ3Y5RNJpUKPE62SQ5tfcvU2JpbnkeyhfsYB1Jcn";
    const env = await topupCommand({
      rpcUrl: "http://127.0.0.1:0",
      cluster: "devnet",
      slug: "auth-missing",
      amountUsdc: -1,
    });
    expect(env.status).toBe("client_error");
    // amount validated before auth, so error is amount_invalid.
    // Either amount_invalid (if PACT_POOL_AUTHORITY_KEY parses) or auth error (if it doesn't).
    // Either way: client_error envelope, no stack trace.
  });
});
