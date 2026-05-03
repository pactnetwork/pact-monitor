import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { address, createKeyPairSignerFromBytes } from "@solana/kit";
import { getApproveInstruction } from "@solana-program/token";
import { PactInsurance } from "./client.js";
import { createAnchorClient } from "./legacy-anchor-client.js";
import {
  findCoveragePoolPda,
  getEnableInsuranceInstruction,
} from "./generated/index.js";

// Regression test for the kit/web3 instruction-shape bug. Prior version of
// kit-client.ts called createApproveInstruction() (web3.js shape:
// { programId: PublicKey, keys: [{pubkey: PublicKey}] }) and cast it to a
// kit Instruction (kit shape: { programAddress: string, accounts: [{address: string}] }).
// kit's transaction encoder then called address() on each account-meta, which
// got `undefined` (PublicKey has no .address field) and threw "Expected
// base58-encoded address string of length in the range [32, 44]. Actual
// length: 9" (the 9 chars of "undefined").
//
// Every instruction the SDK builds must satisfy the kit shape: programAddress
// is a base58 string of length 32-44, every account-meta has an .address that
// is also a base58 string of length 32-44. If this test fails, do not
// re-introduce a web3.js TransactionInstruction into the SDK without a kit
// adapter — the kit transaction encoder cannot handle the web3.js shape.
describe("kit instruction shape — regression for the 'length 9' bug", () => {
  function isKitAddressString(v: unknown): v is string {
    return typeof v === "string" && v.length >= 32 && v.length <= 44;
  }

  it("getApproveInstruction produces a kit-shaped Instruction (programAddress + accounts[].address as strings)", async () => {
    const kp = Keypair.generate();
    const signer = await createKeyPairSignerFromBytes(kp.secretKey);
    const usdcMint = new PublicKey("5vcEdU8fBksfRH42wrebUV6dNEENPbdaBtAmw79ZNuSE");
    const ata = getAssociatedTokenAddressSync(usdcMint, kp.publicKey);
    const [poolAddr] = await findCoveragePoolPda("api.example.com");

    const ix = getApproveInstruction({
      source: address(ata.toBase58()),
      delegate: poolAddr,
      owner: signer,
      amount: 1_000_000n,
    });

    assert.ok(isKitAddressString(ix.programAddress as unknown), `programAddress should be a base58 string of length 32-44, got ${typeof ix.programAddress}: ${String(ix.programAddress)}`);
    for (const [i, acct] of (ix.accounts as unknown as Array<{ address: unknown }>).entries()) {
      assert.ok(
        isKitAddressString(acct.address),
        `accounts[${i}].address must be a base58 string of length 32-44 (kit shape). Got: ${typeof acct.address}: ${String(acct.address)}`,
      );
    }
  });

  it("getEnableInsuranceInstruction produces a kit-shaped Instruction with all addresses as strings", async () => {
    const kp = Keypair.generate();
    const signer = await createKeyPairSignerFromBytes(kp.secretKey);
    const dummyAddr = address("11111111111111111111111111111111");

    const ix = getEnableInsuranceInstruction({
      config: dummyAddr,
      pool: dummyAddr,
      policy: dummyAddr,
      agentTokenAccount: dummyAddr,
      agent: signer,
      args: {
        agentId: "test-agent",
        expiresAt: 0n,
        referrer: new Uint8Array(32),
        referrerPresent: 0,
        referrerShareBps: 0,
      },
    });

    assert.ok(isKitAddressString(ix.programAddress as unknown), `programAddress should be a base58 string`);
    for (const [i, acct] of (ix.accounts as unknown as Array<{ address: unknown }>).entries()) {
      assert.ok(
        isKitAddressString(acct.address),
        `accounts[${i}].address must be a base58 string of length 32-44. Got: ${typeof acct.address}: ${String(acct.address)}`,
      );
    }
  });
});

describe("createAnchorClient programId override", () => {
  it("uses opts.programId rather than the address embedded in the bundled IDL", () => {
    // A valid base58 pubkey that differs from the IDL's embedded devnet
    // address (2Go74eCvY8vCco3WPuteGzrhKz8v3R7Pcp5tjuFpcmN3). If the IDL's
    // address leaks through, program.programId will NOT match this value.
    const overrideId = "4Z1Y3W49U2Cn6bz9UpkahVP7LaeobQ4cAaEt3uNaqSob";
    const kp = Keypair.generate();
    const client = createAnchorClient({
      rpcUrl: "http://127.0.0.1:8899",
      programId: overrideId,
      agentKeypair: kp,
    });
    assert.equal(client.programId.toBase58(), overrideId);
    assert.equal(client.program.programId.toBase58(), overrideId);
  });
});

describe("PactInsurance.submitClaim", () => {
  it("sends Authorization: Bearer header when apiKey is configured", async () => {
    const kp = Keypair.generate();
    const insurance = new PactInsurance(
      {
        rpcUrl: "http://127.0.0.1:8899",
        programId: "4Z1Y3W49U2Cn6bz9UpkahVP7LaeobQ4cAaEt3uNaqSob",
        backendUrl: "http://backend.test",
        apiKey: "pact_test_key",
      },
      kp,
    );

    let capturedHeaders: Record<string, string> | undefined;
    const original = globalThis.fetch;
    globalThis.fetch = async (_url: unknown, init: RequestInit | undefined) => {
      capturedHeaders = init!.headers as Record<string, string>;
      return new Response(
        JSON.stringify({ signature: "x", slot: 1, refundAmount: 0 }),
        { status: 200 },
      );
    };
    try {
      await insurance.submitClaim("example.com", "call-id-1");
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(capturedHeaders?.Authorization, "Bearer pact_test_key");
  });

  it("does NOT send Authorization header when apiKey is omitted", async () => {
    const kp = Keypair.generate();
    const insurance = new PactInsurance(
      {
        rpcUrl: "http://127.0.0.1:8899",
        programId: "4Z1Y3W49U2Cn6bz9UpkahVP7LaeobQ4cAaEt3uNaqSob",
        backendUrl: "http://backend.test",
      },
      kp,
    );

    let capturedHeaders: Record<string, string> | undefined;
    const original = globalThis.fetch;
    globalThis.fetch = async (_url: unknown, init: RequestInit | undefined) => {
      capturedHeaders = init!.headers as Record<string, string>;
      return new Response(
        JSON.stringify({ signature: "x", slot: 1, refundAmount: 0 }),
        { status: 200 },
      );
    };
    try {
      await insurance.submitClaim("example.com", "call-id-1");
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(capturedHeaders?.Authorization, undefined);
  });

  it("does NOT send Authorization header when apiKey is whitespace-only", async () => {
    const kp = Keypair.generate();
    const insurance = new PactInsurance(
      {
        rpcUrl: "http://127.0.0.1:8899",
        programId: "4Z1Y3W49U2Cn6bz9UpkahVP7LaeobQ4cAaEt3uNaqSob",
        backendUrl: "http://backend.test",
        apiKey: "   ",
      },
      kp,
    );

    let capturedHeaders: Record<string, string> | undefined;
    const original = globalThis.fetch;
    globalThis.fetch = async (_url: unknown, init: RequestInit | undefined) => {
      capturedHeaders = init!.headers as Record<string, string>;
      return new Response(
        JSON.stringify({ signature: "x", slot: 1, refundAmount: 0 }),
        { status: 200 },
      );
    };
    try {
      await insurance.submitClaim("example.com", "call-id-1");
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(capturedHeaders?.Authorization, undefined);
  });
});
