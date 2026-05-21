import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import { createPactMerchant } from "../factory.js";
import { PactError, PactErrorCode } from "../../errors.js";

function freshKeypair(): Keypair {
  const pair = nacl.sign.keyPair();
  return Keypair.fromSecretKey(pair.secretKey);
}

describe("createPactMerchant config validation", () => {
  it("throws CONFIG_INVALID with no config", async () => {
    // @ts-expect-error testing missing config
    await expect(createPactMerchant(undefined)).rejects.toMatchObject({
      code: PactErrorCode.CONFIG_INVALID,
    });
  });

  it("throws CONFIG_INVALID without network", async () => {
    const signer = freshKeypair();
    // @ts-expect-error missing network
    await expect(createPactMerchant({ signer, apiKey: "k", hostname: "api.test" })).rejects.toMatchObject({
      code: PactErrorCode.CONFIG_INVALID,
    });
  });

  it("throws SIGNER_MISSING without signer", async () => {
    // @ts-expect-error missing signer
    await expect(createPactMerchant({ network: "localnet", apiKey: "k", hostname: "api.test" })).rejects.toMatchObject({
      code: PactErrorCode.SIGNER_MISSING,
    });
  });

  it("throws CONFIG_INVALID without apiKey", async () => {
    const signer = freshKeypair();
    // @ts-expect-error missing apiKey
    await expect(createPactMerchant({ network: "localnet", signer, hostname: "api.test" })).rejects.toMatchObject({
      code: PactErrorCode.CONFIG_INVALID,
    });
  });

  it("throws CONFIG_INVALID without hostname", async () => {
    const signer = freshKeypair();
    // @ts-expect-error missing hostname
    await expect(createPactMerchant({ network: "localnet", signer, apiKey: "k" })).rejects.toMatchObject({
      code: PactErrorCode.CONFIG_INVALID,
    });
  });
});

describe("MerchantInstance surface", () => {
  it("exposes the merchant pubkey + lifecycle + referral link", async () => {
    const signer = freshKeypair();
    const m = await createPactMerchant(
      {
        network: "localnet",
        signer,
        apiKey: "pact_test",
        hostname: "api.test.local",
        installSignalHandlers: false,
      },
      { fetchImpl: (async () => ({ status: 200, async json() { return {}; } })) as unknown as typeof fetch },
    );
    expect(m.merchantPubkey).toBe(signer.publicKey.toBase58());
    expect(m.referralLink()).toContain(`?ref=${encodeURIComponent(signer.publicKey.toBase58())}`);
    await m.shutdown();
  });

  it("dispute() throws NOT_AVAILABLE (Commit 1 stub)", async () => {
    const signer = freshKeypair();
    const m = await createPactMerchant({
      network: "localnet",
      signer,
      apiKey: "k",
      hostname: "api.test.local",
      installSignalHandlers: false,
    });
    await expect(
      m.dispute({ callRecordId: "00000000-0000-0000-0000-000000000000", reason: "test" }),
    ).rejects.toBeInstanceOf(PactError);
    await expect(
      m.dispute({ callRecordId: "00000000-0000-0000-0000-000000000000", reason: "test" }),
    ).rejects.toMatchObject({ code: PactErrorCode.NOT_AVAILABLE });
    await m.shutdown();
  });

  it("referrals() throws NOT_AVAILABLE (Commit 3)", async () => {
    const signer = freshKeypair();
    const m = await createPactMerchant({
      network: "localnet",
      signer,
      apiKey: "k",
      hostname: "api.test.local",
      installSignalHandlers: false,
    });
    await expect(m.referrals()).rejects.toMatchObject({ code: PactErrorCode.NOT_AVAILABLE });
    await m.shutdown();
  });

  it("stats() returns the zeroed shape on a failing backend", async () => {
    const signer = freshKeypair();
    const m = await createPactMerchant(
      {
        network: "localnet",
        signer,
        apiKey: "k",
        hostname: "api.test.local",
        installSignalHandlers: false,
      },
      {
        fetchImpl: (async () => {
          throw new Error("network down");
        }) as unknown as typeof fetch,
      },
    );
    const s = await m.stats();
    expect(s.calls).toBe(0);
    expect(s.tier).toBe("UNRANKED");
    expect(s.premiumsCollectedUsdc).toBe(0n);
    await m.shutdown();
  });
});
