import { describe, expect, test } from "vitest";
import { PublicKey } from "@solana/web3.js";

import { PROGRAM_ID } from "../src/constants.js";
import {
  getCallRecordPda,
  getCoveragePoolPda,
  getEndpointConfigPda,
  getProtocolConfigPda,
  getSettlementAuthorityPda,
  getTreasuryPda,
  slugBytes,
} from "../src/pda.js";

describe("PDA derivers — match the on-chain seeds in src/pda.rs", () => {
  test("slugBytes pads to 16 bytes with NUL", () => {
    const a = slugBytes("openai");
    expect(a.length).toBe(16);
    // 'o','p','e','n','a','i' = 6 bytes, rest zero
    expect(Array.from(a.slice(0, 6))).toEqual([
      0x6f, 0x70, 0x65, 0x6e, 0x61, 0x69,
    ]);
    expect(Array.from(a.slice(6))).toEqual(Array(10).fill(0));
  });

  test("slugBytes truncates strings longer than 16 bytes", () => {
    const a = slugBytes("a".repeat(20));
    expect(a.length).toBe(16);
    expect(Array.from(a)).toEqual(Array(16).fill(0x61));
  });

  test("getCoveragePoolPda matches a manual derivation with the slug seed", () => {
    const slug = slugBytes("test-ep");
    const [pda, bump] = getCoveragePoolPda(PROGRAM_ID, slug);
    const [expected, expectedBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("coverage_pool"), Buffer.from(slug)],
      PROGRAM_ID
    );
    expect(pda.equals(expected)).toBe(true);
    expect(bump).toBe(expectedBump);
  });

  test("getCoveragePoolPda accepts a string slug directly", () => {
    const [a] = getCoveragePoolPda(PROGRAM_ID, "test-ep");
    const [b] = getCoveragePoolPda(PROGRAM_ID, slugBytes("test-ep"));
    expect(a.equals(b)).toBe(true);
  });

  test("getCoveragePoolPda rejects oversized raw byte slugs", () => {
    expect(() =>
      getCoveragePoolPda(PROGRAM_ID, new Uint8Array(17))
    ).toThrow(/slug/);
  });

  test("getEndpointConfigPda uses the b\"endpoint\" seed", () => {
    const slug = slugBytes("openai");
    const [pda] = getEndpointConfigPda(PROGRAM_ID, slug);
    const [expected] = PublicKey.findProgramAddressSync(
      [Buffer.from("endpoint"), Buffer.from(slug)],
      PROGRAM_ID
    );
    expect(pda.equals(expected)).toBe(true);
  });

  test("getCallRecordPda uses the b\"call\" seed", () => {
    const callId = new Uint8Array(16).fill(0xab);
    const [pda] = getCallRecordPda(PROGRAM_ID, callId);
    const [expected] = PublicKey.findProgramAddressSync(
      [Buffer.from("call"), Buffer.from(callId)],
      PROGRAM_ID
    );
    expect(pda.equals(expected)).toBe(true);
  });

  test("getCallRecordPda rejects non-16-byte call IDs", () => {
    expect(() =>
      getCallRecordPda(PROGRAM_ID, new Uint8Array(15))
    ).toThrow(/16 bytes/);
  });

  test("singleton PDAs are stable", () => {
    const [sa1] = getSettlementAuthorityPda(PROGRAM_ID);
    const [sa2] = getSettlementAuthorityPda(PROGRAM_ID);
    expect(sa1.equals(sa2)).toBe(true);

    const [t1] = getTreasuryPda(PROGRAM_ID);
    const [t2] = getTreasuryPda(PROGRAM_ID);
    expect(t1.equals(t2)).toBe(true);

    const [pc1] = getProtocolConfigPda(PROGRAM_ID);
    const [pc2] = getProtocolConfigPda(PROGRAM_ID);
    expect(pc1.equals(pc2)).toBe(true);
  });

  test("singleton PDAs all differ from each other", () => {
    const [sa] = getSettlementAuthorityPda(PROGRAM_ID);
    const [t] = getTreasuryPda(PROGRAM_ID);
    const [pc] = getProtocolConfigPda(PROGRAM_ID);
    expect(sa.equals(t)).toBe(false);
    expect(sa.equals(pc)).toBe(false);
    expect(t.equals(pc)).toBe(false);
  });
});
