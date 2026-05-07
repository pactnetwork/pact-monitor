import { describe, it, expect, vi } from "vitest";
import { createDefaultBalanceCheck } from "../balanceCheck";

interface RpcCall {
  method: string;
  params: unknown[];
}

/**
 * Builds a fake fetch that responds to JSON-RPC calls with the given
 * sequence of result/error envelopes. Records every call for assertions.
 */
function fakeRpc(handlers: Record<string, (params: unknown[], call: number) => any>) {
  const calls: RpcCall[] = [];
  const counts: Record<string, number> = {};
  const fetchImpl = vi.fn(async (_url: any, init?: any) => {
    const body = JSON.parse(init.body as string);
    calls.push({ method: body.method, params: body.params });
    const handler = handlers[body.method];
    if (!handler) throw new Error(`unhandled rpc method: ${body.method}`);
    counts[body.method] = (counts[body.method] ?? 0) + 1;
    const envelope = handler(body.params, counts[body.method] - 1);
    return new Response(JSON.stringify(envelope), { status: 200 });
  });
  return { fetchImpl, calls };
}

const tokenAccountResp = (amount: string) => ({
  result: { value: { amount, decimals: 6, uiAmount: Number(amount) / 1e6, uiAmountString: amount } },
});

const accountInfoResp = (delegatedAmount: string | null) => ({
  result: {
    value: {
      data: {
        parsed: {
          info: delegatedAmount === null
            ? { mint: "USDC...", owner: "wallet" }
            : { mint: "USDC...", owner: "wallet", delegatedAmount: { amount: delegatedAmount, decimals: 6 } },
        },
      },
      executable: false,
      lamports: 2039280,
      owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      rentEpoch: 0,
    },
  },
});

