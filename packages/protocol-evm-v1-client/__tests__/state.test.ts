import { describe, it, expect } from "vitest";
import {
  encodeFunctionResult,
  encodeEventTopics,
  encodeAbiParameters,
  type Hex,
} from "viem";

import {
  SettlementStatus,
  FeeRecipientKind,
  decodeEndpointConfig,
  decodePoolState,
  decodeIsRegistered,
  decodeProtocolPaused,
  decodeAuthority,
  decodeTreasuryVault,
  decodeMaxTotalFeeBps,
  decodePactEventLog,
} from "../src/state.js";
import { PactRegistryAbi, PactPoolAbi, PactEventsAbi } from "../src/constants.js";

const ADDR = "0x00000000000000000000000000000000000000A1" as const;
const SLUG16 = "0x68656c69757300000000000000000000" as Hex;

describe("state — enums mirror SettlementStatus / FeeRecipientKind", () => {
  it("SettlementStatus parity (settle_batch.rs)", () => {
    expect(SettlementStatus.Settled).toBe(0);
    expect(SettlementStatus.DelegateFailed).toBe(1);
    expect(SettlementStatus.PoolDepleted).toBe(2);
    expect(SettlementStatus.ExposureCapClamped).toBe(3);
  });
  it("FeeRecipientKind parity (kind preserved on the wire, §4 #7)", () => {
    expect(FeeRecipientKind.Treasury).toBe(0);
    expect(FeeRecipientKind.AffiliateAta).toBe(1);
    expect(FeeRecipientKind.AffiliatePda).toBe(2);
  });
});

describe("state — view-call return decoders", () => {
  it("decodeEndpointConfig round-trips the EndpointConfig struct", () => {
    const ep = {
      paused: false,
      flatPremium: 1000n,
      percentBps: 50,
      slaLatencyMs: 250,
      imputedCost: 0n,
      exposureCapPerHour: 1_000_000n,
      totalCalls: 7n,
      totalBreaches: 1n,
      totalPremiums: 7000n,
      totalRefunds: 500n,
      currentPeriodStart: 1_700_000_000n,
      currentPeriodRefunds: 500n,
      lastUpdated: 1_700_000_500n,
      feeRecipientCount: 1,
      feeRecipients: Array.from({ length: 8 }, (_, i) =>
        i === 0
          ? { kind: 0, destination: ADDR, bps: 3000 }
          : { kind: 0, destination: "0x0000000000000000000000000000000000000000", bps: 0 },
      ),
    };
    const data = encodeFunctionResult({
      abi: PactRegistryAbi,
      functionName: "getEndpoint",
      result: ep as never,
    });
    const d = decodeEndpointConfig(data);
    expect(d.totalCalls).toBe(7n);
    expect(d.feeRecipientCount).toBe(1);
    expect(d.feeRecipients[0].bps).toBe(3000);
    expect(d.currentPeriodRefunds).toBe(500n);
  });

  it("decodePoolState round-trips the PoolState struct", () => {
    const ps = {
      currentBalance: 900_000n,
      totalDeposits: 1_000_000n,
      totalPremiums: 7000n,
      totalRefunds: 500n,
      createdAt: 1_700_000_000n,
    };
    const data = encodeFunctionResult({
      abi: PactPoolAbi,
      functionName: "balanceOf",
      result: ps as never,
    });
    const d = decodePoolState(data);
    expect(d.currentBalance).toBe(900_000n);
    expect(d.createdAt).toBe(1_700_000_000n);
  });

  it("scalar view decoders", () => {
    expect(
      decodeIsRegistered(
        encodeFunctionResult({ abi: PactRegistryAbi, functionName: "isRegistered", result: true }),
      ),
    ).toBe(true);
    expect(
      decodeProtocolPaused(
        encodeFunctionResult({ abi: PactRegistryAbi, functionName: "protocolPaused", result: false }),
      ),
    ).toBe(false);
    expect(
      decodeAuthority(
        encodeFunctionResult({ abi: PactRegistryAbi, functionName: "authority", result: ADDR }),
      ),
    ).toBe(ADDR);
    expect(
      decodeTreasuryVault(
        encodeFunctionResult({ abi: PactRegistryAbi, functionName: "treasuryVault", result: ADDR }),
      ),
    ).toBe(ADDR);
    expect(
      decodeMaxTotalFeeBps(
        encodeFunctionResult({ abi: PactRegistryAbi, functionName: "maxTotalFeeBps", result: 3000 }),
      ),
    ).toBe(3000);
  });
});

describe("state — event log decoders (PactEvents, indexer truth source §4 #3)", () => {
  it("decodes CallSettled", () => {
    const args = {
      callId: ("0x" + "ab".repeat(16)) as Hex,
      slug: SLUG16,
      agent: ADDR,
      premium: 1000n,
      refund: 0n,
      actualRefund: 0n,
      status: 0,
      breach: false,
      latencyMs: 120,
      timestamp: 1_700_000_000n,
    };
    const topics = encodeEventTopics({
      abi: PactEventsAbi,
      eventName: "CallSettled",
      args: { callId: args.callId, slug: args.slug, agent: args.agent },
    });
    const data = encodeAbiParameters(
      [
        { name: "premium", type: "uint64" },
        { name: "refund", type: "uint64" },
        { name: "actualRefund", type: "uint64" },
        { name: "status", type: "uint8" },
        { name: "breach", type: "bool" },
        { name: "latencyMs", type: "uint32" },
        { name: "timestamp", type: "uint64" },
      ],
      [args.premium, args.refund, args.actualRefund, args.status, args.breach, args.latencyMs, args.timestamp],
    );
    const ev = decodePactEventLog({ data, topics });
    expect(ev.eventName).toBe("CallSettled");
    expect((ev.args as { status: number }).status).toBe(SettlementStatus.Settled);
    expect((ev.args as { callId: Hex }).callId).toBe(args.callId.toLowerCase());
  });

  it("decodes EndpointRegistered (indexed-only)", () => {
    const topics = encodeEventTopics({
      abi: PactEventsAbi,
      eventName: "EndpointRegistered",
      args: { slug: SLUG16 },
    });
    const ev = decodePactEventLog({ data: "0x", topics });
    expect(ev.eventName).toBe("EndpointRegistered");
    expect((ev.args as { slug: Hex }).slug).toBe(SLUG16);
  });
});
