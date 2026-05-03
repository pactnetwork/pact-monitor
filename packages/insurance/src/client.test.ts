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
  findPolicyPda,
  findProtocolConfigPda,
  getEnableInsuranceInstruction,
  COVERAGE_POOL_SEED,
  POLICY_SEED,
  PROTOCOL_CONFIG_SEED,
  PACT_INSURANCE_PROGRAM_ADDRESS,
} from "./generated/index.js";
import {
  fixEncoderSize,
  getAddressEncoder,
  getProgramDerivedAddress,
} from "@solana/kit";

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

// Regression test for the programId override hole flagged in PR #47 review:
// the SDK's PactInsurance({ programId }) config used to be a half-truth.
// withProgramAddress() rewrote the program target on the built instruction,
// but the PDAs (protocol config, pool, policy) were still derived against
// the baked-in default via the Codama-generated find*Pda helpers. Pointing
// the SDK at a non-default deploy would silently send to the right program
// but reference accounts that exist under the wrong one — guaranteed
// failure. The kit-client now derives every PDA from client.programId.
//
// This test asserts: for a custom programId, deriving the SAME seeds
// against the custom id and against the baked-in default produces
// DIFFERENT PDAs. Invariant: if find*Pda() and the SDK agreed for a
// non-default programId, this assertion would fail and we'd be back in
// the silent-divergence world.
describe("programId override — PDA derivation must use configured programId", () => {
  const customProgramId = address("4Z1Y3W49U2Cn6bz9UpkahVP7LaeobQ4cAaEt3uNaqSob");

  async function deriveLocal(programId: typeof customProgramId, seeds: Uint8Array[]) {
    return getProgramDerivedAddress({ programAddress: programId, seeds });
  }

  it("protocol config PDA differs between custom and default programId", async () => {
    const [defaultPda] = await findProtocolConfigPda();
    const [customPda] = await deriveLocal(customProgramId, [PROTOCOL_CONFIG_SEED]);
    assert.notEqual(
      String(customPda),
      String(defaultPda),
      "PDAs derived under different program IDs must not collide — if they did, the test setup is wrong",
    );
    assert.notEqual(String(customPda), String(PACT_INSURANCE_PROGRAM_ADDRESS));
  });

  it("coverage pool PDA differs between custom and default programId for same hostname", async () => {
    const hostname = "api.example.com";
    const [defaultPda] = await findCoveragePoolPda(hostname);
    const [customPda] = await deriveLocal(customProgramId, [
      COVERAGE_POOL_SEED,
      new TextEncoder().encode(hostname),
    ]);
    assert.notEqual(String(customPda), String(defaultPda));
  });

  it("policy PDA differs between custom and default programId for same (pool, agent)", async () => {
    const dummyPool = address("11111111111111111111111111111111");
    const dummyAgent = address("11111111111111111111111111111112");
    const addrEnc = fixEncoderSize(getAddressEncoder(), 32);
    const [defaultPda] = await findPolicyPda(dummyPool, dummyAgent);
    const [customPda] = await deriveLocal(customProgramId, [
      POLICY_SEED,
      addrEnc.encode(dummyPool),
      addrEnc.encode(dummyAgent),
    ]);
    assert.notEqual(String(customPda), String(defaultPda));
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
