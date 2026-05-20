/**
 * Agent-authenticated webhook registration. Separate controller (NOT the
 * unauthenticated AgentsController the SDK poller depends on) so the read
 * path stays guard-free. ed25519-signed via AgentSignatureGuard.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AgentSignatureGuard } from "./agent-signature.guard";
import { assertSafeWebhookUrl, SsrfRejectedError } from "./ssrf-guard";

@Controller("api/agents")
export class AgentsWebhookController {
  constructor(private readonly prisma: PrismaService) {}

  @Post(":pubkey/webhook")
  @UseGuards(AgentSignatureGuard)
  async register(
    @Param("pubkey") pubkey: string,
    @Body() body: { webhookUrl?: string },
  ): Promise<{ webhookUrl: string; registeredAt: string }> {
    const raw = body?.webhookUrl;
    if (typeof raw !== "string" || !raw) {
      throw new BadRequestException("webhookUrl (https) is required");
    }
    try {
      assertSafeWebhookUrl(raw);
    } catch (err) {
      throw new BadRequestException(
        err instanceof SsrfRejectedError ? err.message : "invalid webhookUrl",
      );
    }
    const now = new Date();
    await this.prisma.agent.upsert({
      where: { pubkey },
      create: {
        pubkey,
        createdAt: now,
        webhookUrl: raw,
        webhookRegisteredAt: now,
      },
      update: {
        webhookUrl: raw,
        webhookRegisteredAt: now,
        webhookFailCount: 0,
      },
    });
    return { webhookUrl: raw, registeredAt: now.toISOString() };
  }

  @Delete(":pubkey/webhook")
  @UseGuards(AgentSignatureGuard)
  async unregister(
    @Param("pubkey") pubkey: string,
  ): Promise<{ ok: true }> {
    await this.prisma.agent.updateMany({
      where: { pubkey },
      data: { webhookUrl: null, webhookRegisteredAt: null, webhookFailCount: 0 },
    });
    return { ok: true };
  }
}
