import { describe, it, expect, vi } from "vitest";
import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import { createPactMerchant } from "../factory.js";

function freshKeypair(): Keypair {
  const pair = nacl.sign.keyPair();
  return Keypair.fromSecretKey(pair.secretKey);
}

describe("merchant.observe", () => {
  it("POSTs to /api/v1/observations with the expected headers + canonical body sig", async () => {
    const signer = freshKeypair();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return {
        status: 200,
        async json() {
          return { accepted: 1, recordId: "rec-1" };
        },
      };
    }) as unknown as typeof fetch;

    const m = await createPactMerchant(
      {
        network: "localnet",
        signer,
        apiKey: "pact_test_key",
        hostname: "api.test.local",
        installSignalHandlers: false,
      },
      { fetchImpl: fakeFetch },
    );

    const result = await m.observe({
      endpoint: "/v1/foo",
      startedAt: 1_717_000_000_000,
      statusCode: 200,
      latencyMs: 12,
      classification: "success",
    });

    expect(result.accepted).toBe(1);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("http://localhost:3001/api/v1/observations");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer pact_test_key");
    expect(headers["X-Pact-Pubkey"]).toBe(signer.publicKey.toBase58());
    expect(typeof headers["X-Pact-Signature"]).toBe("string");
    expect(headers["X-Pact-Signature"].length).toBeGreaterThan(0);

    await m.shutdown();
  });

  it("returns accepted=0 on a 409 dedupe response", async () => {
    const signer = freshKeypair();
    const fakeFetch = (async () => {
      return {
        status: 200,
        async json() {
          return { accepted: 0 };
        },
      };
    }) as unknown as typeof fetch;
    const m = await createPactMerchant(
      {
        network: "localnet",
        signer,
        apiKey: "k",
        hostname: "api.test.local",
        installSignalHandlers: false,
      },
      { fetchImpl: fakeFetch },
    );
    const result = await m.observe({
      agentPubkey: signer.publicKey.toBase58(),
      endpoint: "/v1/bar",
      startedAt: 1_717_000_000_000,
      statusCode: 200,
      latencyMs: 12,
      classification: "success",
    });
    expect(result.accepted).toBe(0);
    await m.shutdown();
  });
});
