// @vitest-environment happy-dom
//
// Proves the covered-call path is isomorphic: no node:fs / node:crypto /
// node:events reaches it. Runs in a DOM environment with an explicit
// MemoryStorage so the fs branch is never taken; WebCrypto signing, the tiny
// emitter, and a full createPact covered fetch must all work.
import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import { createPact } from "../factory.js";
import { MemoryStorage } from "../storage-memory.js";
import { sha256Hex } from "../crypto.js";
import { PactEventEmitter } from "../events.js";
import { selectStorage } from "../storage-select.js";

const DISCOVERY = {
  cacheTtlSec: 3600,
  endpoints: [
    { slug: "dummy", hostnames: ["dummy.pactnetwork.io"], premiumBps: 100, paused: false },
  ],
};

describe("browser isomorphism", () => {
  it("WebCrypto sha256Hex works in a DOM env", async () => {
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("PactEventEmitter works without node:events", () => {
    const e = new PactEventEmitter();
    const seen: string[] = [];
    e.on("degraded", (ev) => seen.push(ev.reason));
    e.emit("degraded", { reason: "r", url: "u", ts: "t" });
    expect(seen).toEqual(["r"]);
  });

  it("MemoryStorage round-trips and aggregates", () => {
    const m = new MemoryStorage();
    m.append({
      callId: "c1",
      agentPubkey: "a",
      slug: "dummy",
      host: "h",
      ts: "t",
      premiumLamports: "100",
      refundLamports: "0",
      outcome: "ok",
      breach: false,
      reconciled: false,
    });
    expect(m.loadPending()).toHaveLength(1);
    m.markReconciled("c1");
    expect(m.loadPending()).toHaveLength(0);
    expect(m.stats().totalPremiumLamportsObserved).toBe(100n);
  });

  it("selectStorage returns the explicit store when given (no fs)", async () => {
    const mem = new MemoryStorage();
    expect(await selectStorage({ storage: mem })).toBe(mem);
  });

  it("createPact runs a covered fetch with MemoryStorage + WebCrypto signing", async () => {
    const signer = Keypair.generate();
    const fetchImpl = (async (u: string) => {
      const url = String(u);
      if (url.endsWith("/.well-known/endpoints")) {
        return new Response(JSON.stringify(DISCOVERY), { status: 200 });
      }
      if (url.includes("/v1/dummy/")) {
        return new Response("ok", {
          status: 200,
          headers: {
            "X-Pact-Call-Id": "cid-browser",
            "X-Pact-Outcome": "ok",
            "X-Pact-Premium": "100",
          },
        });
      }
      return new Response("origin", { status: 200 });
    }) as unknown as typeof fetch;

    const pact = await createPact({
      network: "mainnet",
      signer,
      storage: new MemoryStorage(),
      fetchImpl,
      indexerPollIntervalMs: 60_000,
      installSignalHandlers: false,
    });
    const res = await pact.fetch("https://dummy.pactnetwork.io/quote/AAPL");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Pact-Call-Id")).toBe("cid-browser");
    expect(pact.stats().totalCalls).toBe(1);
    await pact.shutdown();
  });
});
