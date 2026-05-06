/**
 * Tests for the AgentApprovalPanel component.
 *
 * The panel is the primary UX surface for the SPL Token approval flow that
 * replaces the old AgentWallet deposit/withdraw model. We exercise:
 *
 * - The Approve button calls the approval transaction builder + wallet
 *   sendTransaction.
 * - The "Approval used up" banner appears when allowance < min_premium.
 * - Revoke triggers a confirm dialog before sending.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";

// Reference React so JSX runtime resolves under test config.
void React;

// Mock wallet adapter hooks before importing the panel.
const mockSendTransaction = vi.fn().mockResolvedValue("sig123");
const mockPublicKey = new PublicKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: () => ({
    publicKey: mockPublicKey,
    sendTransaction: mockSendTransaction,
    connected: true,
  }),
  useConnection: () => ({ connection: {} as never }),
}));

// Mock the insurable-state hook to return deterministic snapshots per test.
const useAgentInsurableStateMock = vi.fn();
vi.mock("@/lib/hooks/useAgentInsurableState", () => ({
  useAgentInsurableState: (...args: unknown[]) =>
    useAgentInsurableStateMock(...args),
}));

// Mock the on-chain transaction builders so we don't need real PDA derivation
// inside jsdom (the ATA derivation depends on the SPL Associated Token Program
// constant in protocol-v1-client). The component contract we're testing is
// "click → builder → sendTransaction", not "PDA correctness".
vi.mock("@/lib/solana", () => ({
  buildApproveTransaction: vi.fn(() => ({ tag: "approve-tx" })),
  buildRevokeTransaction: vi.fn(() => ({ tag: "revoke-tx" })),
  DEFAULT_APPROVE_LAMPORTS: 25_000_000n,
}));

import { AgentApprovalPanel } from "./agent-approval-panel";
import type { AgentInsurableSnapshot } from "@/lib/api";

const PUBKEY = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

const baseSnapshot: AgentInsurableSnapshot = {
  pubkey: PUBKEY,
  ataBalance: 5_000_000,
  allowance: 25_000_000,
  eligible: true,
  totalPremiumsPaid: 1500,
  totalRefundsReceived: 300,
  callCount: 5,
  lastActivity: "2026-05-05T10:00:00Z",
};

describe("AgentApprovalPanel", () => {
  beforeEach(() => {
    mockSendTransaction.mockClear();
    useAgentInsurableStateMock.mockReset();
  });

  it("clicking Approve sends an SPL Token approve transaction", async () => {
    useAgentInsurableStateMock.mockReturnValue({
      state: {
        ataBalance: 5_000_000n,
        allowance: 25_000_000n,
        eligible: true,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(<AgentApprovalPanel pubkey={PUBKEY} initialState={baseSnapshot} />);
    const approveBtn = screen.getByRole("button", { name: "Approve" });
    fireEvent.click(approveBtn);

    await waitFor(
      () => {
        expect(mockSendTransaction).toHaveBeenCalledTimes(1);
      },
      { timeout: 1500 }
    );
  });

  it("shows the 'Approval used up' banner when allowance is below min_premium", () => {
    useAgentInsurableStateMock.mockReturnValue({
      state: {
        ataBalance: 5_000_000n,
        allowance: 0n,
        eligible: false,
        reason: "no delegate set; agent must SPL-Approve SettlementAuthority",
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    render(
      <AgentApprovalPanel
        pubkey={PUBKEY}
        initialState={{
          ...baseSnapshot,
          allowance: 0,
          eligible: false,
          reason: "no delegate set",
        }}
      />
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/approval used up/i);
    expect(screen.getByRole("button", { name: /re-approve/i })).toBeInTheDocument();
  });

  it("Revoke button shows a confirm dialog and skips send when cancelled", async () => {
    useAgentInsurableStateMock.mockReturnValue({
      state: {
        ataBalance: 5_000_000n,
        allowance: 25_000_000n,
        eligible: true,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<AgentApprovalPanel pubkey={PUBKEY} initialState={baseSnapshot} />);
    const revokeBtn = screen.getByRole("button", { name: /revoke/i });
    fireEvent.click(revokeBtn);

    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => {
      expect(mockSendTransaction).not.toHaveBeenCalled();
    });

    confirmSpy.mockRestore();
  });

  it("Revoke confirmation triggers the revoke transaction", async () => {
    useAgentInsurableStateMock.mockReturnValue({
      state: {
        ataBalance: 5_000_000n,
        allowance: 25_000_000n,
        eligible: true,
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<AgentApprovalPanel pubkey={PUBKEY} initialState={baseSnapshot} />);
    const revokeBtn = screen.getByRole("button", { name: /revoke/i });
    fireEvent.click(revokeBtn);

    await waitFor(() => {
      expect(mockSendTransaction).toHaveBeenCalledTimes(1);
    });

    confirmSpy.mockRestore();
  });
});
