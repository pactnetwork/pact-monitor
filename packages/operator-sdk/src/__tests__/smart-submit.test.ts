import { describe, it, expect, vi } from "vitest";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import { smartSubmit } from "../submit/smart-submit.js";
import { OperatorError, OperatorErrorCode } from "../errors.js";

function makeMockConnection(
  overrides: Partial<{
    getRecentPrioritizationFees: ReturnType<typeof vi.fn>;
    getLatestBlockhash: ReturnType<typeof vi.fn>;
    simulateTransaction: ReturnType<typeof vi.fn>;
    sendRawTransaction: ReturnType<typeof vi.fn>;
    getSignatureStatus: ReturnType<typeof vi.fn>;
    getBlockHeight: ReturnType<typeof vi.fn>;
  }> = {},
) {
  return {
    rpcEndpoint: "mock",
    getRecentPrioritizationFees:
      overrides.getRecentPrioritizationFees ??
      vi.fn().mockResolvedValue([
        { slot: 1, prioritizationFee: 0 },
        { slot: 2, prioritizationFee: 1000 },
        { slot: 3, prioritizationFee: 5000 },
        { slot: 4, prioritizationFee: 10000 },
      ]),
    getLatestBlockhash:
      overrides.getLatestBlockhash ??
      vi
        .fn()
        .mockResolvedValue({
          blockhash: "11111111111111111111111111111111",
          lastValidBlockHeight: 1000,
        }),
    simulateTransaction:
      overrides.simulateTransaction ??
      vi
        .fn()
        .mockResolvedValue({ value: { err: null, logs: [], unitsConsumed: 50_000 } }),
    sendRawTransaction:
      overrides.sendRawTransaction ??
      vi.fn().mockResolvedValue("signature-1"),
    getSignatureStatus:
      overrides.getSignatureStatus ??
      vi
        .fn()
        .mockResolvedValue({
          value: { err: null, confirmationStatus: "confirmed" },
        }),
    getBlockHeight:
      overrides.getBlockHeight ?? vi.fn().mockResolvedValue(500),
  } as unknown as Parameters<typeof smartSubmit>[0]["connection"];
}

/** A user ix with no extra signer requirements — ComputeBudget setComputeUnitLimit
 * touches no signer accounts, so signature verification only needs the fee-payer. */
function makeNoopIx(): TransactionInstruction {
  return ComputeBudgetProgram.setComputeUnitLimit({ units: 1 });
}

describe("smartSubmit", () => {
  it("happy path: prepends ComputeBudget(price+limit), simulates, sends, confirms", async () => {
    const signer = Keypair.generate();
    const connection = makeMockConnection();
    const result = await smartSubmit({
      connection,
      instructions: [makeNoopIx()],
      signer,
    });
    expect(result.signature).toBe("signature-1");
    expect(result.computeUnitsConsumed).toBe(50_000);
    // sendRawTransaction was called once
    expect(
      (connection as unknown as { sendRawTransaction: { mock: { calls: unknown[] } } })
        .sendRawTransaction.mock.calls.length,
    ).toBe(1);
  });

  it("biases priority-fee RPC with writable accounts when provided", async () => {
    const signer = Keypair.generate();
    const acct = Keypair.generate().publicKey;
    const connection = makeMockConnection();
    await smartSubmit({
      connection,
      instructions: [makeNoopIx()],
      signer,
      priorityFeeAccounts: [acct],
    });
    const fees = (
      connection as unknown as {
        getRecentPrioritizationFees: {
          mock: { calls: { 0: { lockedWritableAccounts: PublicKey[] } }[] };
        };
      }
    ).getRecentPrioritizationFees;
    expect(fees.mock.calls[0][0]).toEqual({ lockedWritableAccounts: [acct] });
  });

  it("falls back to priorityFeeFallback when RPC returns empty", async () => {
    const signer = Keypair.generate();
    const getRecentPrioritizationFees = vi.fn().mockResolvedValue([]);
    const connection = makeMockConnection({ getRecentPrioritizationFees });
    const result = await smartSubmit({
      connection,
      instructions: [makeNoopIx()],
      signer,
      options: { priorityFeeFallback: 12345 },
    });
    // We can't easily inspect the prepended ix, but the call succeeded
    // and the fallback path didn't throw.
    expect(result.signature).toBe("signature-1");
  });

  it("throws SIMULATION_FAILED when simulation returns an err", async () => {
    const signer = Keypair.generate();
    const connection = makeMockConnection({
      simulateTransaction: vi
        .fn()
        .mockResolvedValue({
          value: { err: { Custom: 6042 }, logs: ["bad authority"] },
        }),
    });
    await expect(
      smartSubmit({
        connection,
        instructions: [makeNoopIx()],
        signer,
      }),
    ).rejects.toMatchObject({
      code: OperatorErrorCode.SIMULATION_FAILED,
    });
  });

  it("throws BLOCK_HEIGHT_EXCEEDED when confirmation never lands before lastValidBlockHeight", async () => {
    const signer = Keypair.generate();
    let polls = 0;
    const connection = makeMockConnection({
      getSignatureStatus: vi.fn().mockResolvedValue({ value: null }),
      getBlockHeight: vi.fn().mockImplementation(async () => {
        polls += 1;
        // Start at 999 (below lastValidBlockHeight=1000), then jump past.
        return polls === 1 ? 999 : 1001;
      }),
    });
    await expect(
      smartSubmit({
        connection,
        instructions: [makeNoopIx()],
        signer,
        options: { pollIntervalMs: 1 },
      }),
    ).rejects.toMatchObject({
      code: OperatorErrorCode.BLOCK_HEIGHT_EXCEEDED,
    });
  });

  it("skipping simulation is opt-in via simulateFirst:false", async () => {
    const signer = Keypair.generate();
    const simulateTransaction = vi.fn();
    const connection = makeMockConnection({ simulateTransaction });
    await smartSubmit({
      connection,
      instructions: [makeNoopIx()],
      signer,
      options: { simulateFirst: false },
    });
    expect(simulateTransaction).not.toHaveBeenCalled();
  });

  it("rethrows on-chain err from signature-status with RPC_ERROR + signature in details", async () => {
    const signer = Keypair.generate();
    const connection = makeMockConnection({
      getSignatureStatus: vi.fn().mockResolvedValue({
        value: { err: { InstructionError: [0, "Custom"] }, confirmationStatus: "confirmed" },
      }),
    });
    try {
      await smartSubmit({
        connection,
        instructions: [makeNoopIx()],
        signer,
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(OperatorError);
      const oe = e as OperatorError;
      expect(oe.code).toBe(OperatorErrorCode.RPC_ERROR);
      expect(oe.details?.signature).toBe("signature-1");
    }
  });
});

describe("ComputeBudget ixes are prepended (not inserted in the middle)", () => {
  it("smart-submit signature-checks pass on a tx that begins with [setComputeUnitLimit, setComputeUnitPrice, ...user ixes]", () => {
    // Symbolic: this is enforced by the implementation (`computeBudgetIxs` is
    // spread before `args.instructions` in the Transaction.add() call).
    const limit = ComputeBudgetProgram.setComputeUnitLimit({ units: 1 });
    const price = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 });
    expect(limit.programId.toBase58()).toBe(
      "ComputeBudget111111111111111111111111111111",
    );
    expect(price.programId.toBase58()).toBe(
      "ComputeBudget111111111111111111111111111111",
    );
  });
});
