import { Module } from "@nestjs/common";
import { RefundDeliveryService } from "./refund-delivery.service";
import { AgentSignatureGuard } from "./agent-signature.guard";
import { AgentsWebhookController } from "./agents-webhook.controller";

/**
 * Outbound refund-push. Deliberately named `refund-delivery` (NOT `webhook`)
 * so it does not collide with the existing inbound Helius `webhook/` module.
 * PrismaModule is @Global; ConfigModule is global — no extra imports needed.
 */
@Module({
  controllers: [AgentsWebhookController],
  providers: [RefundDeliveryService, AgentSignatureGuard],
  exports: [RefundDeliveryService],
})
export class RefundDeliveryModule {}
