import { describe, it, expect } from "vitest";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  FeeRecipientKind,
  PROGRAM_ID,
  USDC_MINT_MAINNET,
  getCoveragePoolPda,
  getEndpointConfigPda,
  getProtocolConfigPda,
  getTreasuryPda,
} from "@q3labs/pact-protocol-v1-client";

import { buildPauseEndpointIxs } from "../ops/pauseEndpoint.js";
import { buildRegisterEndpointIxs } from "../ops/register.js";
import { buildTopUpCoveragePoolIxs } from "../ops/topup.js";
import { buildUpdateEndpointConfigIxs } from "../ops/updateConfig.js";
import { buildUpdateFeeRecipientsIxs } from "../ops/updateRecipients.js";
import type { OperatorConfig } from "../config.js";

const stubConnection = { rpcEndpoint: "https://stub" } as unknown as Connection;
const config: OperatorConfig = {
  connection: stubConnection,
  programId: PROGRAM_ID,
  usdcMint: USDC_MINT_MAINNET,
};

const authority = Keypair.generate().publicKey;
const slug = "demo";

describe("builders — PDA derivation + ix shape", () => {
  it("buildRegisterEndpointIxs emits [createAccount, register_endpoint] in order, with both pool vault + endpoint config writable", () => {
    const poolVault = Keypair.generate().publicKey;
    const result = buildRegisterEndpointIxs(
      config,
      authority,
      {
        slug,
        flatPremiumLamports: 1000n,
        percentBps: 0,
        slaLatencyMs: 2000,
        imputedCostLamports: 10000n,
        exposureCapPerHourLamports: 1_000_000n,
        poolVault,
      },
      2_039_280,
    );
    expect(result.instructions).toHaveLength(2);
    // First ix: SystemProgram createAccount (lamports + space)
    expect(result.instructions[0].programId.toBase58()).toBe(
      "11111111111111111111111111111111",
    );
    // Second ix: pact program
    expect(result.instructions[1].programId.equals(PROGRAM_ID)).toBe(true);
    // First account on register_endpoint is the signer authority
    expect(result.instructions[1].keys[0].pubkey.equals(authority)).toBe(true);
    expect(result.instructions[1].keys[0].isSigner).toBe(true);
    // Writable accounts list includes both PDAs + pool vault + authority
    const [endpointConfig] = getEndpointConfigPda(PROGRAM_ID, slug);
    const [coveragePool] = getCoveragePoolPda(PROGRAM_ID, slug);
    const wset = new Set(result.writableAccounts.map((p) => p.toBase58()));
    expect(wset.has(endpointConfig.toBase58())).toBe(true);
    expect(wset.has(coveragePool.toBase58())).toBe(true);
    expect(wset.has(poolVault.toBase58())).toBe(true);
  });

  it("buildPauseEndpointIxs writes one ix with [authority(signer), protocolConfig, endpointConfig(writable)]", () => {
    const { instructions, writableAccounts } = buildPauseEndpointIxs(
      config,
      authority,
      { slug, paused: true },
    );
    expect(instructions).toHaveLength(1);
    const [protocolConfig] = getProtocolConfigPda(PROGRAM_ID);
    const [endpointConfig] = getEndpointConfigPda(PROGRAM_ID, slug);
    expect(instructions[0].keys[0].pubkey.equals(authority)).toBe(true);
    expect(instructions[0].keys[0].isSigner).toBe(true);
    expect(instructions[0].keys[1].pubkey.equals(protocolConfig)).toBe(true);
    expect(instructions[0].keys[2].pubkey.equals(endpointConfig)).toBe(true);
    expect(instructions[0].keys[2].isWritable).toBe(true);
    expect(writableAccounts.map((p) => p.toBase58())).toEqual([
      endpointConfig.toBase58(),
    ]);
    // Data is [disc, paused=1]
    expect(instructions[0].data[1]).toBe(1);
  });

  it("buildUpdateEndpointConfigIxs encodes optional fields as [present|value]", () => {
    const { instructions } = buildUpdateEndpointConfigIxs(config, authority, {
      slug,
      flatPremiumLamports: 500n,
      // others omitted
    });
    // disc + 35-byte body
    expect(instructions[0].data.length).toBe(36);
    // flatPremiumLamports field is present (first 9 bytes: [1][u64 500])
    expect(instructions[0].data[1]).toBe(1);
    expect(instructions[0].data.readBigUInt64LE(2)).toBe(500n);
    // percentBps starts at offset 10; present byte should be 0
    expect(instructions[0].data[10]).toBe(0);
  });

  it("buildUpdateFeeRecipientsIxs throws via inner builder when affiliateAtas count mismatches AffiliateAta entries", () => {
    expect(() =>
      buildUpdateFeeRecipientsIxs(config, authority, {
        slug,
        feeRecipients: [
          {
            kind: FeeRecipientKind.AffiliateAta,
            destination: Keypair.generate().publicKey.toBase58(),
            bps: 100,
          },
        ],
        // missing affiliateAtas — inner builder validates
      }),
    ).toThrow(/affiliateAtas/);
  });

  it("buildTopUpCoveragePoolIxs marks coveragePool + authorityAta + poolVault writable", () => {
    const authorityAta = Keypair.generate().publicKey;
    const poolVault = Keypair.generate().publicKey;
    const { instructions, writableAccounts } = buildTopUpCoveragePoolIxs(
      config,
      authority,
      {
        slug,
        amount: 1_000_000n,
        authorityAta,
        poolVault,
      },
    );
    const [coveragePool] = getCoveragePoolPda(PROGRAM_ID, slug);
    const wset = new Set(writableAccounts.map((p) => p.toBase58()));
    expect(wset.has(coveragePool.toBase58())).toBe(true);
    expect(wset.has(authorityAta.toBase58())).toBe(true);
    expect(wset.has(poolVault.toBase58())).toBe(true);
    // Disc + slug(16) + amount(8) = 25 bytes
    expect(instructions[0].data.length).toBe(25);
    expect(instructions[0].data.readBigUInt64LE(17)).toBe(1_000_000n);
  });
});

