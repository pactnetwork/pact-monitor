import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAgentWallet } from "./useAgentWallet";

vi.mock("../api", () => ({
  fetchAgent: vi.fn(),
}));

import { fetchAgent } from "../api";
const mockFetchAgent = vi.mocked(fetchAgent);

const PUBKEY = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

const mockState = {
  agent: {
    pubkey: PUBKEY,
    balance: 5_000_000,
    pendingRefund: 300,
    totalPremiumsPaid: 1500,
    totalRefundsClaimed: 300,
    callCount: 5,
    lastActivity: "2026-05-05T10:00:00Z",
  },
  recentCalls: [],
};

describe("useAgentWallet", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("returns null state when no pubkey", () => {
    const { result } = renderHook(() => useAgentWallet(null));
    expect(result.current.walletState).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("fetches wallet state when pubkey is provided", async () => {
    mockFetchAgent.mockResolvedValue(mockState);
    const { result } = renderHook(() => useAgentWallet(PUBKEY));
    expect(result.current.loading).toBe(true);
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.walletState?.balance).toBe(5_000_000);
    expect(result.current.walletState?.pendingRefund).toBe(300);
    expect(result.current.loading).toBe(false);
  });

  it("polls every 5 seconds", async () => {
    mockFetchAgent.mockResolvedValue(mockState);
    renderHook(() => useAgentWallet(PUBKEY));
    await act(async () => { await Promise.resolve(); });
    expect(mockFetchAgent).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
    });
    expect(mockFetchAgent).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
    });
    expect(mockFetchAgent).toHaveBeenCalledTimes(3);
  });

  it("surfaces fetch errors in error field", async () => {
    mockFetchAgent.mockRejectedValue(new Error("rpc down"));
    const { result } = renderHook(() => useAgentWallet(PUBKEY));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.error).toBe("rpc down");
    expect(result.current.walletState).toBeNull();
    expect(result.current.loading).toBe(false);
  });
});
