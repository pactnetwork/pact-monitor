/**
 * Wired end-to-end: the full public-API loop with mocked transports —
 * createPact -> covered fetch -> X-Pact-* parse -> durable buffer ->
 * `failure` event -> indexer reconcile (via shutdown's final flush) ->
 * `billed` + `refund` events -> buffer marked reconciled.
 *
 * The live devnet E2E is a separate, env-guarded test below: it cannot run
 * in CI until plan blockers B1 (confirmed devnet program ID) and B2
 * (reachable public indexer) are resolved and an operator has minted Pact's
 * custom devnet USDC (4zMMC9…, not faucet-able) to the agent ATA.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, mkdtempSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import { createPact } from "../factory.js";

const DISCOVERY = {
  cacheTtlSec: 3600,
  endpoints: [
    { slug: "dummy", hostnames: ["dummy.pactnetwork.io"], premiumBps: 100, paused: false },
  ],
};

describe("integration (wired, mocked transports)", () => {
  let dir: string;
  let storagePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pact-e2e-"));
    storagePath = join(dir, "obs.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("covered breach -> failure now, refund+billed after reconcile", async () => {
    const signer = Keypair.generate();
    const agent = signer.publicKey.toBase58();

    const settledRow = {
      callId: "cid-e2e",
      agentPubkey: agent,
      endpointSlug: "dummy",
      premiumLamports: "100",
      refundLamports: "9000",
      latencyMs: 50,
      breach: true,
      breachReason: "server_error",
      source: "proxy",
      ts: "2026-05-18T00:00:00.000Z",
      settledAt: "2026-05-18T00:00:06.000Z",
      signature: "BATCHSIG",
    };

    const fetchImpl = (async (u: string) => {
      const url = String(u);
      if (url.endsWith("/.well-known/endpoints")) {
        return new Response(JSON.stringify(DISCOVERY), { status: 200 });
      }
      if (url.includes("/v1/dummy/")) {
        return new Response("upstream 503", {
          status: 503,
          headers: {
            "X-Pact-Call-Id": "cid-e2e",
            "X-Pact-Outcome": "server_error",
            "X-Pact-Premium": "100",
            "X-Pact-Refund": "9000",
          },
        });
      }
      if (url.includes("/api/agents/")) {
        return new Response(JSON.stringify([settledRow]), { status: 200 });
      }
      return new Response("origin", { status: 200 });
    }) as unknown as typeof fetch;

    const pact = await createPact({
      network: "mainnet",
      signer,
      storagePath,
      fetchImpl,
      indexerPollIntervalMs: 60_000,
      installSignalHandlers: false,
    });

    const failures: string[] = [];
    const refunds: bigint[] = [];
    const billed: bigint[] = [];
    pact.on("failure", (e) => failures.push(e.outcome));
    pact.on("refund", (e) => refunds.push(e.refundLamports));
    pact.on("billed", (e) => billed.push(e.premiumLamports));

    const res = await pact.fetch("https://dummy.pactnetwork.io/quote/AAPL");
    expect(res.status).toBe(503); // insured upstream failure, returned as-is
    expect(failures).toEqual(["server_error"]);
    expect(pact.stats().pendingCalls).toBe(1);

    // shutdown() runs a final reconciliation flush against the indexer.
    await pact.shutdown();

    expect(billed).toEqual([100n]);
    expect(refunds).toEqual([9000n]);
    expect(pact.stats().reconciledCalls).toBe(1);
    expect(pact.stats().pendingCalls).toBe(0);
  });

  // ---------------------------------------------------------------------
  // Live devnet E2E. Disabled unless PACT_SDK_E2E=1. Requires (manual):
  //   - PACT_DEVNET_PROGRAM_ID  : confirmed devnet program id (blocker B1)
  //   - PACT_DEVNET_SECRET_KEY  : base58 64-byte agent secret key
  //   - PACT_DEVNET_INDEXER_URL : reachable indexer host (blocker B2)
  //   - operator-minted devnet USDC (4zMMC9…) in the agent ATA
  // Steps mirror plan §Verification: setup() approve -> covered call to
  // dummy.pactnetwork.io -> force breach with `?fail=1` (NOT ?demo_breach=1
  // / ?x402=1) -> assert `failure` then `refund` within ~60s.
  // ---------------------------------------------------------------------
  it.skipIf(!process.env.PACT_SDK_E2E)(
    "live devnet: approve -> covered call -> forced breach -> refund",
    async () => {
      const bs58 = (await import("bs58")).default;
      const sk = bs58.decode(process.env.PACT_DEVNET_SECRET_KEY ?? "");
      const signer = Keypair.fromSecretKey(sk);
      const pact = await createPact({
        network: "devnet",
        signer,
        programId: process.env.PACT_DEVNET_PROGRAM_ID,
        indexerBaseUrl: process.env.PACT_DEVNET_INDEXER_URL,
        storagePath: join(dir, "live.jsonl"),
        installSignalHandlers: false,
      });
      await pact.setup({ allowanceUsdc: 5 });
      const pol = await pact.policy();
      expect(pol.eligible).toBe(true);

      const refunded = new Promise<bigint>((resolve) =>
        pact.on("refund", (e) => resolve(e.refundLamports)),
      );
      const res = await pact.fetch(
        "https://dummy.pactnetwork.io/quote/AAPL?fail=1",
      );
      expect(res.status).toBeGreaterThanOrEqual(500);
      const amount = await Promise.race([
        refunded,
        new Promise<bigint>((_, rej) =>
          setTimeout(() => rej(new Error("no refund in 90s")), 90_000),
        ),
      ]);
      expect(amount).toBeGreaterThan(0n);
      await pact.shutdown();
    },
    120_000,
  );
});
