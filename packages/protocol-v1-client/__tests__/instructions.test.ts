import { describe, expect, test } from "vitest";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

import {
  DISC_INITIALIZE_PROTOCOL_CONFIG,
  DISC_INITIALIZE_SETTLEMENT_AUTHORITY,
  DISC_INITIALIZE_TREASURY,
  DISC_PAUSE_ENDPOINT,
  DISC_REGISTER_ENDPOINT,
  DISC_SETTLE_BATCH,
  DISC_TOP_UP_COVERAGE_POOL,
  DISC_UPDATE_ENDPOINT_CONFIG,
  DISC_UPDATE_FEE_RECIPIENTS,
  PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "../src/constants.js";
import {
  buildApproveIx,
  buildInitializeProtocolConfigIx,
  buildInitializeSettlementAuthorityIx,
  buildInitializeTreasuryIx,
  buildPauseEndpointIx,
  buildRegisterEndpointIx,
  buildRevokeIx,
  buildSettleBatchIx,
  buildTopUpCoveragePoolIx,
  buildUpdateEndpointConfigIx,
  buildUpdateFeeRecipientsIx,
  SETTLE_EVENT_BYTES,
} from "../src/instructions.js";
import { FeeRecipientKind } from "../src/state.js";
import { slugBytes } from "../src/pda.js";

const newPk = () => Keypair.generate().publicKey;

describe("instruction builders — discriminator + payload bytes", () => {
  test("buildInitializeProtocolConfigIx produces disc 12 with correct header", () => {
    const ix = buildInitializeProtocolConfigIx({
      authority: newPk(),
      protocolConfig: newPk(),
      usdcMint: newPk(),
      maxTotalFeeBps: 3000,
      defaultFeeRecipients: [
        {
          kind: FeeRecipientKind.Treasury,
          destination: newPk().toBase58(),
          bps: 1000,
        },
      ],
    });
    expect(ix.programId.equals(PROGRAM_ID)).toBe(true);
    expect(ix.data[0]).toBe(DISC_INITIALIZE_PROTOCOL_CONFIG);
    expect(ix.data[1]).toBe(1); // present
    expect(ix.data.readUInt16LE(2)).toBe(3000);
    expect(ix.data[4]).toBe(1); // count
    // 1 disc + 1 present + 2 max + 1 count + 48 entry
    expect(ix.data.length).toBe(5 + 48);
    expect(ix.keys).toHaveLength(4);
    expect(ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[0].isWritable).toBe(true);
    expect(ix.keys[1].isWritable).toBe(true);
    expect(ix.keys[2].isWritable).toBe(false);
    expect(ix.keys[3].pubkey.equals(SystemProgram.programId)).toBe(true);
  });

  test("buildInitializeProtocolConfigIx with no max gives present=0", () => {
    const ix = buildInitializeProtocolConfigIx({
      authority: newPk(),
      protocolConfig: newPk(),
      usdcMint: newPk(),
      defaultFeeRecipients: [],
    });
    expect(ix.data[1]).toBe(0);
    expect(ix.data[4]).toBe(0); // count
    expect(ix.data.length).toBe(5);
  });

  test("buildInitializeTreasuryIx is single-byte data", () => {
    const ix = buildInitializeTreasuryIx({
      authority: newPk(),
      protocolConfig: newPk(),
      treasury: newPk(),
      treasuryVault: newPk(),
      usdcMint: newPk(),
    });
    expect(ix.data.length).toBe(1);
    expect(ix.data[0]).toBe(DISC_INITIALIZE_TREASURY);
    expect(ix.keys).toHaveLength(7);
    expect(ix.keys[6].pubkey.equals(TOKEN_PROGRAM_ID)).toBe(true);
  });

  test("buildInitializeSettlementAuthorityIx encodes signer pubkey", () => {
    const settler = newPk();
    const ix = buildInitializeSettlementAuthorityIx({
      authority: newPk(),
      protocolConfig: newPk(),
      settlementAuthority: newPk(),
      settlerSigner: settler,
    });
    expect(ix.data[0]).toBe(DISC_INITIALIZE_SETTLEMENT_AUTHORITY);
    expect(ix.data.length).toBe(33);
    expect(
      Array.from(ix.data.subarray(1, 33))
    ).toEqual(Array.from(settler.toBytes()));
    expect(ix.keys).toHaveLength(4);
    expect(ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[1].isWritable).toBe(false); // protocol_config readonly
    expect(ix.keys[2].isWritable).toBe(true);
  });

  test("buildRegisterEndpointIx with default recipients (no override) sets present=0", () => {
    const slug = slugBytes("openai");
    const ix = buildRegisterEndpointIx({
      authority: newPk(),
      protocolConfig: newPk(),
      treasury: newPk(),
      endpointConfig: newPk(),
      coveragePool: newPk(),
      poolVault: newPk(),
      usdcMint: newPk(),
      slug,
      flatPremiumLamports: 500n,
      percentBps: 250,
      slaLatencyMs: 5000,
      imputedCostLamports: 1000n,
      exposureCapPerHourLamports: 5_000_000n,
    });
    expect(ix.data[0]).toBe(DISC_REGISTER_ENDPOINT);
    expect(Array.from(ix.data.subarray(1, 17))).toEqual(Array.from(slug));
    expect(ix.data.readBigUInt64LE(17)).toBe(500n);
    expect(ix.data.readUInt16LE(25)).toBe(250);
    expect(ix.data.readUInt32LE(27)).toBe(5000);
    expect(ix.data.readBigUInt64LE(31)).toBe(1000n);
    expect(ix.data.readBigUInt64LE(39)).toBe(5_000_000n);
    expect(ix.data[47]).toBe(0); // present
    expect(ix.data[48]).toBe(0); // count
    expect(ix.data.length).toBe(49);
    expect(ix.keys).toHaveLength(9);
  });

  test("buildRegisterEndpointIx with explicit recipients sets present=1 and includes entries", () => {
    const slug = slugBytes("openai");
    const ix = buildRegisterEndpointIx({
      authority: newPk(),
      protocolConfig: newPk(),
      treasury: newPk(),
      endpointConfig: newPk(),
      coveragePool: newPk(),
      poolVault: newPk(),
      usdcMint: newPk(),
      slug,
      flatPremiumLamports: 500n,
      percentBps: 0,
      slaLatencyMs: 5000,
      imputedCostLamports: 1000n,
      exposureCapPerHourLamports: 5_000_000n,
      feeRecipients: [
        {
          kind: FeeRecipientKind.Treasury,
          destination: newPk().toBase58(),
          bps: 1000,
        },
      ],
      feeRecipientCount: 1,
    });
    expect(ix.data[47]).toBe(1);
    expect(ix.data[48]).toBe(1);
    expect(ix.data.length).toBe(49 + 48);
  });

  test("buildRegisterEndpointIx mismatched recipientCount throws", () => {
    expect(() =>
      buildRegisterEndpointIx({
        authority: newPk(),
        protocolConfig: newPk(),
        treasury: newPk(),
        endpointConfig: newPk(),
        coveragePool: newPk(),
        poolVault: newPk(),
        usdcMint: newPk(),
        slug: slugBytes("ep"),
        flatPremiumLamports: 0n,
        percentBps: 0,
        slaLatencyMs: 0,
        imputedCostLamports: 0n,
        exposureCapPerHourLamports: 0n,
        feeRecipients: [
          {
            kind: FeeRecipientKind.Treasury,
            destination: newPk().toBase58(),
            bps: 1000,
          },
        ],
        feeRecipientCount: 2,
      })
    ).toThrow();
  });

  test("buildUpdateEndpointConfigIx flips presence flags per provided field", () => {
    const ix = buildUpdateEndpointConfigIx({
      authority: newPk(),
      protocolConfig: newPk(),
      endpointConfig: newPk(),
      flatPremiumLamports: 600n,
      slaLatencyMs: 4000,
      // percentBps, imputedCostLamports, exposureCapPerHourLamports omitted
    });
    expect(ix.data[0]).toBe(DISC_UPDATE_ENDPOINT_CONFIG);
    expect(ix.data.length).toBe(36);
    // body offsets — match update_endpoint_config.rs:
    //   0:flatPremium present | 9:percentBps present | 12:slaMs present
    //   17:imputedCost present | 26:exposureCap present
    // body starts at data[1]
    expect(ix.data[1]).toBe(1); // flat_premium present
    expect(ix.data.readBigUInt64LE(2)).toBe(600n);
    expect(ix.data[10]).toBe(0); // percent_bps absent
    expect(ix.data[13]).toBe(1); // sla present
    expect(ix.data.readUInt32LE(14)).toBe(4000);
    expect(ix.data[18]).toBe(0); // imputedCost absent
    expect(ix.data[27]).toBe(0); // exposureCap absent
  });

  test("buildPauseEndpointIx encodes 2 bytes [disc, paused]", () => {
    const ix = buildPauseEndpointIx({
      authority: newPk(),
      protocolConfig: newPk(),
      endpointConfig: newPk(),
      paused: true,
    });
    expect(ix.data.length).toBe(2);
    expect(ix.data[0]).toBe(DISC_PAUSE_ENDPOINT);
    expect(ix.data[1]).toBe(1);

    const ix2 = buildPauseEndpointIx({
      authority: newPk(),
      protocolConfig: newPk(),
      endpointConfig: newPk(),
      paused: false,
    });
    expect(ix2.data[1]).toBe(0);
  });

  test("buildTopUpCoveragePoolIx encodes slug + amount", () => {
    const slug = slugBytes("openai");
    const ix = buildTopUpCoveragePoolIx({
      authority: newPk(),
      coveragePool: newPk(),
      authorityAta: newPk(),
      poolVault: newPk(),
      slug,
      amount: 1_000_000n,
    });
    expect(ix.data[0]).toBe(DISC_TOP_UP_COVERAGE_POOL);
    expect(Array.from(ix.data.subarray(1, 17))).toEqual(Array.from(slug));
    expect(ix.data.readBigUInt64LE(17)).toBe(1_000_000n);
    expect(ix.data.length).toBe(25);
    expect(ix.keys).toHaveLength(5);
    expect(ix.keys[4].pubkey.equals(TOKEN_PROGRAM_ID)).toBe(true);
  });

  test("buildUpdateFeeRecipientsIx encodes slug + count + entries", () => {
    const slug = slugBytes("openai");
    const ix = buildUpdateFeeRecipientsIx({
      authority: newPk(),
      protocolConfig: newPk(),
      treasury: newPk(),
      endpointConfig: newPk(),
      slug,
      feeRecipients: [
        {
          kind: FeeRecipientKind.Treasury,
          destination: newPk().toBase58(),
          bps: 1000,
        },
        {
          kind: FeeRecipientKind.AffiliateAta,
          destination: newPk().toBase58(),
          bps: 500,
        },
      ],
      feeRecipientCount: 2,
    });
    expect(ix.data[0]).toBe(DISC_UPDATE_FEE_RECIPIENTS);
    expect(Array.from(ix.data.subarray(1, 17))).toEqual(Array.from(slug));
    expect(ix.data[17]).toBe(2);
    expect(ix.data.length).toBe(1 + 16 + 1 + 2 * 48);
  });

  test("buildSettleBatchIx encodes per-event payload + ordered accounts", () => {
    const settler = newPk();
    const sa = newPk();
    const callId = new Uint8Array(16).fill(0xab);
    const slug = slugBytes("openai");
    const agentOwner = newPk();
    const agentAta = newPk();
    const endpointConfig = newPk();
    const coveragePool = newPk();
    const poolVault = newPk();
    const treasuryAta = newPk();
    const callRecordPda = newPk();

    const ix = buildSettleBatchIx({
      settler,
      settlementAuthority: sa,
      events: [
        {
          callId,
          agentOwner,
          agentAta,
          endpointConfig,
          coveragePool,
          poolVault,
          slug,
          premiumLamports: 10_000n,
          refundLamports: 0n,
          latencyMs: 250,
          breach: false,
          timestamp: 1714000000,
          feeRecipientAtas: [treasuryAta],
        },
      ],
      callRecordPdas: [callRecordPda],
    });

    expect(ix.data[0]).toBe(DISC_SETTLE_BATCH);
    expect(ix.data.readUInt16LE(1)).toBe(1); // event count
    expect(ix.data.length).toBe(1 + 2 + SETTLE_EVENT_BYTES);
    // Event payload starts at offset 3.
    const off = 3;
    expect(Array.from(ix.data.subarray(off, off + 16))).toEqual(
      Array.from(callId)
    );
    expect(
      Array.from(ix.data.subarray(off + 16, off + 48))
    ).toEqual(Array.from(agentOwner.toBytes()));
    expect(Array.from(ix.data.subarray(off + 48, off + 64))).toEqual(
      Array.from(slug)
    );
    expect(ix.data.readBigUInt64LE(off + 64)).toBe(10_000n);
    expect(ix.data.readBigUInt64LE(off + 72)).toBe(0n);
    expect(ix.data.readUInt32LE(off + 80)).toBe(250);
    expect(ix.data[off + 84]).toBe(0); // breach
    expect(ix.data[off + 85]).toBe(1); // fee_recipient_count_hint
    expect(ix.data.readBigInt64LE(off + 92)).toBe(1714000000n);

    // Account ordering: 4 fixed prefix + 5 per-event + 1 fee ATA.
    expect(ix.keys).toHaveLength(4 + 5 + 1);
    expect(ix.keys[0].pubkey.equals(settler)).toBe(true);
    expect(ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[1].pubkey.equals(sa)).toBe(true);
    expect(ix.keys[1].isWritable).toBe(false);
    expect(ix.keys[2].pubkey.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(ix.keys[3].pubkey.equals(SystemProgram.programId)).toBe(true);
    expect(ix.keys[4].pubkey.equals(callRecordPda)).toBe(true);
    expect(ix.keys[5].pubkey.equals(coveragePool)).toBe(true);
    expect(ix.keys[6].pubkey.equals(poolVault)).toBe(true);
    expect(ix.keys[7].pubkey.equals(endpointConfig)).toBe(true);
    expect(ix.keys[8].pubkey.equals(agentAta)).toBe(true);
    expect(ix.keys[9].pubkey.equals(treasuryAta)).toBe(true);
  });

  test("buildSettleBatchIx mismatched callRecordPdas count throws", () => {
    expect(() =>
      buildSettleBatchIx({
        settler: newPk(),
        settlementAuthority: newPk(),
        events: [],
        callRecordPdas: [newPk()],
      })
    ).toThrow();
  });

  test("buildApproveIx targets SPL Token program with discriminator 4", () => {
    const ix = buildApproveIx({
      agentAta: newPk(),
      settlementAuthorityPda: newPk(),
      allowanceLamports: 1_000_000n,
      agentOwner: newPk(),
    });
    expect(ix.programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(ix.data[0]).toBe(4);
    expect(ix.data.readBigUInt64LE(1)).toBe(1_000_000n);
    expect(ix.keys).toHaveLength(3);
    expect(ix.keys[0].isWritable).toBe(true); // source
    expect(ix.keys[1].isWritable).toBe(false); // delegate readonly
    expect(ix.keys[2].isSigner).toBe(true); // owner
  });

  test("buildRevokeIx targets SPL Token program with discriminator 5", () => {
    const ix = buildRevokeIx({
      agentAta: newPk(),
      agentOwner: newPk(),
    });
    expect(ix.programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(ix.data.length).toBe(1);
    expect(ix.data[0]).toBe(5);
    expect(ix.keys).toHaveLength(2);
    expect(ix.keys[0].isWritable).toBe(true);
    expect(ix.keys[1].isSigner).toBe(true);
  });

  test("custom programId overrides default PROGRAM_ID", () => {
    const custom = new PublicKey("11111111111111111111111111111111");
    const ix = buildPauseEndpointIx({
      programId: custom,
      authority: newPk(),
      protocolConfig: newPk(),
      endpointConfig: newPk(),
      paused: true,
    });
    expect(ix.programId.equals(custom)).toBe(true);
  });
});
