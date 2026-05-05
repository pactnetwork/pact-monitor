import { describe, test, expect, vi } from "vitest";
import { Allowlist } from "../src/lib/allowlist.js";

describe("Allowlist", () => {
  test("returns true for known pubkey", async () => {
    const mockPg = { query: vi.fn().mockResolvedValue({ rows: [{ pubkey: "abc123" }] }) };
    const list = new Allowlist(mockPg as any, "demo_allowlist");
    expect(await list.has("abc123")).toBe(true);
    expect(await list.has("unknown")).toBe(false);
  });

  test("caches after first load", async () => {
    const mockPg = { query: vi.fn().mockResolvedValue({ rows: [{ pubkey: "abc123" }] }) };
    const list = new Allowlist(mockPg as any, "demo_allowlist");
    await list.has("abc123");
    await list.has("abc123");
    expect(mockPg.query).toHaveBeenCalledTimes(1);
  });

  test("reload() forces refresh", async () => {
    const mockPg = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const list = new Allowlist(mockPg as any, "demo_allowlist");
    await list.has("x");
    await list.reload();
    await list.has("x");
    expect(mockPg.query).toHaveBeenCalledTimes(2);
  });
});
