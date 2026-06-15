import { describe, it, expect, vi } from "vitest";
import { PactEventEmitter } from "../events.js";

function degraded(reason: string) {
  return { reason, url: "https://x/y", ts: "2026-05-18T00:00:00.000Z" };
}

describe("PactEventEmitter", () => {
  it("delivers typed args to on() listeners and returns this for chaining", () => {
    const e = new PactEventEmitter();
    const seen: string[] = [];
    const ret = e.on("degraded", (ev) => seen.push(ev.reason));
    expect(ret).toBe(e);
    expect(e.emit("degraded", degraded("unregistered"))).toBe(true);
    expect(seen).toEqual(["unregistered"]);
  });

  it("emit on an event with no listeners returns false", () => {
    expect(new PactEventEmitter().emit("degraded", degraded("x"))).toBe(false);
  });

  it("off() removes a specific listener", () => {
    const e = new PactEventEmitter();
    const a = vi.fn();
    const b = vi.fn();
    e.on("degraded", a).on("degraded", b);
    e.off("degraded", a);
    e.emit("degraded", degraded("r"));
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledOnce();
  });

  it("isolates a throwing listener so the golden-rule emit never throws", () => {
    const e = new PactEventEmitter();
    const after = vi.fn();
    e.on("degraded", () => {
      throw new Error("listener blew up");
    });
    e.on("degraded", after);
    expect(() => e.emit("degraded", degraded("r"))).not.toThrow();
    expect(after).toHaveBeenCalledOnce();
  });

  it("a listener mutating listeners mid-emit does not corrupt the current dispatch", () => {
    const e = new PactEventEmitter();
    const late = vi.fn();
    e.on("degraded", () => e.on("degraded", late));
    e.emit("degraded", degraded("r"));
    // `late` was registered during dispatch; it must NOT fire this round.
    expect(late).not.toHaveBeenCalled();
    e.emit("degraded", degraded("r"));
    expect(late).toHaveBeenCalledOnce();
  });

  it("removeAllListeners() clears every event", () => {
    const e = new PactEventEmitter();
    const fn = vi.fn();
    e.on("refund", fn);
    e.removeAllListeners();
    expect(
      e.emit("refund", {
        callId: "c",
        slug: "s",
        refundLamports: 1n,
        settledAt: new Date(),
        txSignature: "sig",
      }),
    ).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });
});
