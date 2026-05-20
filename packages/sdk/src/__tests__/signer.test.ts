import { describe, it, expect } from "vitest";
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
});
