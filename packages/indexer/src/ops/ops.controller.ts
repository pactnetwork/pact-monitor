import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { OpsDisabledInProdGuard } from "./ops-disabled-in-prod.guard";
import {
  FeeRecipientInput,
  OpsService,
  UpdateEndpointConfigInput,
} from "./ops.service";

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
  config: UpdateEndpointConfigInput;
}

interface TopupRequest extends SignedOpsRequest {
  slug: string;
  amountLamports: string;
}

interface UpdateFeeRecipientsRequest extends SignedOpsRequest {
  recipients: FeeRecipientInput[];
}

@UseGuards(OpsDisabledInProdGuard)
@Controller("api/ops")
export class OpsController {
  constructor(private readonly ops: OpsService) {}

  @Post("pause")
  @HttpCode(200)
  async pause(@Body() body: PauseRequest) {
    await this.ops.verifyOperator(
      body.signerPubkey,
      body.message,
      body.signature,
    );
    const unsignedTx = await this.ops.buildPauseEndpointTx(
      body.slug,
      body.paused,
    );
    return { unsignedTx };
  }

  @Post("update-config")
  @HttpCode(200)
  async updateConfig(@Body() body: UpdateConfigRequest) {
    await this.ops.verifyOperator(
      body.signerPubkey,
      body.message,
      body.signature,
    );
    const unsignedTx = await this.ops.buildUpdateConfigTx(
      body.slug,
      body.config,
    );
    return { unsignedTx };
  }

  @Post("topup")
  @HttpCode(200)
  async topup(@Body() body: TopupRequest) {
    await this.ops.verifyOperator(
      body.signerPubkey,
      body.message,
      body.signature,
    );
    const unsignedTx = await this.ops.buildTopupTx(
      body.slug,
      body.amountLamports,
    );
    return { unsignedTx };
  }

  @Post("update-fee-recipients")
  @HttpCode(200)
  async updateFeeRecipients(@Body() body: UpdateFeeRecipientsRequest) {
    await this.ops.verifyOperator(
      body.signerPubkey,
      body.message,
      body.signature,
    );
    const unsignedTx = await this.ops.buildUpdateFeeRecipientsTx(
      body.recipients,
    );
    return { unsignedTx };
  }
}
