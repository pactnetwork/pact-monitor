import { ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PushSecretGuard } from "../src/guards/push-secret.guard";

const SECRET = "test-push-secret-xyz";

function ctxFor(headers: Record<string, string>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

function makeGuard(secret: string | undefined): PushSecretGuard {
  const config = { get: (_key: string) => secret } as unknown as ConfigService;
  return new PushSecretGuard(config);
}

describe("PushSecretGuard", () => {
  it("returns true when bearer matches configured secret", () => {
    const guard = makeGuard(SECRET);
    expect(guard.canActivate(ctxFor({ authorization: `Bearer ${SECRET}` }))).toBe(true);
  });

  it("throws UnauthorizedException when authorization header is missing", () => {
    const guard = makeGuard(SECRET);
    expect(() => guard.canActivate(ctxFor({}))).toThrow(UnauthorizedException);
  });

  it("throws UnauthorizedException when bearer value is wrong", () => {
    const guard = makeGuard(SECRET);
    expect(() =>
      guard.canActivate(ctxFor({ authorization: "Bearer wrong-secret" })),
    ).toThrow(UnauthorizedException);
  });

  it("throws UnauthorizedException when INDEXER_PUSH_SECRET is not configured", () => {
    const guard = makeGuard(undefined);
    expect(() =>
      guard.canActivate(ctxFor({ authorization: `Bearer ${SECRET}` })),
    ).toThrow(UnauthorizedException);
  });

  it("throws UnauthorizedException when token is present but not prefixed with Bearer", () => {
    const guard = makeGuard(SECRET);
    expect(() =>
      guard.canActivate(ctxFor({ authorization: SECRET })),
    ).toThrow(UnauthorizedException);
  });

  it("throws UnauthorizedException when authorization header is an empty string", () => {
    const guard = makeGuard(SECRET);
    expect(() =>
      guard.canActivate(ctxFor({ authorization: "" })),
    ).toThrow(UnauthorizedException);
  });
});
