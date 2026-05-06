import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

/**
 * Gates the OpsController behind NODE_ENV.
 *
 * The ops endpoints currently have two unresolved pre-mainnet bugs:
 *
 *  - B5: ed25519 signatures are verified against an operator allowlist with
 *        no timestamp/nonce/replay protection — once an operator signs any
 *        message, the signature is replayable forever.
 *  - B6: OpsService.build*Tx returns a JSON-base64 blob, NOT a real Solana
 *        transaction. No wallet (Phantom/Solflare/Backpack) can sign it.
 *
 * Until both are fixed, this guard 404s the routes in production so nothing
 * public-facing depends on the broken endpoints. We return NotFoundException
 * (404) rather than ForbiddenException (403) so the routes don't advertise
 * their existence to mainnet probes.
 */
@Injectable()
export class OpsDisabledInProdGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    if (process.env.NODE_ENV === "production") {
      throw new NotFoundException();
    }
    return true;
  }
}
