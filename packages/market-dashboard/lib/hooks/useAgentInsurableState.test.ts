/**
 * Tests for `useAgentInsurableState`.
 *
 * The hook polls the agent's USDC ATA every 5s and reports a balance/allowance
 * snapshot. We exercise the four canonical outcomes per `BalanceCheckResult`:
 *
 * 1. balance ok + allowance ok            → eligible: true
 * 2. balance ok + allowance < min_premium → eligible: false, reason mentions delegate
 * 3. balance < required + allowance ok    → eligible: false, reason mentions balance
 * 4. ATA does not exist                   → eligible: false, reason mentions ATA
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";

import {
  useAgentInsurableState,
  type InsurableInspector,
} from "./useAgentInsurableState";

const PUBKEY = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const ATA = new PublicKey("11111111111111111111111111111111");

function inspectorReturning(
  result: Partial<Awaited<ReturnType<InsurableInspector>>>
): InsurableInspector {
  return vi.fn().mockResolvedValue({
    ataBalance: 0n,
    allowance: 0n,
    eligible: false,
    ata: ATA,
    ...result,
  } as Awaited<ReturnType<InsurableInspector>>);
}

describe("useAgentInsurableState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("returns eligible: true when balance and allowance both >= required", async () => {
    const inspector = inspectorReturning({
      ataBalance: 5_000_000n,
      allowance: 25_000_000n,
      eligible: true,
    });
    const { result } = renderHook(() => useAgentInsurableState(PUBKEY, inspector));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.state?.eligible).toBe(true);
    expect(result.current.state?.ataBalance).toBe(5_000_000n);
    expect(result.current.state?.allowance).toBe(25_000_000n);
  });

  it("returns eligible: false with balance reason when ATA is empty", async () => {
    const inspector = inspectorReturning({
      ataBalance: 0n,
      allowance: 25_000_000n,
      eligible: false,
      reason: "ata balance 0 < requiredLamports 100",
    });
    const { result } = renderHook(() => useAgentInsurableState(PUBKEY, inspector));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.state?.eligible).toBe(false);
    expect(result.current.state?.reason).toMatch(/ata balance/);
  });

  it("returns eligible: false when allowance is below the min premium", async () => {
    const inspector = inspectorReturning({
      ataBalance: 5_000_000n,
      allowance: 0n,
      eligible: false,
      reason: "no delegate set; agent must SPL-Approve SettlementAuthority",
    });
    const { result } = renderHook(() => useAgentInsurableState(PUBKEY, inspector));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.state?.eligible).toBe(false);
    expect(result.current.state?.allowance).toBe(0n);
    expect(result.current.state?.reason).toMatch(/delegate/i);
  });

  it("returns eligible: false with ATA-missing reason when ATA does not exist", async () => {
    const inspector = inspectorReturning({
      ataBalance: 0n,
      allowance: 0n,
      eligible: false,
      reason: "agent ATA does not exist",
    });
    const { result } = renderHook(() => useAgentInsurableState(PUBKEY, inspector));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.state?.eligible).toBe(false);
    expect(result.current.state?.reason).toMatch(/ATA does not exist/);
  });

  it("returns null state when no pubkey is supplied", () => {
    const inspector = inspectorReturning({});
    const { result } = renderHook(() => useAgentInsurableState(null, inspector));
    expect(result.current.state).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("polls the inspector every 5s while a pubkey is set", async () => {
    const inspector = inspectorReturning({
      ataBalance: 5_000_000n,
      allowance: 25_000_000n,
      eligible: true,
    });
    renderHook(() => useAgentInsurableState(PUBKEY, inspector));
    await act(async () => {
      await Promise.resolve();
    });
    expect(inspector).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(inspector).toHaveBeenCalledTimes(2);
  });

  it("surfaces RPC errors in the error field", async () => {
    const inspector = vi.fn(() => Promise.reject(new Error("rpc down"))) as unknown as InsurableInspector;
    const { result } = renderHook(() => useAgentInsurableState(PUBKEY, inspector));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.error).toBe("rpc down");
    expect(result.current.state).toBeNull();
  });
});
