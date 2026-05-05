import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useRefundClaimer } from "./useRefundClaimer";

const PUBKEY = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

describe("useRefundClaimer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("does not claim when pendingRefund is 0", () => {
    const onClaim = vi.fn().mockResolvedValue(undefined);
    renderHook(() =>
      useRefundClaimer({ pubkey: PUBKEY, pendingRefund: 0, onClaim })
    );
    expect(onClaim).not.toHaveBeenCalled();
  });

  it("does not claim on first poll with pendingRefund > 0 (debounce)", () => {
    const onClaim = vi.fn().mockResolvedValue(undefined);
    renderHook(() =>
      useRefundClaimer({ pubkey: PUBKEY, pendingRefund: 500, onClaim })
    );
    expect(onClaim).not.toHaveBeenCalled();
  });

  it("claims after 2 consecutive polls with pendingRefund > 0", async () => {
    const onClaim = vi.fn().mockResolvedValue(undefined);
    // Simulate two distinct poll results both > 0 by using slightly different values
    const { rerender } = renderHook(
      ({ refund }: { refund: number }) =>
        useRefundClaimer({ pubkey: PUBKEY, pendingRefund: refund, onClaim }),
      { initialProps: { refund: 500 } }
    );
    await act(async () => {
      rerender({ refund: 501 }); // second poll: new value triggers effect
      await Promise.resolve();
    });
    expect(onClaim).toHaveBeenCalledTimes(1);
  });

  it("resets debounce when pendingRefund drops to 0", async () => {
    const onClaim = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(
      ({ refund }: { refund: number }) =>
        useRefundClaimer({ pubkey: PUBKEY, pendingRefund: refund, onClaim }),
      { initialProps: { refund: 500 } }
    );
    rerender({ refund: 0 });    // resets counter
    rerender({ refund: 501 }); // one observation only — no claim yet
    await act(async () => { await Promise.resolve(); });
    expect(onClaim).not.toHaveBeenCalled();
  });

  it("sets claiming=true while onClaim is in-flight", async () => {
    let resolve!: () => void;
    const onClaim = vi.fn(
      () => new Promise<void>((r) => { resolve = r; })
    );
    const { result, rerender } = renderHook(
      ({ refund }: { refund: number }) =>
        useRefundClaimer({ pubkey: PUBKEY, pendingRefund: refund, onClaim }),
      { initialProps: { refund: 500 } }
    );
    await act(async () => {
      rerender({ refund: 501 }); // triggers 2nd consecutive observation
      // don't await the promise — keep it in-flight
    });
    expect(result.current.claiming).toBe(true);
    await act(async () => {
      resolve();
      await Promise.resolve();
    });
    expect(result.current.claiming).toBe(false);
  });
});
