import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import express from "express";
import type { AddressInfo } from "node:net";
import { createPactMerchant } from "../factory.js";
import { verifyProxiedBy } from "../attestation.js";

function freshKeypair(): Keypair {
  return Keypair.fromSecretKey(nacl.sign.keyPair().secretKey);
}

async function listen(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  return await new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

describe("express middleware", () => {
  it("stamps X-Pact-Proxied-By + Sig when X-Pact-Pubkey is present, and verifies", async () => {
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

    const app = express();
    app.use(
      m.middleware({
        pricing: { "/v1/foo": { amountUsd: 0.01 } },
      }),
    );
    app.get("/v1/foo", (_req, res) => {
      res.status(200).json({ ok: true });
    });

    const server = await listen(app);
    try {
      const startedAt = 1_717_000_000_000;
      const res = await fetch(`${server.url}/v1/foo`, {
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
            endpoint: "/v1/foo",
            statusCode: 200,
          },
          proxiedSig!,
          merchantSigner.publicKey.toBase58(),
        ),
      ).toBe(true);

      // Wait one tick for the fire-and-forget observation POST.
      await new Promise((r) => setTimeout(r, 50));
      expect(observations.length).toBe(1);
      const body = (observations[0] as { body: Record<string, unknown> }).body;
      expect(body.endpoint).toBe("/v1/foo");
      expect(body.agentPubkey).toBe(agentPubkey);
      expect(body.startedAt).toBe(startedAt);
      expect(body.statusCode).toBe(200);
      expect(body.classification).toBe("success");
    } finally {
      await server.close();
      await m.shutdown();
    }
  });

  it("does NOT stamp attestation headers when X-Pact-Pubkey is absent", async () => {
    const merchantSigner = freshKeypair();
    const fakeFetch = (async () => ({ status: 200, async json() { return {}; } })) as unknown as typeof fetch;
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
    const app = express();
    app.use(m.middleware({ pricing: { "/v1/foo": { amountUsd: 0.01 } } }));
    app.get("/v1/foo", (_req, res) => res.status(200).json({ ok: true }));

    const server = await listen(app);
    try {
      const res = await fetch(`${server.url}/v1/foo`);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-pact-proxied-by")).toBeNull();
      expect(res.headers.get("x-pact-proxied-sig")).toBeNull();
    } finally {
      await server.close();
      await m.shutdown();
    }
  });

  it("skips observation for paths not in pricing", async () => {
    const merchantSigner = freshKeypair();
    const observations: unknown[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      if (typeof url === "string" && url.includes("/api/v1/observations")) {
        observations.push({ url, body: JSON.parse(init.body as string) });
      }
      return { status: 200, async json() { return {}; } };
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
    const app = express();
    app.use(m.middleware({ pricing: { "/v1/covered": { amountUsd: 0.01 } } }));
    app.get("/v1/uncovered", (_req, res) => res.status(200).json({ ok: true }));

    const server = await listen(app);
    try {
      const res = await fetch(`${server.url}/v1/uncovered`, {
        headers: { "X-Pact-Pubkey": freshKeypair().publicKey.toBase58() },
      });
      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 30));
      expect(observations.length).toBe(0);
    } finally {
      await server.close();
      await m.shutdown();
    }
  });
});
