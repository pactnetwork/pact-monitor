import { describe, it, expect } from "vitest";
import vm from "node:vm";
import { Keypair } from "@solana/web3.js";
import {
  isKeypair,
  signerPublicKey,
  resolveSecretKey,
  type WalletAdapterSigner,
} from "../signer.js";

describe("signer", () => {
  it("recognises a web3.js Keypair", () => {
    const kp = Keypair.generate();
    expect(isKeypair(kp)).toBe(true);
    expect(signerPublicKey(kp)).toBe(kp.publicKey.toBase58());
  });

  it("exposes the Keypair secret key for request signing", () => {
    const kp = Keypair.generate();
    const sk = resolveSecretKey(kp);
    expect(sk).toBeInstanceOf(Uint8Array);
    expect(sk).toEqual(kp.secretKey);
  });

  it("treats a wallet adapter as a non-Keypair with no secret", () => {
    const kp = Keypair.generate();
    const adapter: WalletAdapterSigner = {
      publicKey: kp.publicKey,
      signTransaction: async (tx) => tx,
    };
    expect(isKeypair(adapter)).toBe(false);
    expect(resolveSecretKey(adapter)).toBeNull();
    expect(signerPublicKey(adapter)).toBe(kp.publicKey.toBase58());
  });

  it("honours an explicit secretKey override for wallet adapters", () => {
    const kp = Keypair.generate();
    const adapter: WalletAdapterSigner = {
      publicKey: kp.publicKey,
      signTransaction: async (tx) => tx,
    };
    expect(resolveSecretKey(adapter, kp.secretKey)).toEqual(kp.secretKey);
  });

  it("recognises a Keypair whose secretKey fails `instanceof Uint8Array`", () => {
    // Simulates the cross-module-realm failure mode: when a caller (e.g. a
    // standalone driver script) and the SDK have different copies of
    // @solana/web3.js loaded, Keypair.secretKey is a Uint8Array constructed
    // by a different `Uint8Array` constructor identity, so `instanceof
    // Uint8Array` in the SDK's realm returns false. We reproduce that by
    // building the secretKey inside a fresh Node vm context, which has its
    // own Uint8Array constructor — an exact simulation of the bug, not a
    // prototype trick.
    const kp = Keypair.generate();
    const ctx = vm.createContext({});
    const OtherUint8Array = vm.runInContext("Uint8Array", ctx) as Uint8ArrayConstructor;
    const otherRealmSecret = new OtherUint8Array(64);
    otherRealmSecret.set(kp.secretKey);

    expect(otherRealmSecret instanceof Uint8Array).toBe(false); // sanity: old check would fail
    expect(ArrayBuffer.isView(otherRealmSecret)).toBe(true);
    expect(otherRealmSecret.length).toBe(64);

    const crossRealmKeypair = {
      publicKey: kp.publicKey,
      secretKey: otherRealmSecret,
    };
    expect(isKeypair(crossRealmKeypair)).toBe(true);
    expect(resolveSecretKey(crossRealmKeypair as never)).toBe(otherRealmSecret);
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
