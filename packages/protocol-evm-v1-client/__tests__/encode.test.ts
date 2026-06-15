import { describe, it, expect } from "vitest";
import {
  decodeFunctionData,
  toFunctionSelector,
  zeroAddress,
  type Hex,
} from "viem";

import {
  slugToBytes16,
  padFeeRecipients,
  encodeRegisterEndpoint,
  encodeUpdateEndpointConfig,
  encodeUpdateFeeRecipients,
  encodePauseEndpoint,
  encodePauseProtocol,
  encodeTopUp,
  encodeSettleBatch,
  encodeRecordCallAndCapAccrual,
  encodeRecordRefundPaid,
  type FeeRecipientInput,
  type SettlementEventInput,
} from "../src/encode.js";
import { PactRegistryAbi, PactPoolAbi, PactSettlerAbi } from "../src/constants.js";

const TREASURY = "0x00000000000000000000000000000000000000A1" as const;

describe("encode — slug + fee-recipient helpers", () => {
  it("slugToBytes16 UTF-8 right-pads to 16 bytes", () => {
    const s = slugToBytes16("helius");
    expect(s).toMatch(/^0x[0-9a-f]{32}$/);
    expect(s).toBe("0x68656c69757300000000000000000000");
  });
  it("slugToBytes16 rejects > 16 bytes", () => {
    expect(() => slugToBytes16("x".repeat(17))).toThrow();
  });
  it("padFeeRecipients pads to exactly 8 zero entries", () => {
    const out = padFeeRecipients([{ kind: 0, destination: TREASURY, bps: 1000 }]);
    expect(out).toHaveLength(8);
    expect(out[0]).toEqual({ kind: 0, destination: TREASURY, bps: 1000 });
    expect(out[7]).toEqual({ kind: 0, destination: zeroAddress, bps: 0 });
  });
  it("padFeeRecipients rejects > 8 entries", () => {
    const many: FeeRecipientInput[] = Array.from({ length: 9 }, () => ({
      kind: 0,
      destination: TREASURY,
      bps: 1,
    }));
    expect(() => padFeeRecipients(many)).toThrow();
  });
});

function roundtrip(abi: readonly unknown[], data: Hex) {
  return decodeFunctionData({ abi: abi as never, data });
}

describe("encode — calldata builders round-trip via viem against the committed ABI", () => {
  it("registerEndpoint", () => {
    const recips: FeeRecipientInput[] = [{ kind: 0, destination: TREASURY, bps: 3000 }];
    const data = encodeRegisterEndpoint({
      slug: "helius",
      flatPremium: 1000n,
      percentBps: 50,
      slaLatencyMs: 250,
      imputedCost: 0n,
      exposureCapPerHour: 1_000_000n,
      feeRecipientsPresent: true,
      feeRecipientCount: 1,
      feeRecipients: recips,
    });
    expect(data.slice(0, 10)).toBe(
      toFunctionSelector(
        "registerEndpoint(bytes16,uint64,uint16,uint32,uint64,uint64,bool,uint8,(uint8,address,uint16)[8])",
      ),
    );
    const d = roundtrip(PactRegistryAbi, data);
    expect(d.functionName).toBe("registerEndpoint");
    expect(d.args[0]).toBe(slugToBytes16("helius"));
    expect(d.args[7]).toBe(1);
    expect((d.args[8] as readonly unknown[]).length).toBe(8);
  });

  it("updateEndpointConfig / updateFeeRecipients / pauseEndpoint / pauseProtocol", () => {
    const u = roundtrip(
      PactRegistryAbi,
      encodeUpdateEndpointConfig({
        slug: "helius",
        flatPremium: 1n,
        percentBps: 2,
        slaLatencyMs: 3,
        imputedCost: 4n,
        exposureCapPerHour: 5n,
      }),
    );
    expect(u.functionName).toBe("updateEndpointConfig");

    const fr = roundtrip(
      PactRegistryAbi,
      encodeUpdateFeeRecipients("helius", [{ kind: 0, destination: TREASURY, bps: 3000 }], 1),
    );
    expect(fr.functionName).toBe("updateFeeRecipients");
    expect((fr.args[1] as readonly unknown[]).length).toBe(8);
    expect(fr.args[2]).toBe(1);

    const pe = roundtrip(PactRegistryAbi, encodePauseEndpoint("helius", true));
    expect(pe.functionName).toBe("pauseEndpoint");
    expect(pe.args[1]).toBe(true);

    const pp = roundtrip(PactRegistryAbi, encodePauseProtocol(true));
    expect(pp.functionName).toBe("pauseProtocol");
    expect(pp.args[0]).toBe(true);
  });

  it("topUp (PactPool)", () => {
    const t = roundtrip(PactPoolAbi, encodeTopUp("helius", 500_000n));
    expect(t.functionName).toBe("topUp");
    expect(t.args[0]).toBe(slugToBytes16("helius"));
    expect(t.args[1]).toBe(500_000n);
  });

  it("settleBatch (PactSettler) preserves the SettlementEvent tuple", () => {
    const ev: SettlementEventInput = {
      callId: "0x" + "ab".repeat(16),
      agent: TREASURY,
      endpointSlug: "helius",
      premium: 1000n,
      refund: 0n,
      latencyMs: 120,
      breach: false,
      feeRecipientCountHint: 1,
      timestamp: 1_700_000_000n,
    };
    const s = roundtrip(PactSettlerAbi, encodeSettleBatch([ev]));
    expect(s.functionName).toBe("settleBatch");
    const evs = s.args[0] as readonly { callId: Hex; endpointSlug: Hex }[];
    expect(evs).toHaveLength(1);
    expect(evs[0].callId).toBe(("0x" + "ab".repeat(16)).toLowerCase());
    expect(evs[0].endpointSlug).toBe(slugToBytes16("helius"));
  });

  it("settler hooks recordCallAndCapAccrual / recordRefundPaid", () => {
    const a = roundtrip(
      PactRegistryAbi,
      encodeRecordCallAndCapAccrual("helius", 1000n, true, 500n),
    );
    expect(a.functionName).toBe("recordCallAndCapAccrual");
    const b = roundtrip(PactRegistryAbi, encodeRecordRefundPaid("helius", 500n));
    expect(b.functionName).toBe("recordRefundPaid");
  });
});
