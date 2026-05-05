import { describe, test, expect, vi } from "vitest";
import { Timer } from "../src/lib/timing.js";

describe("Timer", () => {
  test("latencyMs returns elapsed since construction", async () => {
    const timer = new Timer();
    await new Promise((r) => setTimeout(r, 20));
    timer.markFirstByte();
    const ms = timer.latencyMs();
    expect(ms).toBeGreaterThanOrEqual(15);
    expect(ms).toBeLessThan(200);
  });

  test("markFirstByte is idempotent — second call does not change reading", async () => {
    const timer = new Timer();
    await new Promise((r) => setTimeout(r, 10));
    timer.markFirstByte();
    const first = timer.latencyMs();
    await new Promise((r) => setTimeout(r, 20));
    timer.markFirstByte();
    const second = timer.latencyMs();
    expect(second).toBe(first);
  });

  test("latencyMs without markFirstByte uses current time", async () => {
    const timer = new Timer();
    await new Promise((r) => setTimeout(r, 10));
    const ms = timer.latencyMs();
    expect(ms).toBeGreaterThanOrEqual(5);
  });
});
