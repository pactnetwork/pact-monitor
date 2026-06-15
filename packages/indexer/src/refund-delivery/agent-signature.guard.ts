/**
 * Agent-identity guard for webhook registration. Ports the market-proxy's
 * ed25519 scheme (verify-signature.ts) to a Nest guard: the caller proves
 * control of `:pubkey` by signing the canonical request string. NOT bearer /
 * apiKey gated — `apiKey` is a documented no-op in this system, and a
 * bearer-gated webhook-URL write would be an SSRF-amplification hole.
 *
 * Canonical (UTF-8), same family as verify-signature.ts:
 *   v1\n{METHOD}\n{path}\n{tsMs}\n{nonce}\n{sha256hex(rawBody) | ""}
 * Requires `app` created with `{ rawBody: true }` so `req.rawBody` is the
 * exact bytes hashed.
 */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";

const SKEW_MS = 30_000;
const REPLAY_TTL_MS = 60_000;

interface RawBodyRequest {
  method: string;
  originalUrl: string;
  url: string;
  params: Record<string, string>;
  rawBody?: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

@Injectable()
export class AgentSignatureGuard implements CanActivate {
  private readonly seen = new Map<string, number>();

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<RawBodyRequest>();
    const h = (k: string): string | undefined => {
      const v = req.headers[k];
      return Array.isArray(v) ? v[0] : v;
    };
    const agent = h("x-pact-agent");
    const ts = h("x-pact-timestamp");
    const nonce = h("x-pact-nonce");
    const signature = h("x-pact-signature");
    if (!agent || !ts || !nonce || !signature) {
      throw new UnauthorizedException("pact_auth_missing");
    }
    if (agent !== req.params.pubkey) {
      throw new UnauthorizedException("pact_auth_agent_mismatch");
    }
    const tsMs = Number.parseInt(ts, 10);
    if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > SKEW_MS) {
      throw new UnauthorizedException("pact_auth_stale");
    }
    const replayKey = `${agent}:${nonce}`;
    const now = Date.now();
    if (this.seen.size > 1024) {
      for (const [k, exp] of this.seen) if (exp <= now) this.seen.delete(k);
    }
    const exp = this.seen.get(replayKey);
    if (exp !== undefined && exp > now) {
      throw new UnauthorizedException("pact_auth_replay");
    }
    this.seen.set(replayKey, now + REPLAY_TTL_MS);

    const path = req.originalUrl ?? req.url;
    const body = req.rawBody ?? Buffer.alloc(0);
    const bodyHash =
      body.length === 0
        ? ""
        : createHash("sha256").update(body).digest("hex");
    const payload = `v1\n${req.method.toUpperCase()}\n${path}\n${tsMs}\n${nonce}\n${bodyHash}`;

    let ok = false;
    try {
      const pk = bs58.decode(agent);
      const sig = bs58.decode(signature);
      ok =
        pk.length === 32 &&
        sig.length === 64 &&
        nacl.sign.detached.verify(
          new TextEncoder().encode(payload),
          sig,
          pk,
        );
    } catch {
      ok = false;
    }
    if (!ok) throw new UnauthorizedException("pact_auth_bad_sig");
    return true;
  }
}
