import { describe, it, expect } from "vitest";

import {
  defaultFeeRecipients,
  validateFeeRecipients,
} from "../src/helpers.js";
import { FeeRecipientKind } from "../src/state.js";
import * as pkg from "../src/index.js";

const TREASURY = "0x00000000000000000000000000000000000000A1";
const AFFILIATE = "0x00000000000000000000000000000000000000B2";
const OTHER = "0x00000000000000000000000000000000000000C3";

describe("helpers — defaultFeeRecipients (V1 template parity)", () => {
  it("treasury-only: [Treasury 10%], count 1", () => {
    const d = defaultFeeRecipients(TREASURY);
    expect(d.feeRecipientCount).toBe(1);
    expect(d.feeRecipients).toEqual([
      { kind: FeeRecipientKind.Treasury, destination: TREASURY, bps: 1000 },
    ]);
  });
  it("with affiliate: [Treasury 10%, Affiliate 5%], count 2", () => {
    const d = defaultFeeRecipients(TREASURY, AFFILIATE);
    expect(d.feeRecipientCount).toBe(2);
    expect(d.feeRecipients[1]).toEqual({
      kind: FeeRecipientKind.AffiliateAta,
      destination: AFFILIATE,
      bps: 500,
    });
  });
});

describe("helpers — validateFeeRecipients mirrors fee.rs invariant order", () => {
  const ok = [
    { kind: 0, destination: TREASURY, bps: 1000 },
    { kind: 1, destination: AFFILIATE, bps: 500 },
  ];
  it("accepts a valid set", () => {
    expect(validateFeeRecipients(ok, 2, 3000).valid).toBe(true);
  });
  it("count != length", () => {
    expect(validateFeeRecipients(ok, 1, 3000)).toMatchObject({ valid: false });
  });
  it("count > 8 -> FeeRecipientArrayTooLong", () => {
    const many = Array.from({ length: 9 }, () => ({ kind: 0, destination: TREASURY, bps: 1 }));
    expect(validateFeeRecipients(many, 9, 3000).reason).toMatch(/ArrayTooLong/);
  });
  it("maxTotalFeeBps > 10000 -> FeeBpsExceedsCap", () => {
    expect(validateFeeRecipients(ok, 2, 10001).reason).toMatch(/ExceedsCap/);
  });
  it("invalid kind", () => {
    expect(
      validateFeeRecipients([{ kind: 5, destination: TREASURY, bps: 10 }], 1, 3000).reason,
    ).toMatch(/InvalidFeeRecipientKind/);
  });
  it("entry bps > 10000 -> FeeBpsExceedsCap", () => {
    expect(
      validateFeeRecipients([{ kind: 0, destination: TREASURY, bps: 10001 }], 1, 3000).reason,
    ).toMatch(/ExceedsCap/);
  });
  it("multiple treasury", () => {
    expect(
      validateFeeRecipients(
        [
          { kind: 0, destination: TREASURY, bps: 100 },
          { kind: 0, destination: OTHER, bps: 100 },
        ],
        2,
        3000,
      ).reason,
    ).toMatch(/MultipleTreasury/);
  });
  it("duplicate destination (case-insensitive address compare)", () => {
    expect(
      validateFeeRecipients(
        [
          { kind: 0, destination: TREASURY, bps: 100 },
          { kind: 1, destination: TREASURY.toLowerCase(), bps: 100 },
        ],
        2,
        3000,
      ).reason,
    ).toMatch(/DuplicateDestination/);
  });
  it("sum > 10000 -> FeeBpsSumOver10k", () => {
    expect(
      validateFeeRecipients(
        [
          { kind: 0, destination: TREASURY, bps: 6000 },
          { kind: 1, destination: AFFILIATE, bps: 5000 },
        ],
        2,
        10000,
      ).reason,
    ).toMatch(/SumOver10k/);
  });
  it("sum > maxTotalFeeBps -> FeeBpsExceedsCap", () => {
    expect(
      validateFeeRecipients(
        [
          { kind: 0, destination: TREASURY, bps: 2000 },
          { kind: 1, destination: AFFILIATE, bps: 2000 },
        ],
        2,
        3000,
      ).reason,
    ).toMatch(/ExceedsCap/);
  });
});

describe("index — re-export surface parallels protocol-v1-client", () => {
  it("exposes encode/state/errors/constants/addresses/helpers surface", () => {
    for (const name of [
      "encodeSettleBatch",
      "decodeEndpointConfig",
      "PACT_EVM_ERRORS",
      "ARC_TESTNET_CHAIN_ID",
      "DEPLOYMENTS",
      "defaultFeeRecipients",
      "SettlementStatus",
      "PactSettlerAbi",
    ]) {
      expect(pkg).toHaveProperty(name);
    }
  });
});
