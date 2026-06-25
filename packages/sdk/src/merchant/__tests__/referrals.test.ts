// K4 SDK: graduate merchant.referrals() from NOT_AVAILABLE stub to a real
// call. Tests cover the decode path + the fail-safe-to-zeroed fallback.

import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import { createPactMerchant } from "../factory.js";
import { bigOrZero } from "../bignum.js";

function freshKeypair(): Keypair {
  return Keypair.fromSecretKey(nacl.sign.keyPair().secretKey);
}

describe("bigOrZero", () => {
  it("decodes decimal strings", () => {
    expect(bigOrZero("12345")).toBe(12_345n);
    expect(bigOrZero("0")).toBe(0n);
  });
  it("passes bigints through", () => {
    expect(bigOrZero(50_000n)).toBe(50_000n);
  });
  it("truncates floats", () => {
    expect(bigOrZero(42.9)).toBe(42n);
  });
  it("returns 0n on garbage", () => {
    expect(bigOrZero(null)).toBe(0n);
    expect(bigOrZero(undefined)).toBe(0n);
    expect(bigOrZero("not-a-number")).toBe(0n);
    expect(bigOrZero({})).toBe(0n);
    expect(bigOrZero("-5")).toBe(0n); // matches /^\d+$/ — leading minus rejected
  });
});

describe("merchant.referrals (Commit 3 K4 graduation)", () => {
  it("decodes a happy-path response with bigint-as-string totals", async () => {
    const signer = freshKeypair();
    const fakeFetch = (async (url: string) => {
      if (typeof url === "string" && url.includes("/api/v1/merchants/me/referrals")) {
        return {
          status: 200,
          async json() {
            return {
              totalRefShareUsdc: "150000",
              byAgent: [
                { agentPubkey: "AGENT_A", calls: 5, refShareUsdc: "100000" },
                { agentPubkey: "AGENT_B", calls: 1, refShareUsdc: "50000" },
              ],
            };
          },
        };
      }
      return { status: 200, async json() { return null; } };
    }) as unknown as typeof fetch;

    const m = await createPactMerchant(
      {
        network: "localnet",
        signer,
        apiKey: "pact_test",
        hostname: "api.test.local",
        installSignalHandlers: false,
      },
      { fetchImpl: fakeFetch },
    );
    const r = await m.referrals();
    expect(r.totalRefShareUsdc).toBe(150_000n);
    expect(r.byAgent).toHaveLength(2);
    expect(r.byAgent[0].agentPubkey).toBe("AGENT_A");
    expect(r.byAgent[0].calls).toBe(5);
    expect(r.byAgent[0].refShareUsdc).toBe(100_000n);
    expect(r.byAgent[1].refShareUsdc).toBe(50_000n);
    await m.shutdown();
  });

  it("passes ?since through when supplied", async () => {
    const signer = freshKeypair();
    const calls: string[] = [];
    const fakeFetch = (async (url: string) => {
      calls.push(url.toString());
      return {
        status: 200,
        async json() {
          return { totalRefShareUsdc: "0", byAgent: [] };
        },
      };
    }) as unknown as typeof fetch;

    const m = await createPactMerchant(
      {
        network: "localnet",
        signer,
        apiKey: "pact_test",
        hostname: "api.test.local",
        installSignalHandlers: false,
      },
      { fetchImpl: fakeFetch },
    );
    await m.referrals({ since: 1_717_000_000_000 });
    const referralsCall = calls.find((u) => u.includes("/api/v1/merchants/me/referrals"));
    expect(referralsCall).toBeTruthy();
    expect(referralsCall).toContain("since=1717000000000");
    await m.shutdown();
  });

  it("returns the zeroed shape on a failing backend (golden-rule mirror)", async () => {
    const signer = freshKeypair();
    const fakeFetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const m = await createPactMerchant(
      {
        network: "localnet",
        signer,
        apiKey: "pact_test",
        hostname: "api.test.local",
        installSignalHandlers: false,
      },
      { fetchImpl: fakeFetch },
    );
    const r = await m.referrals();
    expect(r.totalRefShareUsdc).toBe(0n);
    expect(r.byAgent).toEqual([]);
    await m.shutdown();
  });

  it("returns the zeroed shape on a malformed response body", async () => {
    const signer = freshKeypair();
    const fakeFetch = (async () => ({
      status: 200,
      async json() {
        return { totalRefShareUsdc: "garbage", byAgent: "not-an-array" };
      },
    })) as unknown as typeof fetch;
    const m = await createPactMerchant(
      {
        network: "localnet",
        signer,
        apiKey: "pact_test",
        hostname: "api.test.local",
        installSignalHandlers: false,
      },
      { fetchImpl: fakeFetch },
    );
    const r = await m.referrals();
    expect(r.totalRefShareUsdc).toBe(0n);
    expect(r.byAgent).toEqual([]);
    await m.shutdown();
  });

  it("referralLink is deterministic from the merchant pubkey", async () => {
    const signer = freshKeypair();
    const m = await createPactMerchant({
      network: "localnet",
      signer,
      apiKey: "k",
      hostname: "api.test.local",
      installSignalHandlers: false,
    });
    const link = m.referralLink();
    expect(link).toBe(
      `https://pactnetwork.io/onboard?ref=${encodeURIComponent(signer.publicKey.toBase58())}`,
    );
    await m.shutdown();
  });
});
