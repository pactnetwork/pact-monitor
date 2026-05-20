import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import { validateConfig } from "../config.js";
import { PactError, PactErrorCode } from "../errors.js";

describe("validateConfig — requestSigningSecretKey", () => {
  const kp = Keypair.generate();

  it("accepts a 64-byte secret whose pubkey matches the signer", () => {
    const sk = kp.secretKey; // web3.js returns a fresh copy each access
    const cfg = validateConfig({
      network: "mainnet",
      signer: kp,
      requestSigningSecretKey: sk,
    });
    expect(cfg.requestSigningSecretKey).toBe(sk);
    expect(cfg.requestSigningSecretKey?.length).toBe(64);
  });

  it("accepts when no override is given", () => {
    expect(() =>
      validateConfig({ network: "mainnet", signer: kp }),
    ).not.toThrow();
  });

  it("rejects a non-64-byte secret (e.g. a 32-byte seed)", () => {
    try {
      validateConfig({
        network: "mainnet",
        signer: kp,
        requestSigningSecretKey: kp.secretKey.slice(0, 32),
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PactError);
      expect((e as PactError).code).toBe(PactErrorCode.CONFIG_INVALID);
      expect((e as PactError).message).toMatch(/64-byte/);
    }
  });

  it("rejects a 64-byte secret whose pubkey does not match the signer", () => {
    const other = Keypair.generate();
    try {
      validateConfig({
        network: "mainnet",
        signer: kp,
        requestSigningSecretKey: other.secretKey,
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PactError);
      expect((e as PactError).code).toBe(PactErrorCode.CONFIG_INVALID);
      expect((e as PactError).message).toMatch(/does not match/);
    }
  });
});
