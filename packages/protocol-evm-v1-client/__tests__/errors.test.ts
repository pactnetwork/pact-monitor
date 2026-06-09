import { describe, it, expect } from "vitest";
import { toFunctionSelector } from "viem";

import {
  PACT_EVM_ERRORS,
  pactErrorSelector,
  decodePactError,
  formatPactError,
  tryExtractPactError,
} from "../src/errors.js";
import { PactErrorsAbi } from "../src/constants.js";

const ERROR_NAMES = PactErrorsAbi.filter((x) => x.type === "error").map(
  (x) => (x as { name: string }).name,
);

describe("errors — custom-error selector -> name (mirrors protocol-v1-client errors.ts)", () => {
  it("maps every one of error.rs's 30 PactError variants", () => {
    expect(Object.keys(PACT_EVM_ERRORS)).toHaveLength(30);
    expect(ERROR_NAMES).toHaveLength(30);
    for (const name of ERROR_NAMES) {
      const sel = pactErrorSelector(name);
      expect(PACT_EVM_ERRORS[sel]?.name).toBe(name);
    }
  });

  it("selectors equal an independent keccak4(signature) recomputation", () => {
    for (const name of ERROR_NAMES) {
      // all 30 PactErrors are zero-arg (handoff §(b) ruling 1) — signature is `${name}()`
      expect(pactErrorSelector(name)).toBe(toFunctionSelector(`${name}()`));
    }
  });

  it("decodePactError resolves revert data by 4-byte selector", () => {
    const sel = pactErrorSelector("ProtocolPaused");
    expect(decodePactError(sel)?.name).toBe("ProtocolPaused");
    // extra revert payload after the selector is ignored
    expect(decodePactError((sel + "deadbeef") as `0x${string}`)?.name).toBe(
      "ProtocolPaused",
    );
    expect(decodePactError("0x00000000")).toBeUndefined();
    expect(decodePactError("0x")).toBeUndefined();
  });

  it("formatPactError renders Name (selector): message", () => {
    const sel = pactErrorSelector("PoolDepleted");
    expect(formatPactError(sel)).toBe(
      `PoolDepleted (${sel}): ${PACT_EVM_ERRORS[sel].message}`,
    );
    expect(formatPactError("0x00000000")).toBe(
      "Unknown custom error (0x00000000)",
    );
  });

  it("tryExtractPactError walks viem-style nested error shapes", () => {
    const sel = pactErrorSelector("DuplicateCallId");
    expect(tryExtractPactError({ data: sel })?.name).toBe("DuplicateCallId");
    expect(
      tryExtractPactError({ cause: { cause: { data: sel + "abcd" } } })?.name,
    ).toBe("DuplicateCallId");
    expect(
      tryExtractPactError({ data: { data: sel } })?.name,
    ).toBe("DuplicateCallId");
    expect(tryExtractPactError(new Error("boom"))).toBeUndefined();
    expect(tryExtractPactError(undefined)).toBeUndefined();
  });
});
