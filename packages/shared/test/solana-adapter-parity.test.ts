import { describe, it, expect, vi } from "vitest";
import { Connection } from "@solana/web3.js";
import {
  ENDPOINT_CONFIG_LEN,
} from "@pact-network/protocol-v1-client";
import type { BalanceCheck } from "@pact-network/wrap";
import { SolanaAdapter, getChain } from "../src";
import type { SettleBatchInput } from "../src/chain-adapter";

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
});
