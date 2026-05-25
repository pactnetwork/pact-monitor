import { describe, it, expect, vi } from "vitest";
import { Connection, Keypair } from "@solana/web3.js";
import {
  ENDPOINT_CONFIG_LEN,
  FeeRecipientKind,
} from "@q3labs/pact-protocol-v1-client";
import type { BalanceCheck } from "@pact-network/wrap";
import { SolanaAdapter, getChain } from "../src";
import type { SettleBatchInput } from "../src/chain-adapter";

// Capture the instruction-builder inputs WITHOUT a real send: buildSettleBatchIx
// runs before sendAndConfirmTransaction, so the mock records the per-event
// timestamp and throws to short-circuit before any network egress. The three
// account decoders are stubbed so loadEndpoint resolves against a fake
// Connection. (Mirrors the sibling arc-testnet-settle-e2e.spec.ts mock style.)
const buildSettleBatchIxMock = vi.fn();
const decodeEndpointConfigMock = vi.fn();
const decodeCoveragePoolMock = vi.fn();
const decodeTreasuryMock = vi.fn();

vi.mock("@q3labs/pact-protocol-v1-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@q3labs/pact-protocol-v1-client")>();
  return {
    ...actual,
    buildSettleBatchIx: (...a: unknown[]) => buildSettleBatchIxMock(...a),
    decodeEndpointConfig: (...a: unknown[]) => decodeEndpointConfigMock(...a),
    decodeCoveragePool: (...a: unknown[]) => decodeCoveragePoolMock(...a),
    decodeTreasury: (...a: unknown[]) => decodeTreasuryMock(...a),
  };
});

