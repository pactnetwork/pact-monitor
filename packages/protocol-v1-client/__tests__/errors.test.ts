import { describe, expect, test } from "vitest";

import {
  PROTOCOL_V1_ERRORS,
  decodeProtocolError,
  formatProtocolError,
  tryExtractProtocolError,
} from "../src/errors.js";

const EXPECTED_CODES = [
  6000, 6001, 6002, 6005, 6006, 6007, 6008, 6010, 6011, 6012, 6013, 6014,
  6015, 6016, 6017, 6018, 6019, 6020, 6021, 6022, 6023, 6024, 6025, 6026,
  // codex 2026-05-05 review fixes:
  6027, 6028, 6029, 6030, 6031,
  // mainnet kill-switch (2026-05-06):
  6032,
];

describe("error decoder", () => {
  test("every PactError variant from error.rs has a TS mapping", () => {
    for (const code of EXPECTED_CODES) {
      const e = decodeProtocolError(code);
      expect(e, `code ${code} missing`).toBeDefined();
      expect(e!.name.length).toBeGreaterThan(0);
      expect(e!.message.length).toBeGreaterThan(0);
    }
    // 6003, 6004, 6009 are reserved gaps — must NOT be in the map.
    for (const reserved of [6003, 6004, 6009]) {
      expect(decodeProtocolError(reserved)).toBeUndefined();
    }
  });

  test("PROTOCOL_V1_ERRORS contains exactly the documented codes", () => {
    const present = Object.keys(PROTOCOL_V1_ERRORS).map((s) => Number(s)).sort(
      (a, b) => a - b
    );
    expect(present).toEqual(EXPECTED_CODES);
  });

  test("formatProtocolError on a known code returns Name (code): message", () => {
    const s = formatProtocolError(6010);
    expect(s).toMatch(/PoolDepleted/);
    expect(s).toMatch(/6010/);
  });

  test("formatProtocolError on unknown code returns Custom marker", () => {
    expect(formatProtocolError(9999)).toMatch(/Custom\(9999\)/);
  });

  test("tryExtractProtocolError walks nested InstructionError shape", () => {
    const err = {
      name: "SendTransactionError",
      transactionError: {
        InstructionError: [0, { Custom: 6010 }],
      },
    };
    const out = tryExtractProtocolError(err);
    expect(out).toBeDefined();
    expect(out!.code).toBe(6010);
    expect(out!.name).toBe("PoolDepleted");
  });

  test("tryExtractProtocolError returns undefined when no Custom is found", () => {
    expect(tryExtractProtocolError({ message: "boom" })).toBeUndefined();
    expect(tryExtractProtocolError(null)).toBeUndefined();
    expect(tryExtractProtocolError("string")).toBeUndefined();
  });

  test("tryExtractProtocolError handles unknown codes", () => {
    const out = tryExtractProtocolError({
      InstructionError: [0, { Custom: 7777 }],
    });
    expect(out).toEqual({
      code: 7777,
      name: "Unknown",
      message: "Custom(7777)",
    });
  });
});
