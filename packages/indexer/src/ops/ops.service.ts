import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import nacl from "tweetnacl";
import bs58 from "bs58";

@Injectable()
export class OpsService {
  constructor(private readonly prisma: PrismaService) {}

  async verifyOperator(signerPubkey: string, message: string, signatureB58: string): Promise<void> {
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

  async buildPauseEndpointTx(slug: string, paused: boolean): Promise<string> {
    // TODO(wave2-integration): replace with @pact-network/market-client once Codama client is published
    return Buffer.from(
      JSON.stringify({ instruction: "pause_endpoint", slug, paused }),
    ).toString("base64");
  }

  async buildUpdateConfigTx(slug: string, config: Record<string, unknown>): Promise<string> {
    // TODO(wave2-integration): replace with @pact-network/market-client once Codama client is published
    return Buffer.from(
      JSON.stringify({ instruction: "update_endpoint_config", slug, ...config }),
    ).toString("base64");
  }

  async buildTopupTx(amountLamports: string): Promise<string> {
    // TODO(wave2-integration): replace with @pact-network/market-client once Codama client is published
    return Buffer.from(
      JSON.stringify({ instruction: "top_up_coverage_pool", amountLamports }),
    ).toString("base64");
  }
}