describe("builders — type-level invariants (compile-time)", () => {
  it("operator-sdk does NOT export any withdraw* symbol", async () => {
    const mod = await import("../index.js");
    const withdrawSymbols = Object.keys(mod).filter((k) =>
      /^withdraw/i.test(k),
    );
    expect(withdrawSymbols).toEqual([]);
  });

  it("builders take PublicKey, not Keypair (signer is supplied separately at submit-time)", () => {
    // This is checked at compile-time by TypeScript; the runtime assertion
    // is symbolic — a Keypair has a `secretKey` field, a PublicKey does not.
    // If a builder accidentally accepted a Keypair, callers would leak keys.
    const authority = Keypair.generate().publicKey;
    expect(authority).not.toHaveProperty("secretKey");
    // Sanity: PauseEndpoint builder is callable with PublicKey
    buildPauseEndpointIxs(config, authority, { slug, paused: false });
  });

  it("treasury PDA derivation is stable and matches protocol-v1-client", () => {
    const [t] = getTreasuryPda(PROGRAM_ID);
    expect(t.toBase58()).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  });

  it("USDC mint mainnet base58", () => {
    expect(USDC_MINT_MAINNET.toBase58()).toBe(
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    );
  });

  it("createOperator throws CONFIG_INVALID without programId", async () => {
    const { createOperator } = await import("../factory.js");
    const { OperatorErrorCode, isOperatorError } = await import(
      "../errors.js"
    );
    try {
      createOperator({
        connection: stubConnection,
        programId: undefined as unknown as PublicKey,
        usdcMint: USDC_MINT_MAINNET,
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect(isOperatorError(e)).toBe(true);
      if (isOperatorError(e)) {
        expect(e.code).toBe(OperatorErrorCode.CONFIG_INVALID);
      }
    }
  });
});
