import { describe, expect, test } from "vitest";
import {
  AccountInfo,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";

import { TOKEN_PROGRAM_ID } from "../src/constants.js";
import {
  accountListForBatch,
  defaultFeeRecipients,
  deriveAssociatedTokenAccount,
  feeAtasMatchEndpoint,
  getAgentInsurableState,
  validateFeeRecipients,
} from "../src/helpers.js";
import { FeeRecipientKind, type EndpointConfig } from "../src/state.js";
import type { SettlementEvent } from "../src/instructions.js";

const newPk = () => Keypair.generate().publicKey;

describe("helpers", () => {
  describe("defaultFeeRecipients", () => {
    test("treasury-only by default (10%, count=1)", () => {
      const treasury = newPk();
      const res = defaultFeeRecipients(treasury);
      expect(res.fee_recipient_count).toBe(1);
      expect(res.fee_recipients).toHaveLength(1);
      expect(res.fee_recipients[0].kind).toBe(FeeRecipientKind.Treasury);
      expect(res.fee_recipients[0].bps).toBe(1000);
      expect(res.fee_recipients[0].destination).toBe(treasury.toBase58());
    });

    test("with affiliate adds 5% AffiliateAta entry", () => {
      const treasury = newPk();
      const aff = newPk();
      const res = defaultFeeRecipients(treasury, aff);
      expect(res.fee_recipient_count).toBe(2);
      expect(res.fee_recipients[1].kind).toBe(FeeRecipientKind.AffiliateAta);
      expect(res.fee_recipients[1].bps).toBe(500);
      expect(res.fee_recipients[1].destination).toBe(aff.toBase58());
    });
  });

  describe("validateFeeRecipients", () => {
    const T = (dest: string, bps: number) => ({
      kind: FeeRecipientKind.Treasury,
      destination: dest,
      bps,
    });
    const A = (dest: string, bps: number) => ({
      kind: FeeRecipientKind.AffiliateAta,
      destination: dest,
      bps,
    });

    test("valid: empty array", () => {
      expect(validateFeeRecipients([], 0, 3000).valid).toBe(true);
    });

    test("valid: treasury 10% + affiliate 5%", () => {
      const tr = newPk().toBase58();
      const af = newPk().toBase58();
      expect(
        validateFeeRecipients([T(tr, 1000), A(af, 500)], 2, 3000).valid
      ).toBe(true);
    });

    test("rejects mismatched count", () => {
      const tr = newPk().toBase58();
      const r = validateFeeRecipients([T(tr, 1000)], 2, 3000);
      expect(r.valid).toBe(false);
      expect(r.reason).toMatch(/count/);
    });

    test("rejects > 8 entries (FeeRecipientArrayTooLong)", () => {
      const arr = Array.from({ length: 9 }, () => A(newPk().toBase58(), 100));
      const r = validateFeeRecipients(arr, 9, 3000);
      expect(r.valid).toBe(false);
      expect(r.reason).toMatch(/FeeRecipientArrayTooLong/);
    });

    test("rejects per-entry bps > 10000 (FeeBpsExceedsCap)", () => {
      const r = validateFeeRecipients([A(newPk().toBase58(), 10001)], 1, 10000);
      expect(r.valid).toBe(false);
      expect(r.reason).toMatch(/FeeBpsExceedsCap/);
    });

    test("rejects sum > 10000 (FeeBpsSumOver10k)", () => {
      // Two entries each ≤ 10000 but summing > 10000.
      const r = validateFeeRecipients(
        [A(newPk().toBase58(), 6000), A(newPk().toBase58(), 5000)],
        2,
        10000
      );
      expect(r.valid).toBe(false);
      expect(r.reason).toMatch(/FeeBpsSumOver10k/);
    });

    test("rejects sum > maxTotalFeeBps even when ≤ 10000", () => {
      const r = validateFeeRecipients(
        [A(newPk().toBase58(), 2000), A(newPk().toBase58(), 1500)],
        2,
        3000
      );
      expect(r.valid).toBe(false);
      expect(r.reason).toMatch(/FeeBpsExceedsCap/);
    });

    test("rejects multiple Treasury entries (MultipleTreasuryRecipients)", () => {
      const r = validateFeeRecipients(
        [T(newPk().toBase58(), 500), T(newPk().toBase58(), 500)],
        2,
        3000
      );
      expect(r.valid).toBe(false);
      expect(r.reason).toMatch(/MultipleTreasury/);
    });

    test("rejects duplicate destinations (FeeRecipientDuplicateDestination)", () => {
      const dup = newPk().toBase58();
      const r = validateFeeRecipients([A(dup, 500), A(dup, 200)], 2, 3000);
      expect(r.valid).toBe(false);
      expect(r.reason).toMatch(/Duplicate/);
    });

    test("rejects invalid kind byte (InvalidFeeRecipientKind)", () => {
      const bad = { kind: 42 as FeeRecipientKind, destination: newPk().toBase58(), bps: 100 };
      const r = validateFeeRecipients([bad], 1, 3000);
      expect(r.valid).toBe(false);
      expect(r.reason).toMatch(/InvalidFeeRecipientKind/);
    });
  });

  describe("accountListForBatch", () => {
    function makeEvent(): SettlementEvent {
      return {
        callId: new Uint8Array(16),
        agentOwner: newPk(),
        agentAta: newPk(),
        endpointConfig: newPk(),
        coveragePool: newPk(),
        poolVault: newPk(),
        slug: new Uint8Array(16),
        premiumLamports: 1000n,
        refundLamports: 0n,
        latencyMs: 100,
        breach: false,
        timestamp: 0,
        feeRecipientAtas: [newPk()],
      };
    }

    test("emits the canonical fixed prefix", () => {
      const settler = newPk();
      const sa = newPk();
      const list = accountListForBatch([], [], settler, sa);
      expect(list).toHaveLength(4);
      expect(list[0].pubkey.equals(settler)).toBe(true);
      expect(list[0].isSigner).toBe(true);
      expect(list[1].pubkey.equals(sa)).toBe(true);
      expect(list[1].isWritable).toBe(false);
      expect(list[2].pubkey.equals(TOKEN_PROGRAM_ID)).toBe(true);
      expect(list[3].pubkey.equals(SystemProgram.programId)).toBe(true);
    });

    test("appends 5 + N slots per event (N = fee_recipient_atas length)", () => {
      const ev1 = makeEvent();
      const ev2 = { ...makeEvent(), feeRecipientAtas: [newPk(), newPk()] };
      const list = accountListForBatch(
        [ev1, ev2],
        [newPk(), newPk()],
        newPk(),
        newPk()
      );
      // 4 prefix + 5 + 1 + 5 + 2 = 17
      expect(list).toHaveLength(4 + 5 + 1 + 5 + 2);
    });

    test("maintains per-event ordering: callRecord, pool, vault, endpoint, agentAta, fee_atas", () => {
      const ev = makeEvent();
      const cr = newPk();
      const list = accountListForBatch([ev], [cr], newPk(), newPk());
      expect(list[4].pubkey.equals(cr)).toBe(true);
      expect(list[5].pubkey.equals(ev.coveragePool)).toBe(true);
      expect(list[6].pubkey.equals(ev.poolVault)).toBe(true);
      expect(list[7].pubkey.equals(ev.endpointConfig)).toBe(true);
      expect(list[8].pubkey.equals(ev.agentAta)).toBe(true);
      expect(list[9].pubkey.equals(ev.feeRecipientAtas[0])).toBe(true);
    });

    test("throws on event/callRecord length mismatch", () => {
      expect(() =>
        accountListForBatch([makeEvent()], [], newPk(), newPk())
      ).toThrow();
    });
  });

  describe("feeAtasMatchEndpoint", () => {
    function makeEndpoint(recipients: PublicKey[]): EndpointConfig {
      return {
        bump: 0,
        paused: false,
        slug: new Uint8Array(16),
        flatPremiumLamports: 0n,
        percentBps: 0,
        slaLatencyMs: 0,
        imputedCostLamports: 0n,
        exposureCapPerHourLamports: 0n,
        currentPeriodStart: 0n,
        currentPeriodRefunds: 0n,
        totalCalls: 0n,
        totalBreaches: 0n,
        totalPremiums: 0n,
        totalRefunds: 0n,
        lastUpdated: 0n,
        coveragePool: newPk().toBase58(),
        feeRecipientCount: recipients.length,
        feeRecipients: recipients.map((p) => ({
          kind: FeeRecipientKind.AffiliateAta,
          destination: p.toBase58(),
          bps: 100,
        })),
      };
    }

    test("matches when ATAs equal endpoint destinations in order", () => {
      const a = newPk();
      const b = newPk();
      const ep = makeEndpoint([a, b]);
      expect(feeAtasMatchEndpoint(ep, [a, b]).valid).toBe(true);
    });

    test("rejects mismatched count", () => {
      const a = newPk();
      const ep = makeEndpoint([a, newPk()]);
      const r = feeAtasMatchEndpoint(ep, [a]);
      expect(r.valid).toBe(false);
      expect(r.reason).toMatch(/count mismatch/);
    });

    test("rejects out-of-order destinations", () => {
      const a = newPk();
      const b = newPk();
      const ep = makeEndpoint([a, b]);
      const r = feeAtasMatchEndpoint(ep, [b, a]);
      expect(r.valid).toBe(false);
      expect(r.reason).toMatch(/slot 0 mismatch/);
    });
  });

  describe("getAgentInsurableState", () => {
    function makeAtaData(opts: {
      mint: PublicKey;
      owner: PublicKey;
      amount: bigint;
      delegate?: PublicKey;
      delegatedAmount?: bigint;
    }): Buffer {
      const data = Buffer.alloc(165);
      data.set(opts.mint.toBytes(), 0);
      data.set(opts.owner.toBytes(), 32);
      data.writeBigUInt64LE(opts.amount, 64);
      if (opts.delegate) {
        data.writeUInt32LE(1, 72);
        data.set(opts.delegate.toBytes(), 76);
        data.writeBigUInt64LE(opts.delegatedAmount ?? 0n, 121);
      }
      data[108] = 1; // initialized
      return data;
    }

    function mockConnection(
      handler: (pk: PublicKey) => AccountInfo<Buffer> | null
    ): Connection {
      return {
        getAccountInfo: async (pk: PublicKey) => handler(pk),
      } as unknown as Connection;
    }

    test("eligible when balance + allowance both meet requirement", async () => {
      const owner = newPk();
      const mint = newPk();
      const sa = newPk();
      const ata = deriveAssociatedTokenAccount(owner, mint);
      const conn = mockConnection((pk) => {
        if (!pk.equals(ata)) return null;
        return {
          executable: false,
          owner: TOKEN_PROGRAM_ID,
          lamports: 2_039_280,
          data: makeAtaData({
            mint,
            owner,
            amount: 100_000n,
            delegate: sa,
            delegatedAmount: 100_000n,
          }),
          rentEpoch: 0,
        };
      });
      const r = await getAgentInsurableState(conn, owner, mint, sa, 50_000n);
      expect(r.eligible).toBe(true);
      expect(r.ataBalance).toBe(100_000n);
      expect(r.allowance).toBe(100_000n);
    });

    test("ineligible when ATA does not exist", async () => {
      const conn = mockConnection(() => null);
      const r = await getAgentInsurableState(
        conn,
        newPk(),
        newPk(),
        newPk(),
        100n
      );
      expect(r.eligible).toBe(false);
      expect(r.reason).toMatch(/does not exist/);
    });

    test("ineligible when account not owned by SPL Token", async () => {
      const owner = newPk();
      const mint = newPk();
      const conn = mockConnection(() => ({
        executable: false,
        owner: SystemProgram.programId,
        lamports: 1,
        data: Buffer.alloc(165),
        rentEpoch: 0,
      }));
      const r = await getAgentInsurableState(conn, owner, mint, newPk(), 100n);
      expect(r.eligible).toBe(false);
      expect(r.reason).toMatch(/not owned by SPL Token/);
    });

    test("ineligible when no delegate set", async () => {
      const owner = newPk();
      const mint = newPk();
      const conn = mockConnection(() => ({
        executable: false,
        owner: TOKEN_PROGRAM_ID,
        lamports: 1,
        data: makeAtaData({ mint, owner, amount: 1000n }),
        rentEpoch: 0,
      }));
      const r = await getAgentInsurableState(conn, owner, mint, newPk(), 100n);
      expect(r.eligible).toBe(false);
      expect(r.reason).toMatch(/no delegate/);
    });

    test("ineligible when delegate is wrong pubkey", async () => {
      const owner = newPk();
      const mint = newPk();
      const sa = newPk();
      const conn = mockConnection(() => ({
        executable: false,
        owner: TOKEN_PROGRAM_ID,
        lamports: 1,
        data: makeAtaData({
          mint,
          owner,
          amount: 1000n,
          delegate: newPk(),
          delegatedAmount: 1000n,
        }),
        rentEpoch: 0,
      }));
      const r = await getAgentInsurableState(conn, owner, mint, sa, 100n);
      expect(r.eligible).toBe(false);
      expect(r.reason).toMatch(/delegate is/);
    });

    test("ineligible when delegated_amount < required", async () => {
      const owner = newPk();
      const mint = newPk();
      const sa = newPk();
      const conn = mockConnection(() => ({
        executable: false,
        owner: TOKEN_PROGRAM_ID,
        lamports: 1,
        data: makeAtaData({
          mint,
          owner,
          amount: 100_000n,
          delegate: sa,
          delegatedAmount: 100n,
        }),
        rentEpoch: 0,
      }));
      const r = await getAgentInsurableState(conn, owner, mint, sa, 1000n);
      expect(r.eligible).toBe(false);
      expect(r.reason).toMatch(/delegated_amount/);
    });

    test("ineligible when balance < required (allowance ok)", async () => {
      const owner = newPk();
      const mint = newPk();
      const sa = newPk();
      const conn = mockConnection(() => ({
        executable: false,
        owner: TOKEN_PROGRAM_ID,
        lamports: 1,
        data: makeAtaData({
          mint,
          owner,
          amount: 50n,
          delegate: sa,
          delegatedAmount: 1_000_000n,
        }),
        rentEpoch: 0,
      }));
      const r = await getAgentInsurableState(conn, owner, mint, sa, 1000n);
      expect(r.eligible).toBe(false);
      expect(r.reason).toMatch(/ata balance/);
    });

    test("ineligible when ATA mint mismatches expected", async () => {
      const owner = newPk();
      const mint = newPk();
      const otherMint = newPk();
      const sa = newPk();
      const conn = mockConnection(() => ({
        executable: false,
        owner: TOKEN_PROGRAM_ID,
        lamports: 1,
        data: makeAtaData({
          mint: otherMint,
          owner,
          amount: 100n,
          delegate: sa,
          delegatedAmount: 100n,
        }),
        rentEpoch: 0,
      }));
      const r = await getAgentInsurableState(conn, owner, mint, sa, 50n);
      expect(r.eligible).toBe(false);
      expect(r.reason).toMatch(/mint mismatch/);
    });

    test("ineligible when ATA owner mismatches", async () => {
      const owner = newPk();
      const otherOwner = newPk();
      const mint = newPk();
      const sa = newPk();
      const conn = mockConnection(() => ({
        executable: false,
        owner: TOKEN_PROGRAM_ID,
        lamports: 1,
        data: makeAtaData({
          mint,
          owner: otherOwner,
          amount: 100n,
          delegate: sa,
          delegatedAmount: 100n,
        }),
        rentEpoch: 0,
      }));
      const r = await getAgentInsurableState(conn, owner, mint, sa, 50n);
      expect(r.eligible).toBe(false);
      expect(r.reason).toMatch(/owner mismatch/);
    });
  });
});