describe("createDefaultBalanceCheck", () => {
  const opts = (overrides: Partial<Parameters<typeof createDefaultBalanceCheck>[0]> = {}) => ({
    rpcUrl: "https://rpc.test",
    resolveAta: () => "Ata11111",
    ...overrides,
  });

  it("returns eligible when balance and allowance both cover required", async () => {
    const { fetchImpl } = fakeRpc({
      getTokenAccountBalance: () => tokenAccountResp("5000"),
      getAccountInfo: () => accountInfoResp("5000"),
    });
    const bc = createDefaultBalanceCheck(opts({ fetchImpl }));
    const r = await bc.check("Wallet1", 1000n);
    expect(r.eligible).toBe(true);
    if (r.eligible) {
      expect(r.ataBalance).toBe(5000n);
      expect(r.allowance).toBe(5000n);
    }
  });

  it("rejects with insufficient_balance when balance < required", async () => {
    const { fetchImpl } = fakeRpc({
      getTokenAccountBalance: () => tokenAccountResp("100"),
      getAccountInfo: () => accountInfoResp("5000"),
    });
    const bc = createDefaultBalanceCheck(opts({ fetchImpl }));
    const r = await bc.check("Wallet1", 1000n);
    expect(r.eligible).toBe(false);
    if (!r.eligible) {
      expect(r.reason).toBe("insufficient_balance");
      expect(r.ataBalance).toBe(100n);
      expect(r.allowance).toBe(5000n);
    }
  });

  it("rejects with insufficient_allowance when allowance < required", async () => {
    const { fetchImpl } = fakeRpc({
      getTokenAccountBalance: () => tokenAccountResp("5000"),
      getAccountInfo: () => accountInfoResp("100"),
    });
    const bc = createDefaultBalanceCheck(opts({ fetchImpl }));
    const r = await bc.check("Wallet1", 1000n);
    expect(r.eligible).toBe(false);
    if (!r.eligible) {
      expect(r.reason).toBe("insufficient_allowance");
    }
  });

  it("rejects with insufficient_allowance when no delegate is set", async () => {
    const { fetchImpl } = fakeRpc({
      getTokenAccountBalance: () => tokenAccountResp("5000"),
      getAccountInfo: () => accountInfoResp(null),
    });
    const bc = createDefaultBalanceCheck(opts({ fetchImpl }));
    const r = await bc.check("Wallet1", 1000n);
    expect(r.eligible).toBe(false);
    if (!r.eligible) expect(r.reason).toBe("insufficient_allowance");
  });

  it("rejects with no_ata when getTokenAccountBalance returns 'could not find account'", async () => {
    const { fetchImpl } = fakeRpc({
      getTokenAccountBalance: () => ({
        error: { code: -32602, message: "Invalid params: could not find account" },
      }),
      getAccountInfo: () => accountInfoResp("0"),
    });
    const bc = createDefaultBalanceCheck(opts({ fetchImpl }));
    const r = await bc.check("Wallet1", 1000n);
    expect(r.eligible).toBe(false);
    if (!r.eligible) expect(r.reason).toBe("no_ata");
  });

  it("rejects with no_ata when getAccountInfo returns null value", async () => {
    const { fetchImpl } = fakeRpc({
      getTokenAccountBalance: () => tokenAccountResp("5000"),
      getAccountInfo: () => ({ result: { value: null } }),
    });
    const bc = createDefaultBalanceCheck(opts({ fetchImpl }));
    const r = await bc.check("Wallet1", 1000n);
    expect(r.eligible).toBe(false);
    if (!r.eligible) expect(r.reason).toBe("no_ata");
  });

  it("throws when getTokenAccountBalance returns an unrecognized error", async () => {
    const { fetchImpl } = fakeRpc({
      getTokenAccountBalance: () => ({
        error: { code: -32000, message: "rpc upstream broke" },
      }),
      getAccountInfo: () => accountInfoResp("5000"),
    });
    const bc = createDefaultBalanceCheck(opts({ fetchImpl }));
    await expect(bc.check("Wallet1", 1000n)).rejects.toThrow(/rpc upstream broke/);
  });

  it("throws when getAccountInfo returns an error", async () => {
    const { fetchImpl } = fakeRpc({
      getTokenAccountBalance: () => tokenAccountResp("5000"),
      getAccountInfo: () => ({
        error: { code: -32000, message: "info broke" },
      }),
    });
    const bc = createDefaultBalanceCheck(opts({ fetchImpl }));
    await expect(bc.check("Wallet1", 1000n)).rejects.toThrow(/info broke/);
  });

  it("throws when RPC HTTP status is non-2xx", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("", { status: 500 }),
    ) as unknown as typeof fetch;
    const bc = createDefaultBalanceCheck(opts({ fetchImpl }));
    await expect(bc.check("Wallet1", 1000n)).rejects.toThrow(/500/);
  });

  it("caches successful results within ttl (single RPC pair for repeated calls)", async () => {
    const { fetchImpl, calls } = fakeRpc({
      getTokenAccountBalance: () => tokenAccountResp("5000"),
      getAccountInfo: () => accountInfoResp("5000"),
    });
    let now = 1_000;
    const bc = createDefaultBalanceCheck(
      opts({ fetchImpl, cacheTtlMs: 30_000, now: () => now }),
    );
    await bc.check("Wallet1", 1000n);
    await bc.check("Wallet1", 1000n);
    await bc.check("Wallet1", 1000n);
    expect(calls).toHaveLength(2); // one RPC pair, then cached.
    now += 60_000;
    await bc.check("Wallet1", 1000n);
    expect(calls).toHaveLength(4); // ttl expired → refetched.
  });

  it("caches per-wallet (different wallets do not share cache)", async () => {
    const { fetchImpl, calls } = fakeRpc({
      getTokenAccountBalance: () => tokenAccountResp("5000"),
      getAccountInfo: () => accountInfoResp("5000"),
    });
    const bc = createDefaultBalanceCheck(opts({ fetchImpl }));
    await bc.check("WalletA", 100n);
    await bc.check("WalletB", 100n);
    expect(calls).toHaveLength(4); // 2 RPC pairs.
  });

  it("caches the no_ata negative result too", async () => {
    let invoked = 0;
    const { fetchImpl } = fakeRpc({
      getTokenAccountBalance: () => {
        invoked++;
        return {
          error: { code: -32602, message: "could not find account" },
        };
      },
      getAccountInfo: () => accountInfoResp("0"),
    });
    const bc = createDefaultBalanceCheck(opts({ fetchImpl }));
    await bc.check("Wallet1", 1000n);
    await bc.check("Wallet1", 1000n);
    expect(invoked).toBe(1);
  });

  it("supports async resolveAta", async () => {
    const { fetchImpl } = fakeRpc({
      getTokenAccountBalance: () => tokenAccountResp("5000"),
      getAccountInfo: () => accountInfoResp("5000"),
    });
    const resolveAta = vi.fn(async () => "AsyncAta");
    const bc = createDefaultBalanceCheck(opts({ fetchImpl, resolveAta }));
    const r = await bc.check("Wallet1", 1000n);
    expect(r.eligible).toBe(true);
    expect(resolveAta).toHaveBeenCalledWith("Wallet1");
  });
});
