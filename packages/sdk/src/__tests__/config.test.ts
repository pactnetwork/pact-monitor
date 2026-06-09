import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getAddress } from "viem";
import { validateConfig } from "../config.js";
import { PactError, PactErrorCode } from "../errors.js";
import type { EvmPactSigner } from "../signer.js";

describe("validateConfig — Solana requestSigningSecretKey", () => {
  const kp = Keypair.generate();

  it("accepts a 64-byte secret whose pubkey matches the signer", () => {
    const sk = kp.secretKey;
    const cfg = validateConfig({
      network: "mainnet",
      signer: kp,
      requestSigningSecretKey: sk,
    });
    expect(cfg.requestSigningSecretKey).toBe(sk);
    expect((cfg.requestSigningSecretKey as Uint8Array)?.length).toBe(64);
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

describe("validateConfig — EVM signer", () => {
  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  const evmSigner: EvmPactSigner = {
    kind: "evm",
    address: account.address,
    privateKey: pk,
  };

  it("accepts a well-formed EVM signer with a private key", () => {
    const cfg = validateConfig({
      network: "mainnet",
      signer: evmSigner,
      endpointNetwork: "base-sepolia",
    });
    expect(cfg.signer).toBe(evmSigner);
    expect(cfg.endpointNetwork).toBe("base-sepolia");
  });

  it("accepts an EVM signer with no private key when signRequests is false", () => {
    expect(() =>
      validateConfig({
        network: "mainnet",
        signer: { kind: "evm", address: account.address },
        signRequests: false,
        endpointNetwork: "base-sepolia",
      }),
    ).not.toThrow();
  });

  it("rejects an EVM signer with no signing capability when signRequests defaults true", () => {
    try {
      validateConfig({
        network: "mainnet",
        signer: { kind: "evm", address: account.address },
        endpointNetwork: "base-sepolia",
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PactError);
      expect((e as PactError).code).toBe(PactErrorCode.CONFIG_INVALID);
      expect((e as PactError).message).toMatch(/privateKey/);
    }
  });

  it("rejects a malformed EVM address", () => {
    try {
      validateConfig({
        network: "mainnet",
        signer: {
          kind: "evm",
          address: "0xnothex" as `0x${string}`,
          privateKey: pk,
        },
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PactError);
      expect((e as PactError).message).toMatch(/address/);
    }
  });

  it("accepts a 0x-hex requestSigningSecretKey override that derives the same address", () => {
    expect(() =>
      validateConfig({
        network: "mainnet",
        signer: { kind: "evm", address: account.address },
        requestSigningSecretKey: pk,
        endpointNetwork: "base-sepolia",
      }),
    ).not.toThrow();
  });

  it("rejects a 0x-hex override whose address does not match the signer", () => {
    const otherPk = generatePrivateKey();
    try {
      validateConfig({
        network: "mainnet",
        signer: { kind: "evm", address: account.address },
        requestSigningSecretKey: otherPk,
        endpointNetwork: "base-sepolia",
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PactError);
      expect((e as PactError).message).toMatch(/does not match/);
    }
  });

  it("rejects a non-hex requestSigningSecretKey for an EVM signer", () => {
    try {
      validateConfig({
        network: "mainnet",
        signer: { kind: "evm", address: account.address },
        requestSigningSecretKey: new Uint8Array(64) as never,
        endpointNetwork: "base-sepolia",
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PactError);
      expect((e as PactError).message).toMatch(/secp256k1/);
    }
  });
});

describe("validateConfig — endpointNetwork cross-VM guard", () => {
  const kp = Keypair.generate();
  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  const evmSigner: EvmPactSigner = {
    kind: "evm",
    address: account.address,
    privateKey: pk,
  };

  it("rejects a Solana signer on an EVM endpointNetwork", () => {
    try {
      validateConfig({
        network: "mainnet",
        signer: kp,
        endpointNetwork: "base-sepolia",
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PactError);
      expect((e as PactError).code).toBe(PactErrorCode.CONFIG_INVALID);
      expect((e as PactError).message).toMatch(/evm network but signer is a solana/);
    }
  });

  it("rejects an EVM signer on a Solana endpointNetwork", () => {
    try {
      validateConfig({
        network: "mainnet",
        signer: evmSigner,
        endpointNetwork: "solana-devnet",
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PactError);
      expect((e as PactError).code).toBe(PactErrorCode.CONFIG_INVALID);
      expect((e as PactError).message).toMatch(/solana network but signer is a evm/);
    }
  });

  it("accepts an unknown endpointNetwork (delegates to proxy)", () => {
    expect(() =>
      validateConfig({
        network: "mainnet",
        signer: kp,
        endpointNetwork: "custom-mystery",
      }),
    ).not.toThrow();
  });
});

describe("validateConfig — agent identity exposure", () => {
  it("preserves the EVM address on the resolved config", () => {
    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);
    const evmSigner: EvmPactSigner = {
      kind: "evm",
      address: account.address,
      privateKey: pk,
    };
    const cfg = validateConfig({
      network: "mainnet",
      signer: evmSigner,
      endpointNetwork: "base-sepolia",
    });
    expect((cfg.signer as EvmPactSigner).address).toBe(account.address);
    expect(getAddress((cfg.signer as EvmPactSigner).address)).toBe(
      getAddress(account.address),
    );
  });
});
