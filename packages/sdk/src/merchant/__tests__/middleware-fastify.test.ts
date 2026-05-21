import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import Fastify from "fastify";
import { createPactMerchant } from "../factory.js";
import { verifyProxiedBy } from "../attestation.js";

function freshKeypair(): Keypair {
  return Keypair.fromSecretKey(nacl.sign.keyPair().secretKey);
}

describe("fastify middleware", () => {
  it("stamps attestation headers and posts an observation", async () => {
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

    const app = Fastify({ logger: false });
    await m.fastify({ pricing: { "/v1/bar": { amountUsd: 0.01 } } })(app);
    app.get("/v1/bar", async (_req, reply) => {
      reply.code(200).send({ ok: true });
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as { port: number }).port;

    try {
      const startedAt = 1_717_000_000_555;
      const res = await fetch(`http://127.0.0.1:${port}/v1/bar`, {
        headers: {
          "X-Pact-Pubkey": agentPubkey,
          "X-Pact-Started-At": String(startedAt),
        },
      });
      expect(res.status).toBe(200);
      const proxiedBy = res.headers.get("x-pact-proxied-by");
      const proxiedSig = res.headers.get("x-pact-proxied-sig");
      expect(proxiedBy).toBe(merchantSigner.publicKey.toBase58());
      expect(proxiedSig).toBeTruthy();
      expect(
        verifyProxiedBy(
          {
            merchantPubkey: merchantSigner.publicKey.toBase58(),
            agentPubkey,
            startedAt,
            endpoint: "/v1/bar",
            statusCode: 200,
          },
          proxiedSig!,
          merchantSigner.publicKey.toBase58(),
        ),
      ).toBe(true);

      await new Promise((r) => setTimeout(r, 50));
      expect(observations.length).toBe(1);
      const body = (observations[0] as { body: Record<string, unknown> }).body;
      expect(body.endpoint).toBe("/v1/bar");
    } finally {
      await app.close();
      await m.shutdown();
    }
  });
});
