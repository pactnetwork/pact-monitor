import { describe, test, expect, vi } from "vitest";
import { BalanceCache } from "../src/lib/balance.js";

function makeAccountData(balanceLamports: bigint): Buffer {
  // discriminator (8) + owner pubkey (32) + balance u64 LE (8)
  const buf = Buffer.alloc(48);
  buf.writeBigUInt64LE(balanceLamports, 40);
  return buf;
}

describe("BalanceCache", () => {
  test("decodes balance from account data", async () => {
    const data = makeAccountData(12345678n);
    const mockRpc = { getAccountInfo: vi.fn().mockResolvedValue({ data }) };
    const cache = new BalanceCache(mockRpc);
    const bal = await cache.get("wallet1");
    expect(bal).toBe(12345678n);
  });

  test("returns cached value on second call", async () => {
    const data = makeAccountData(999n);
    const mockRpc = { getAccountInfo: vi.fn().mockResolvedValue({ data }) };
    const cache = new BalanceCache(mockRpc);
    await cache.get("wallet1");
    await cache.get("wallet1");
    expect(mockRpc.getAccountInfo).toHaveBeenCalledTimes(1);
  });

  test("returns 0n when account does not exist", async () => {
    const mockRpc = { getAccountInfo: vi.fn().mockResolvedValue(null) };
    const cache = new BalanceCache(mockRpc);
    const bal = await cache.get("nonexistent");
    expect(bal).toBe(0n);
  });

  test("returns 0n and does not throw on RPC error", async () => {
    const mockRpc = { getAccountInfo: vi.fn().mockRejectedValue(new Error("timeout")) };
    const cache = new BalanceCache(mockRpc);
    const bal = await cache.get("errwallet");
    expect(bal).toBe(0n);
  });
});
