import { Injectable } from "@nestjs/common";

// TODO: parse Helius enhanced transaction logs into typed settlement events
@Injectable()
export class WebhookParserService {
  parse(_payload: unknown): { received: boolean } {
    return { received: true };
  }
}