describe("SolanaAdapter — byte-identical parity vs direct client", () => {
  it("readEndpointConfigs calls getProgramAccounts with the right filter", async () => {
    const stubConnection = {
      getProgramAccounts: vi.fn().mockResolvedValue([]),
    } as unknown as Connection;

    const adapter = new SolanaAdapter({
      descriptor: getChain("solana-devnet"),
      rpcUrl: "http://localhost:8899",
      connection: stubConnection,
    });

    const result = await adapter.readEndpointConfigs();

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
    expect(stubConnection.getProgramAccounts).toHaveBeenCalledOnce();
    // Confirm the filter shape — dataSize must equal ENDPOINT_CONFIG_LEN.
    // The exact PROGRAM_ID may have been overridden in constructor; we
    // verify the second arg's filters precisely.
    const callArgs = (stubConnection.getProgramAccounts as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[1]).toEqual(
      expect.objectContaining({
        filters: [{ dataSize: ENDPOINT_CONFIG_LEN }],
      }),
    );
  });

  it("checkAgentEligibility maps wrap's eligible result correctly", async () => {
    const stubBalanceCheck: BalanceCheck = {
      check: vi.fn().mockResolvedValue({
        eligible: true,
        ataBalance: 1_000_000n,
        allowance: 500_000n,
      }),
    };

    const adapter = new SolanaAdapter({
      descriptor: getChain("solana-devnet"),
      rpcUrl: "http://localhost:8899",
      balanceCheck: stubBalanceCheck,
    });

    const result = await adapter.checkAgentEligibility(
      "8YLKoCu7NwqHNS8GzuvA2ibsvLrsg22YMfMDafxh1B15",
      100_000n,
    );

    expect(result).toEqual({
      eligible: true,
      balance: 1_000_000n,
      allowance: 500_000n,
    });
    expect(stubBalanceCheck.check).toHaveBeenCalledWith(
      "8YLKoCu7NwqHNS8GzuvA2ibsvLrsg22YMfMDafxh1B15",
      100_000n,
    );
  });

  it("checkAgentEligibility maps wrap's no_ata reason to adapter's no_account", async () => {
    const stubBalanceCheck: BalanceCheck = {
      check: vi.fn().mockResolvedValue({
        eligible: false,
        reason: "no_ata",
      }),
    };

    const adapter = new SolanaAdapter({
      descriptor: getChain("solana-devnet"),
      rpcUrl: "http://localhost:8899",
      balanceCheck: stubBalanceCheck,
    });

    const result = await adapter.checkAgentEligibility(
      "8YLKoCu7NwqHNS8GzuvA2ibsvLrsg22YMfMDafxh1B15",
      100_000n,
    );

    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe("no_account");
    }
  });

  it("submitSettleBatch rejects an undefined signer with descriptive error", async () => {
    const adapter = new SolanaAdapter({
      descriptor: getChain("solana-devnet"),
      rpcUrl: "http://localhost:8899",
    });

    await expect(
      adapter.submitSettleBatch({
        slug: "test-slug",
        signer: undefined,
        events: [],
      }),
    ).rejects.toThrow(/requires signer: Keypair/);
  });

  it("SettleBatchInput.events accepts latencyMs and it appears on the constructed input", () => {
    const input: SettleBatchInput = {
      slug: "test",
      signer: {} as never,
      events: [{
        callId: "abc",
        agent: "8YLKoCu7NwqHNS8GzuvA2ibsvLrsg22YMfMDafxh1B15",
        premiumBaseUnits: 100n,
        outcome: "ok",
        feeRecipientCountHint: 0,
        latencyMs: 42,
      }],
    };
    expect(input.events[0].latencyMs).toBe(42);
  });

  // Rick #226 F1 — the adapter path must encode the CANONICAL wrapped-call
  // timestamp supplied by the settler (parsed via parseEventTimestamp, the same
  // function the legacy-direct path uses), NOT Date.now() synthesized at submit
  // time. This is the Solana mirror of the EVM calldata-decode assertion in
  // arc-testnet-settle-e2e.spec.ts.
  it("submitSettleBatch encodes the supplied eventTimestamp, not Date.now() (Rick #226 F1)", async () => {
    const vault = Keypair.generate().publicKey.toBase58();
    const agent = Keypair.generate().publicKey.toBase58();

    decodeEndpointConfigMock.mockReturnValue({
      feeRecipientCount: 1,
      feeRecipients: [
        { kind: FeeRecipientKind.Treasury, destination: vault, bps: 1000 },
      ],
    });
    decodeCoveragePoolMock.mockReturnValue({ usdcVault: vault });
    decodeTreasuryMock.mockReturnValue({ usdcVault: vault });

    let capturedTimestamp: bigint | undefined;
    buildSettleBatchIxMock.mockImplementation(
      (args: { events: Array<{ timestamp: bigint }> }) => {
        capturedTimestamp = args.events[0].timestamp;
        // Short-circuit before the real sendAndConfirmTransaction egress.
        throw new Error("__captured__");
      },
    );

    const stubConnection = {
      getAccountInfo: vi.fn().mockResolvedValue({ data: Buffer.from("stub") }),
    } as unknown as Connection;

    const adapter = new SolanaAdapter({
      descriptor: getChain("solana-devnet"),
      rpcUrl: "http://localhost:8899",
      connection: stubConnection,
    });

    // A wrapped-call ts well in the past (2020-01-01T00:00:00Z, unix seconds)
    // so it cannot collide with submit-time Date.now().
    const eventTimestamp = 1_577_836_800n;
    const nowSeconds = BigInt(Math.floor(Date.now() / 1000));

    await expect(
      adapter.submitSettleBatch({
        slug: "helius",
        signer: Keypair.generate(),
        events: [
          {
            callId: "11111111222233334444555566667777",
            agent,
            premiumBaseUnits: 1000n,
            outcome: "ok",
            feeRecipientCountHint: 1,
            latencyMs: 120,
            eventTimestamp,
          },
        ],
      }),
    ).rejects.toThrow("__captured__");

    expect(capturedTimestamp).toBe(eventTimestamp);
    // Guard against a Date.now() regression masquerading as a pass.
    expect(capturedTimestamp).not.toBe(nowSeconds);
  });
});
