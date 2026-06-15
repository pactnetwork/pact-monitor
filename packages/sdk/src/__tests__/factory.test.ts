import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, mkdtempSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import { createPact } from "../factory.js";
import { PactError, PactErrorCode } from "../errors.js";

const DISCOVERY = {
  cacheTtlSec: 3600,
  endpoints: [
    { slug: "dummy", hostnames: ["dummy.pactnetwork.io"], premiumBps: 100, paused: false },
    { slug: "helius", hostnames: ["api.helius.xyz"], premiumBps: 100, paused: false },
  ],
};

function dispatcher(opts: {
  proxy?: (u: string, i?: RequestInit) => Response;
  origin?: (u: string) => Response;
}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (u: string, i?: RequestInit) => {
    const url = String(u);
    calls.push({ url, init: i });
    if (url.endsWith("/.well-known/endpoints")) {
      return new Response(JSON.stringify(DISCOVERY), { status: 200 });
    }
    if (url.includes("/v1/")) {
      return (
        opts.proxy?.(url, i) ?? new Response("no proxy", { status: 500 })
      );
    }
    if (url.includes("/api/agents/")) {
      return new Response("[]", { status: 200 });
    }
    return opts.origin?.(url) ?? new Response("origin", { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("createPact", () => {
  let dir: string;
  let storagePath: string;
  const signer = Keypair.generate();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pact-factory-"));
    storagePath = join(dir, "obs.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("rejects an invalid config synchronously", async () => {
    await expect(
      // @ts-expect-error deliberate bad network
      createPact({ network: "bogus", signer }),
    ).rejects.toMatchObject({ code: PactErrorCode.CONFIG_INVALID });
  });

  it("degrades an unregistered host to a bare fetch + emits 'degraded'", async () => {
    const { fetchImpl, calls } = dispatcher({
      origin: () => new Response("bare-upstream", { status: 200 }),
    });
    const pact = await createPact({
      network: "mainnet",
      signer,
      storagePath,
      fetchImpl,
      indexerPollIntervalMs: 60_000,
    });
    const seen: string[] = [];
    pact.on("degraded", (e) => seen.push(e.reason));

    const res = await pact.fetch("https://unknown.example.com/data");
    expect(await res.text()).toBe("bare-upstream");
    expect(seen).toEqual(["unregistered"]);
    expect(pact.stats().totalCalls).toBe(0);
    await pact.shutdown();
    expect(calls.some((c) => c.url === "https://unknown.example.com/data")).toBe(
      true,
    );
  });

  it("routes a covered call through the proxy and buffers it", async () => {
    const { fetchImpl, calls } = dispatcher({
      proxy: () =>
        new Response("ok", {
          status: 200,
          headers: { "X-Pact-Call-Id": "cid-1", "X-Pact-Outcome": "ok" },
        }),
    });
    const pact = await createPact({
      network: "mainnet",
      signer,
      storagePath,
      fetchImpl,
      indexerPollIntervalMs: 60_000,
    });
    const res = await pact.fetch("https://dummy.pactnetwork.io/quote/AAPL");
    expect(res.status).toBe(200);
    const proxied = calls.find((c) => c.url.includes("/v1/dummy/"));
    expect(proxied?.url).toBe(
      "https://market.pactnetwork.io/v1/dummy/quote/AAPL",
    );
    const h = proxied?.init?.headers as Record<string, string>;
    expect(h["x-pact-agent"]).toBe(signer.publicKey.toBase58());
    expect(h["x-pact-signature"]).toBeTruthy();
    expect(pact.stats().totalCalls).toBe(1);
    await pact.shutdown();
  });

  it("emits 'failure' on a covered breach outcome", async () => {
    const { fetchImpl } = dispatcher({
      proxy: () =>
        new Response("down", {
          status: 503,
          headers: {
            "X-Pact-Call-Id": "cid-2",
            "X-Pact-Outcome": "server_error",
            "X-Pact-Refund": "9000",
          },
        }),
    });
    const pact = await createPact({
      network: "mainnet",
      signer,
      storagePath,
      fetchImpl,
      indexerPollIntervalMs: 60_000,
    });
    const failures: string[] = [];
    pact.on("failure", (e) => failures.push(e.outcome));
    const res = await pact.fetch("https://dummy.pactnetwork.io/x");
    expect(res.status).toBe(503);
    expect(failures).toEqual(["server_error"]);
    const s = pact.stats();
    expect(s.totalCalls).toBe(1);
    expect(s.bySlug.dummy).toEqual({ calls: 1, breaches: 1 });
    await pact.shutdown();
  });

  // B1 is resolved: devnet now carries a verified program ID, so the
  // missing-program-ID guard is exercised on localnet (sed-replaced per-env
  // build => no static default) instead.
  it("setup() rejects with the missing-program-ID error on localnet", async () => {
    const { fetchImpl } = dispatcher({});
    const pact = await createPact({
      network: "localnet",
      signer,
      storagePath,
      fetchImpl,
      indexerPollIntervalMs: 60_000,
    });
    await expect(pact.setup({ allowanceUsdc: 5 })).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof PactError &&
        e.code === PactErrorCode.CONFIG_INVALID &&
        /program id/i.test(e.message) &&
        /localnet/.test(e.message),
    );
    await pact.shutdown();
  });

  it("autoTopUp on localnet without a program ID fails fast at createPact", async () => {
    const { fetchImpl } = dispatcher({});
    await expect(
      createPact({
        network: "localnet",
        signer,
        storagePath,
        fetchImpl,
        autoTopUp: { thresholdLamports: 1n, refillUsdc: 1 },
      }),
    ).rejects.toMatchObject({ code: PactErrorCode.CONFIG_INVALID });
  });
});
