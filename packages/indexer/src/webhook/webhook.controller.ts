import { Controller, Post, Body, Headers, UnauthorizedException } from "@nestjs/common";
import { WebhookParserService } from "./parser.service";

// TODO: implement Helius enhanced webhook handler in Phase 3
@Controller("webhook")
export class WebhookController {
  constructor(private readonly parser: WebhookParserService) {}

  @Post("helius")
  async handleHelius(
    @Headers("authorization") auth: string,
    @Body() body: unknown,
  ) {
    const secret = process.env.HELIUS_WEBHOOK_SECRET;
    if (secret && auth !== `Bearer ${secret}`) {
      throw new UnauthorizedException();
    }
    return this.parser.parse(body);
  }
}
