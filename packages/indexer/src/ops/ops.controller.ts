import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { OpsService } from "./ops.service";

interface SignedOpsRequest {
  signerPubkey: string;
  message: string;
  signature: string;
}

interface PauseRequest extends SignedOpsRequest {
  slug: string;
  paused: boolean;
}

interface UpdateConfigRequest extends SignedOpsRequest {
  slug: string;
  config: Record<string, unknown>;
}

interface TopupRequest extends SignedOpsRequest {
  amountLamports: string;
}

@Controller("api/ops")
export class OpsController {
  constructor(private readonly ops: OpsService) {}

  @Post("pause")
  @HttpCode(200)
  async pause(@Body() body: PauseRequest) {
    await this.ops.verifyOperator(body.signerPubkey, body.message, body.signature);
    const unsignedTx = await this.ops.buildPauseEndpointTx(body.slug, body.paused);
    return { unsignedTx };
  }

  @Post("update-config")
  @HttpCode(200)
  async updateConfig(@Body() body: UpdateConfigRequest) {
    await this.ops.verifyOperator(body.signerPubkey, body.message, body.signature);
    const unsignedTx = await this.ops.buildUpdateConfigTx(body.slug, body.config);
    return { unsignedTx };
  }

  @Post("topup")
  @HttpCode(200)
  async topup(@Body() body: TopupRequest) {
    await this.ops.verifyOperator(body.signerPubkey, body.message, body.signature);
    const unsignedTx = await this.ops.buildTopupTx(body.amountLamports);
    return { unsignedTx };
  }
}
