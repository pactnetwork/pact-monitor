import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { pauseCommand } from "../src/cmd/pause.ts";

describe("cmd/pause: protocol kill switch (admin)", () => {
  const originalGate = process.env.PACT_MAINNET_ENABLED;
  const originalKey = process.env.PACT_PRIVATE_KEY;

  beforeEach(() => {
    process.env.PACT_MAINNET_ENABLED = "1";
  });

  afterEach(() => {
    if (originalGate === undefined) delete process.env.PACT_MAINNET_ENABLED;
    else process.env.PACT_MAINNET_ENABLED = originalGate;
    if (originalKey === undefined) delete process.env.PACT_PRIVATE_KEY;
    else process.env.PACT_PRIVATE_KEY = originalKey;
  });

  test("returns client_error when PACT_PRIVATE_KEY missing", async () => {
    delete process.env.PACT_PRIVATE_KEY;
    const env = await pauseCommand({ rpcUrl: "https://example/rpc" });
    expect(env.status).toBe("client_error");
    const body = env.body as { error: string };
    expect(body.error).toContain("PACT_PRIVATE_KEY");
  });

  test("returns client_error when PACT_PRIVATE_KEY is malformed", async () => {
    process.env.PACT_PRIVATE_KEY = "this-is-not-base58-or-the-right-length";
    const env = await pauseCommand({ rpcUrl: "https://example/rpc" });
    expect(env.status).toBe("client_error");
    const body = env.body as { error: string };
    expect(body.error.toLowerCase()).toContain("base58");
  });

  test("returns client_error when PACT_MAINNET_ENABLED is closed", async () => {
    delete process.env.PACT_MAINNET_ENABLED;
    process.env.PACT_PRIVATE_KEY = bs58.encode(Keypair.generate().secretKey);
    const env = await pauseCommand({ rpcUrl: "https://example/rpc" });
    expect(env.status).toBe("client_error");
    const body = env.body as { error: string };
    expect(body.error).toContain("PACT_MAINNET_ENABLED");
  });

  test("happy path: returns ok envelope with mocked submitter", async () => {
    const authority = Keypair.generate();
    process.env.PACT_PRIVATE_KEY = bs58.encode(authority.secretKey);

    let submitted: unknown = null;
    const env = await pauseCommand({
      rpcUrl: "https://example/rpc",
      submitPause: async (params) => {
        submitted = {
          authority: params.authority.publicKey.toBase58(),
          programId: params.programId.toBase58(),
          protocolConfigPda: params.protocolConfigPda.toBase58(),
        };
        return {
          tx_signature: "mock-pause-sig-abc123",
          confirmation_pending: false,
        };
      },
    });

    expect(env.status).toBe("ok");
    const body = env.body as {
      action: string;
      tx_signature: string;
      protocol_config: string;
      authority: string;
    };
    expect(body.action).toBe("pause");
    expect(body.tx_signature).toBe("mock-pause-sig-abc123");
    expect(body.authority).toBe(authority.publicKey.toBase58());
    expect(body.protocol_config.length).toBeGreaterThan(30);
    expect(submitted).not.toBeNull();
  });
});
