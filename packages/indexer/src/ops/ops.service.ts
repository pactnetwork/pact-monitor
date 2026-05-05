import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import nacl from "tweetnacl";
import bs58 from "bs58";

// New on-chain program ID (layered phase0).
export const PACT_MARKET_PROGRAM_ID =
  "5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5";

// FeeRecipientKind enum mirroring on-chain layout.
export const FeeRecipientKind = {
  Treasury: 0,
  AffiliateAta: 1,
  AffiliatePda: 2,
} as const;

export interface FeeRecipientInput {
  kind: number; // FeeRecipientKind
  pubkey: string; // base58
  bps: number; // basis points share of the fee envelope
}

export interface UpdateEndpointConfigInput {
  flatPremiumLamports?: string;
  percentBps?: number;
  slaLatencyMs?: number;
  imputedCostLamports?: string;
  exposureCapPerHourLamports?: string;
  upstreamBase?: string;
  displayName?: string;
  logoUrl?: string;
}

@Injectable()
export class OpsService {
  constructor(private readonly prisma: PrismaService) {}

  async verifyOperator(
    signerPubkey: string,
    message: string,
    signatureB58: string,
  ): Promise<void> {
    const entry = await this.prisma.operatorAllowlist.findUnique({
      where: { walletPubkey: signerPubkey },
    });
    if (!entry) {
      throw new UnauthorizedException("Pubkey not in operator allowlist");
    }

    let pubkeyBytes: Uint8Array;
    let sigBytes: Uint8Array;
    let msgBytes: Uint8Array;
    try {
      pubkeyBytes = bs58.decode(signerPubkey);
      sigBytes = bs58.decode(signatureB58);
      msgBytes = new TextEncoder().encode(message);
    } catch {
      throw new UnauthorizedException("Invalid base58 encoding");
    }

    const valid = nacl.sign.detached.verify(msgBytes, sigBytes, pubkeyBytes);
    if (!valid) {
      throw new UnauthorizedException("Signature verification failed");
    }
  }

  // The ix builders below shape the JSON envelope that gets handed to the
  // wallet for signing. When @pact-network/protocol-v1-client lands in the
  // workspace, these will delegate to its `buildPauseEndpointIx`,
  // `buildUpdateEndpointConfigIx`, `buildTopUpCoveragePoolIx`, and
  // `buildUpdateFeeRecipientsIx` helpers respectively. The wire format
  // (base64-encoded unsignedTx string) is preserved across the swap so
  // callers do not need to change.
  //
  // TODO(layered-phase1): replace these stubs with calls into
  // `@pact-network/protocol-v1-client` once Step C of the layering plan
  // lands the protocol-v1-client package.

  async buildPauseEndpointTx(slug: string, paused: boolean): Promise<string> {
    return this.encode({
      programId: PACT_MARKET_PROGRAM_ID,
      instruction: "pause_endpoint",
      slug,
      paused,
    });
  }

  async buildUpdateConfigTx(
    slug: string,
    config: UpdateEndpointConfigInput,
  ): Promise<string> {
    return this.encode({
      programId: PACT_MARKET_PROGRAM_ID,
      instruction: "update_endpoint_config",
      slug,
      ...config,
    });
  }

  async buildTopupTx(slug: string, amountLamports: string): Promise<string> {
    return this.encode({
      programId: PACT_MARKET_PROGRAM_ID,
      instruction: "top_up_coverage_pool",
      slug,
      amountLamports,
    });
  }

  async buildUpdateFeeRecipientsTx(
    recipients: FeeRecipientInput[],
  ): Promise<string> {
    // Atomic recipient array replace — full list overwrites prior config.
    return this.encode({
      programId: PACT_MARKET_PROGRAM_ID,
      instruction: "update_fee_recipients",
      recipients,
    });
  }

  private encode(payload: Record<string, unknown>): string {
    return Buffer.from(JSON.stringify(payload)).toString("base64");
  }
}
