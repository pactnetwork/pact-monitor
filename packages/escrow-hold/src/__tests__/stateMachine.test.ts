import { describe, it, expect, vi } from "vitest";
import type { Outcome } from "@pact-network/wrap";

import { EscrowManager, nextState } from "../stateMachine";
import { InMemoryEscrowStore } from "../escrowStore";
import { StubEscrowChainAdapter } from "../chainAdapter";
import { FakeClock } from "../clock";
import { deterministicVerdictHook } from "../verdictHook";
import type { VerdictHook } from "../verdictHook";
import type { LockInput } from "../types";

const START = 1_000_000;
const WINDOW = 3600;

function lockInput(callId: string, outcome: Outcome): LockInput {
  return {
    callId,
    agentPubkey: "AgentX",
    endpointSlug: "krexa-lending",
    premiumLamports: "2000",
    outcome,
  };
}

function makeManager(overrides?: { verdictHook?: VerdictHook; holdWindowSeconds?: number }) {
  const store = new InMemoryEscrowStore();
  const chain = new StubEscrowChainAdapter();
  const clock = new FakeClock(START);
  const manager = new EscrowManager({
    store,
    chain,
    clock,
    verdictHook: overrides?.verdictHook ?? deterministicVerdictHook,
    holdWindowSeconds: overrides?.holdWindowSeconds ?? WINDOW,
  });
  return { store, chain, clock, manager };
}

describe("nextState", () => {
  it("maps actions from LOCKED", () => {
    expect(nextState("LOCKED", "release")).toBe("RELEASED");
    expect(nextState("LOCKED", "refund")).toBe("REFUNDED");
    expect(nextState("LOCKED", "hold")).toBe("LOCKED");
  });

  it("throws when transitioning a terminal state", () => {
    expect(() => nextState("RELEASED", "refund")).toThrow(/terminal/);
    expect(() => nextState("REFUNDED", "release")).toThrow(/terminal/);
  });

  it("throws on an unknown action", () => {
    // Force the exhaustiveness guard.
    expect(() => nextState("LOCKED", "bogus" as unknown as "release")).toThrow(/unknown escrow action/);
  });
});

describe("EscrowManager", () => {
  it("rejects a negative hold window", () => {
    expect(() => makeManager({ holdWindowSeconds: -1 })).toThrow(/>= 0/);
  });

  it("lock() creates a LOCKED record with a deadline = now + window and a stub lock op", async () => {
    const { manager, chain, store } = makeManager();
    const r = await manager.lock(lockInput("c1", "ok"));
    expect(r.state).toBe("LOCKED");
    expect(r.releaseDeadlineUnix).toBe(String(START + WINDOW));
    expect(r.heldPremiumLamports).toBe("2000");
    expect(store.get("c1")!.state).toBe("LOCKED");
    expect(chain.ops[0]).toMatchObject({ op: "lock", callId: "c1" });
  });

  it("finalize() before the deadline throws (and does nothing on-chain)", async () => {
    const { manager, chain } = makeManager();
    await manager.lock(lockInput("c1", "ok"));
    await expect(manager.finalize("c1")).rejects.toThrow(/not yet due/);
    expect(chain.fanoutCredited.size).toBe(0);
  });

  it("finalize() releases a good call after the deadline", async () => {
    const { manager, chain, clock, store } = makeManager();
    await manager.lock(lockInput("c1", "ok"));
    clock.advance(WINDOW + 1);
    const { record, verdict } = await manager.finalize("c1");
    expect(verdict.action).toBe("release");
    expect(record.state).toBe("RELEASED");
    expect(record.finalizeTxId).toBe("STUB-release-c1");
    expect(chain.fanoutCredited.get("c1")).toBe("2000");
    expect(store.get("c1")!.state).toBe("RELEASED");
  });

  it("finalize() refunds a breached call after the deadline", async () => {
    const { manager, chain, clock } = makeManager();
    await manager.lock(lockInput("c2", "server_error"));
    clock.advance(WINDOW + 1);
    const { record, verdict } = await manager.finalize("c2");
    expect(verdict.action).toBe("refund");
    expect(record.state).toBe("REFUNDED");
    expect(chain.agentRefunded.get("c2")).toBe("2000");
  });

  it("finalize() throws for an unknown callId", async () => {
    const { manager } = makeManager();
    await expect(manager.finalize("nope")).rejects.toThrow(/no escrow record/);
  });

  it("finalize() throws if already finalized (no double-spend)", async () => {
    const { manager, clock } = makeManager();
    await manager.lock(lockInput("c1", "ok"));
    clock.advance(WINDOW + 1);
    await manager.finalize("c1");
    await expect(manager.finalize("c1")).rejects.toThrow(/already finalized/);
  });

  it("finalize() rejects a verdict that returns 'hold' (no dispute path in PoC)", async () => {
    const holdHook: VerdictHook = {
      decide: () => ({ action: "hold", breach: false, source: "deterministic", stubbed: true }),
    };
    const { manager, clock } = makeManager({ verdictHook: holdHook });
    await manager.lock(lockInput("c1", "ok"));
    clock.advance(WINDOW + 1);
    await expect(manager.finalize("c1")).rejects.toThrow(/no dispute path/);
  });

  it("crank() finalizes only due records, leaving not-yet-due ones LOCKED", async () => {
    const { manager, store, clock } = makeManager();
    await manager.lock(lockInput("good", "ok"));
    await manager.lock(lockInput("bad", "network_error"));
    // Advance past the window so both are due.
    clock.advance(WINDOW + 1);
    // Add one more AFTER advancing so its deadline is in the future.
    await manager.lock(lockInput("fresh", "ok"));

    const results = await manager.crank();
    const finalized = results.map((r) => r.record.callId).sort();
    expect(finalized).toEqual(["bad", "good"]);
    expect(store.get("good")!.state).toBe("RELEASED");
    expect(store.get("bad")!.state).toBe("REFUNDED");
    expect(store.get("fresh")!.state).toBe("LOCKED");
  });

  it("crank() is idempotent — a second crank with no new due records does nothing", async () => {
    const { manager, clock } = makeManager();
    await manager.lock(lockInput("c1", "ok"));
    clock.advance(WINDOW + 1);
    expect((await manager.crank()).length).toBe(1);
    expect((await manager.crank()).length).toBe(0);
  });

  it("finalize surfaces a vanished record (defensive guard)", async () => {
    const { manager, store, clock } = makeManager();
    await manager.lock(lockInput("c1", "ok"));
    clock.advance(WINDOW + 1);
    // Simulate a store that loses the record right after setState.
    const realGet = store.get.bind(store);
    let calls = 0;
    vi.spyOn(store, "get").mockImplementation((id: string) => {
      calls += 1;
      // finalize() calls get() twice: 1st = existence/deadline check (must
      // return the record), 2nd = post-setState re-read (simulate loss here).
      if (calls >= 2) return undefined;
      return realGet(id);
    });
    await expect(manager.finalize("c1")).rejects.toThrow(/vanished/);
  });
});
