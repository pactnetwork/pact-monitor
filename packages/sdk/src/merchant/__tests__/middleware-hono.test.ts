import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import { Hono } from "hono";
import { createPactMerchant } from "../factory.js";
import { verifyProxiedBy } from "../attestation.js";

function freshKeypair(): Keypair {
  return Keypair.fromSecretKey(nacl.sign.keyPair().secretKey);
}

describe("hono middleware", () => {
  it("stamps attestation headers and posts an observation via app.request()", async () => {
    const merchantSigner = freshKeypair();
    const agentPubkey = freshKeypair().publicKey.toBase58();
    const observations: unknown[] = [];

    const fakeFetch = (async (url: string, init: RequestInit) => {
      if (typeof url === "string" && url.includes("/api/v1/observations")) {
        observations.push({ url, body: JSON.parse(init.body as string) });
      }
      return { status: 200, async json() { return { accepted: 1 }; } };
    }) as unknown as typeof fetch;

    const m = await createPactMerchant(
      {
        network: "localnet",
        signer: merchantSigner,
        apiKey: "k",
        hostname: "api.test.local",
        installSignalHandlers: false,
      },
      { fetchImpl: fakeFetch },
    );

    const app = new Hono();
    app.use("*", m.hono({ pricing: { "/v1/baz": { amountUsd: 0.01 } } }));
    app.get("/v1/baz", (c) => c.json({ ok: true }, 200));

    const startedAt = 1_717_000_000_777;
    const res = await app.request("/v1/baz", {
      headers: {
        "X-Pact-Pubkey": agentPubkey,
        "X-Pact-Started-At": String(startedAt),
      },
    });
    expect(res.status).toBe(200);
    const proxiedBy = res.headers.get("X-Pact-Proxied-By");
    const proxiedSig = res.headers.get("X-Pact-Proxied-Sig");
    expect(proxiedBy).toBe(merchantSigner.publicKey.toBase58());
    expect(proxiedSig).toBeTruthy();
    expect(
      verifyProxiedBy(
        {
          merchantPubkey: merchantSigner.publicKey.toBase58(),
          agentPubkey,
          startedAt,
          endpoint: "/v1/baz",
          statusCode: 200,
        },
        proxiedSig!,
        merchantSigner.publicKey.toBase58(),
      ),
    ).toBe(true);

    await new Promise((r) => setTimeout(r, 30));
    expect(observations.length).toBe(1);
    await m.shutdown();
  });
});
