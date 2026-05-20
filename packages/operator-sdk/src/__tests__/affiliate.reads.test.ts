import { describe, it, expect, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { createAffiliate } from "../affiliate.js";
import { OperatorErrorCode } from "../errors.js";

function makeFetch(
  routes: Record<string, { status: number; body: unknown }>,
): typeof fetch {
  return (async (
    input: RequestInfo | URL,
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = new URL(url).pathname + new URL(url).search;
    const match = routes[path] ?? routes[new URL(url).pathname];
    if (!match) {
      return new Response("", { status: 404 });
    }
    return new Response(JSON.stringify(match.body), {
      status: match.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const pubkey = Keypair.generate().publicKey;

describe("affiliate read client", () => {
  it("lifetimeEarnings returns the zero envelope on 200 (server null-branch)", async () => {
    const fetchImpl = makeFetch({
      [`/api/recipients/${pubkey.toBase58()}`]: {
        status: 200,
        body: {
          recipientPubkey: pubkey.toBase58(),
          recipientKind: null,
          lifetimeEarnedLamports: "0",
          lastUpdated: null,
        },
      },
    });
    const aff = createAffiliate(pubkey, {
      indexerBaseUrl: "https://i",
      fetchImpl,
    });
    const r = await aff.lifetimeEarnings();
    expect(r.lifetimeEarnedLamports).toBe("0");
    expect(r.recipientKind).toBeNull();
  });

  it("lifetimeEarnings parses a populated row correctly", async () => {
    const fetchImpl = makeFetch({
      [`/api/recipients/${pubkey.toBase58()}`]: {
        status: 200,
        body: {
          recipientPubkey: pubkey.toBase58(),
          recipientKind: 1,
          lifetimeEarnedLamports: "12345",
          lastUpdated: "2026-05-20T00:00:00.000Z",
        },
      },
    });
    const aff = createAffiliate(pubkey, {
      indexerBaseUrl: "https://i",
      fetchImpl,
    });
    const r = await aff.lifetimeEarnings();
    expect(r.lifetimeEarnedLamports).toBe("12345");
    expect(r.recipientKind).toBe(1);
  });

  it("recentSettlements (first page, no cursor): omits cursor param + decodes items[]", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (
      input: RequestInfo | URL,
    ) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return new Response(
        JSON.stringify({
          items: [
            {
              id: "ck1",
              settledAt: "2026-05-20T00:00:00.000Z",
              txSignature: "sig1",
              amountLamports: "100",
              recipientKind: 1,
            },
          ],
          nextCursor: "Y2sx",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const aff = createAffiliate(pubkey, {
      indexerBaseUrl: "https://i",
      fetchImpl,
    });
    const page = await aff.recentSettlements({ limit: 10 });
    expect(capturedUrl).toContain(
      `/api/recipients/${pubkey.toBase58()}/settlements?limit=10`,
    );
    expect(capturedUrl).not.toContain("cursor=");
    expect(page.items).toHaveLength(1);
    expect(page.items[0].amountLamports).toBe("100");
    expect(page.nextCursor).toBe("Y2sx");
  });

  it("recentSettlements (subsequent page): passes cursor through verbatim", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (
      input: RequestInfo | URL,
    ) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return new Response(
        JSON.stringify({ items: [], nextCursor: null }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const aff = createAffiliate(pubkey, {
      indexerBaseUrl: "https://i",
      fetchImpl,
    });
    const page = await aff.recentSettlements({ limit: 5, cursor: "Y2sx" });
    expect(capturedUrl).toContain("cursor=Y2sx");
    expect(capturedUrl).toContain("limit=5");
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it("AFFILIATE_READ_FAILED on non-2xx", async () => {
    const fetchImpl = (async () =>
      new Response("oops", { status: 500 })) as unknown as typeof fetch;
    const aff = createAffiliate(pubkey, {
      indexerBaseUrl: "https://i",
      fetchImpl,
    });
    await expect(aff.lifetimeEarnings()).rejects.toMatchObject({
      code: OperatorErrorCode.AFFILIATE_READ_FAILED,
    });
  });

  it("AFFILIATE_READ_FAILED on malformed JSON", async () => {
    const fetchImpl = (async () =>
      new Response("not json", {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const aff = createAffiliate(pubkey, {
      indexerBaseUrl: "https://i",
      fetchImpl,
    });
    await expect(aff.lifetimeEarnings()).rejects.toMatchObject({
      code: OperatorErrorCode.AFFILIATE_READ_FAILED,
    });
  });

  it("AFFILIATE_READ_FAILED on network error / abort", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const aff = createAffiliate(pubkey, {
      indexerBaseUrl: "https://i",
      fetchImpl,
    });
    await expect(aff.lifetimeEarnings()).rejects.toMatchObject({
      code: OperatorErrorCode.AFFILIATE_READ_FAILED,
    });
  });

  it("strips trailing slashes from indexerBaseUrl", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return new Response(
        JSON.stringify({
          recipientPubkey: pubkey.toBase58(),
          recipientKind: null,
          lifetimeEarnedLamports: "0",
          lastUpdated: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const aff = createAffiliate(pubkey, {
      indexerBaseUrl: "https://i.example.com//",
      fetchImpl,
    });
    await aff.lifetimeEarnings();
    expect(capturedUrl).toBe(
      `https://i.example.com/api/recipients/${pubkey.toBase58()}`,
    );
  });

  it("read-only by construction: createAffiliate takes PublicKey not Keypair", () => {
    // Type-level + runtime: a Keypair has secretKey; affiliate.pubkey is a PublicKey.
    const aff = createAffiliate(pubkey, { indexerBaseUrl: "https://i" });
    expect(aff.pubkey).toBe(pubkey);
    expect(aff).not.toHaveProperty("setup");
    expect(aff).not.toHaveProperty("topUp");
    expect(aff).not.toHaveProperty("withdraw");
  });
});
