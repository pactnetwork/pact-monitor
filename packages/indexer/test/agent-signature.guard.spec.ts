import { ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { AgentSignatureGuard } from "../src/refund-delivery/agent-signature.guard";

function ctxFor(req: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function signedReq(opts?: {
  ts?: number;
  nonce?: string;
  body?: string;
  tamperSig?: boolean;
  agentMismatch?: boolean;
}) {
  const kp = nacl.sign.keyPair();
  const agent = bs58.encode(kp.publicKey);
  const ts = opts?.ts ?? Date.now();
  const nonce = opts?.nonce ?? bs58.encode(nacl.randomBytes(16));
  const bodyStr = opts?.body ?? '{"webhookUrl":"https://x.example.com/h"}';
  const rawBody = Buffer.from(bodyStr, "utf8");
  const path = "/api/agents/" + agent + "/webhook";
  const bodyHash =
    rawBody.length === 0
      ? ""
      : createHash("sha256").update(rawBody).digest("hex");
  const canonical = `v1\nPOST\n${path}\n${ts}\n${nonce}\n${bodyHash}`;
  const sig = nacl.sign.detached(
    new TextEncoder().encode(canonical),
    kp.secretKey,
  );
  return {
    method: "POST",
    originalUrl: path,
    url: path,
    params: { pubkey: opts?.agentMismatch ? "OTHER" : agent },
    rawBody,
    headers: {
      "x-pact-agent": agent,
      "x-pact-timestamp": String(ts),
      "x-pact-nonce": nonce,
      "x-pact-signature": opts?.tamperSig
        ? bs58.encode(new Uint8Array(64))
        : bs58.encode(sig),
    },
  };
}

describe("AgentSignatureGuard", () => {
  let guard: AgentSignatureGuard;
  beforeEach(() => {
    guard = new AgentSignatureGuard();
  });

  it("accepts a correctly signed request", () => {
    expect(guard.canActivate(ctxFor(signedReq()))).toBe(true);
  });

  it("rejects a stale timestamp", () => {
    expect(() =>
      guard.canActivate(ctxFor(signedReq({ ts: Date.now() - 120_000 }))),
    ).toThrow(UnauthorizedException);
  });

  it("rejects a replayed nonce", () => {
    const r = signedReq();
    expect(guard.canActivate(ctxFor(r))).toBe(true);
    expect(() => guard.canActivate(ctxFor(r))).toThrow(UnauthorizedException);
  });

  it("rejects x-pact-agent != :pubkey", () => {
    expect(() =>
      guard.canActivate(ctxFor(signedReq({ agentMismatch: true }))),
    ).toThrow(/agent_mismatch/);
  });

  it("rejects a bad signature", () => {
    expect(() =>
      guard.canActivate(ctxFor(signedReq({ tamperSig: true }))),
    ).toThrow(/bad_sig/);
  });

  it("rejects missing headers", () => {
    expect(() =>
      guard.canActivate(
        ctxFor({
          method: "POST",
          originalUrl: "/x",
          url: "/x",
          params: { pubkey: "p" },
          headers: {},
        }),
      ),
    ).toThrow(/missing/);
  });
});
