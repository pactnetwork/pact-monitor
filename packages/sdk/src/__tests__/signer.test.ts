import { describe, it, expect } from "vitest";
import vm from "node:vm";
import { Keypair } from "@solana/web3.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getAddress } from "viem";
import {
  isEvmSigner,
  isKeypair,
  resolveSignFn,
  signerAddress,
  signerPublicKey,
  signerVm,
  type EvmPactSigner,
  type WalletAdapterSigner,
} from "../signer.js";

describe("signer — Solana", () => {
  it("recognises a web3.js Keypair", () => {
    const kp = Keypair.generate();
    expect(isKeypair(kp)).toBe(true);
    expect(signerVm(kp)).toBe("solana");
    expect(signerAddress(kp)).toBe(kp.publicKey.toBase58());
    expect(signerPublicKey(kp)).toBe(kp.publicKey.toBase58());
  });

  it("treats a wallet adapter as a non-Keypair with no sign fn", () => {
    const kp = Keypair.generate();
    const adapter: WalletAdapterSigner = {
      publicKey: kp.publicKey,
      signTransaction: async (tx) => tx,
    };
    expect(isKeypair(adapter)).toBe(false);
    expect(resolveSignFn(adapter)).toBeNull();
    expect(signerAddress(adapter)).toBe(kp.publicKey.toBase58());
  });

  it("honours an explicit Uint8Array secretKey override for wallet adapters", async () => {
    const kp = Keypair.generate();
    const adapter: WalletAdapterSigner = {
      publicKey: kp.publicKey,
      signTransaction: async (tx) => tx,
    };
    const sign = resolveSignFn(adapter, kp.secretKey);
    expect(sign).toBeTypeOf("function");
    const sig = await sign!(new TextEncoder().encode("hello"));
    expect(sig).toBeInstanceOf(Uint8Array);
    expect((sig as Uint8Array).length).toBe(64);
  });

  it("recognises a Keypair whose secretKey fails `instanceof Uint8Array`", () => {
    // Cross-realm regression guard from PR #235.
    const kp = Keypair.generate();
    const ctx = vm.createContext({});
    const OtherUint8Array = vm.runInContext(
      "Uint8Array",
      ctx,
    ) as Uint8ArrayConstructor;
    const otherRealmSecret = new OtherUint8Array(64);
    otherRealmSecret.set(kp.secretKey);

    expect(otherRealmSecret instanceof Uint8Array).toBe(false);
    expect(ArrayBuffer.isView(otherRealmSecret)).toBe(true);

    const crossRealmKeypair = {
      publicKey: kp.publicKey,
      secretKey: otherRealmSecret,
    };
    expect(isKeypair(crossRealmKeypair)).toBe(true);
    expect(resolveSignFn(crossRealmKeypair as never)).toBeTypeOf("function");
  });

  it("rejects objects with wrong-shaped secretKey", () => {
    expect(isKeypair(null)).toBe(false);
    expect(isKeypair(undefined)).toBe(false);
    expect(isKeypair({})).toBe(false);
    expect(isKeypair({ secretKey: "deadbeef" })).toBe(false);
    expect(isKeypair({ secretKey: new Uint8Array(32) })).toBe(false); // wrong length
    expect(isKeypair({ secretKey: new Uint8Array(64).buffer })).toBe(false); // raw ArrayBuffer
  });
});

describe("signer — EVM", () => {
  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);

  it("identifies an EVM signer and resolves a 65-byte EIP-191 signature", async () => {
    const signer: EvmPactSigner = {
      kind: "evm",
      address: account.address,
      privateKey: pk,
    };
    expect(isEvmSigner(signer)).toBe(true);
    expect(isKeypair(signer)).toBe(false);
    expect(signerVm(signer)).toBe("evm");
    expect(signerAddress(signer)).toBe(getAddress(account.address));

    const sign = resolveSignFn(signer);
    expect(sign).toBeTypeOf("function");
    const sig = await sign!(new TextEncoder().encode("hello"));
    expect(typeof sig).toBe("string");
    expect(sig as string).toMatch(/^0x[0-9a-fA-F]+$/);
    // EIP-191 secp256k1 sig = 65 bytes => "0x" + 130 hex chars
    expect((sig as string).length).toBe(132);
  });

  it("accepts a 0x-hex private key override and produces a valid signature", async () => {
    const other = generatePrivateKey();
    const otherAccount = privateKeyToAccount(other);
    const signer: EvmPactSigner = {
      kind: "evm",
      address: otherAccount.address,
    };
    const sign = resolveSignFn(signer, other);
    expect(sign).toBeTypeOf("function");
    const sig = (await sign!(new TextEncoder().encode("x"))) as string;
    expect(sig.startsWith("0x")).toBe(true);
  });

  it("returns null when an EVM signer has no private key and no override", () => {
    const signer: EvmPactSigner = {
      kind: "evm",
      address: account.address,
    };
    expect(resolveSignFn(signer)).toBeNull();
  });

  it("signerPublicKey throws for an EVM signer (Solana-only)", () => {
    const signer: EvmPactSigner = {
      kind: "evm",
      address: account.address,
      privateKey: pk,
    };
    expect(() => signerPublicKey(signer)).toThrow();
  });
});

describe("resolveSignFn — primitive selection", () => {
  it("Solana Keypair → 64-byte ed25519 signature", async () => {
    const kp = Keypair.generate();
    const sign = resolveSignFn(kp);
    const sig = (await sign!(new TextEncoder().encode("p"))) as Uint8Array;
    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig.length).toBe(64);
  });

  it("0x-prefixed private key → 65-byte secp256k1 EIP-191 signature", async () => {
    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);
    const signer: EvmPactSigner = {
      kind: "evm",
      address: account.address,
      privateKey: pk,
    };
    const sign = resolveSignFn(signer);
    const sig = (await sign!(new TextEncoder().encode("p"))) as string;
    expect(typeof sig).toBe("string");
    expect((sig.length - 2) / 2).toBe(65);
  });
});
