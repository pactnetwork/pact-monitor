import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Request } from "express";

@Injectable()
export class PushSecretGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const auth = req.headers["authorization"] ?? "";
    const secret = this.config.get<string>("INDEXER_PUSH_SECRET");
    if (!secret || auth !== `Bearer ${secret}`) {
      throw new UnauthorizedException("Invalid or missing push secret");
    }
    return true;
  }
}
