// Build the retry header that pact pay attaches to the second invocation
// of the wrapped tool after a 402 challenge.
//
// pact pay does NOT sign a fresh per-call SPL transfer (the standard x402
// "exact" flow). Instead, it signs an authorization referencing the agent's
// pre-existing SPL Approve allowance to SettlementAuthority. The Pact-aware
// gateway verifies the signature, then invokes the v1 program's settle path
// to debit the allowance on-chain. The agent never sees a per-call prompt
// because the project wallet is on-disk (not a hardware keychain).
//
// Wire format (base64-encoded JSON):
//   {
//     "version": 1,
//     "scheme": "pact-allowance",
//     "network": "<solana | solana-devnet>",
//     "payload": {
//       "agent": "<base58 pubkey>",
//       "resource": "<resource URL>",
//       "recipient": "<base58 pubkey>",
//       "amount": "<amount in base units>",
//       "asset": "<asset slug or mint>",
//       "nonce": "<base58 16 random bytes>",
//       "timestampMs": <ms since epoch>,
//       "signature": "<base58 ed25519 signature>"
//     }
//   }
//
// Canonical signing payload (bytes signed by the agent):
//   pact-allowance.v1\n<resource>\n<recipient>\n<amount>\n<asset>\n<network>\n<nonce>\n<timestampMs>
//
// Real third-party x402 "exact" envelopes (which carry a base64 signed
// transaction) are out of scope for v0.1.0; pact pay's wire format remains
// x402-compatible at the header layer, so a future commit can switch the
// payload shape without touching the runner.

import { randomBytes } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";

import { HEADER_PAYMENT_V2 } from "./x402.ts";
import { HEADER_AUTHORIZATION, SCHEME_SOLANA_CHARGE } from "./mpp.ts";

export const PACT_PAYMENT_SCHEME = "pact-allowance";
export const PACT_PAYMENT_VERSION = 1;

export interface PaymentInput {
  resource: string;
  recipient: string;
  amount: string;
  asset: string;
  network: string;
  keypair: Keypair;
  // Override clock for deterministic tests.
  now?: () => number;
  // Override nonce source for deterministic tests.
  randomNonce?: () => Uint8Array;
}

export interface BuiltHeader {
  name: string;
  value: string;
}

function canonicalPayload(args: {
  resource: string;
  recipient: string;
  amount: string;
  asset: string;
  network: string;
  nonce: string;
  timestampMs: number;
}): string {
  return [
    "pact-allowance.v1",
    args.resource,
    args.recipient,
    args.amount,
    args.asset,
    args.network,
    args.nonce,
    String(args.timestampMs),
  ].join("\n");
}

export function buildEnvelope(input: PaymentInput): {
  envelope: object;
  base64: string;
} {
  const ts = (input.now ?? Date.now)();
  const nonceBytes = (input.randomNonce ?? (() => randomBytes(16)))();
  const nonce = bs58.encode(nonceBytes);
  const payload = canonicalPayload({
    resource: input.resource,
    recipient: input.recipient,
    amount: input.amount,
    asset: input.asset,
    network: input.network,
    nonce,
    timestampMs: ts,
  });
  const sig = nacl.sign.detached(
    new TextEncoder().encode(payload),
    input.keypair.secretKey,
  );
  const envelope = {
    version: PACT_PAYMENT_VERSION,
    scheme: PACT_PAYMENT_SCHEME,
    network: input.network,
    payload: {
      agent: input.keypair.publicKey.toBase58(),
      resource: input.resource,
      recipient: input.recipient,
      amount: input.amount,
      asset: input.asset,
      nonce,
      timestampMs: ts,
      signature: bs58.encode(sig),
    },
  };
  const base64 = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
  return { envelope, base64 };
}

export function buildX402PaymentHeader(input: PaymentInput): BuiltHeader {
  const { base64 } = buildEnvelope(input);
  // x402 v2 wire format: a single base64-encoded envelope sent as X-PAYMENT.
  return { name: HEADER_PAYMENT_V2, value: base64 };
}

export function buildMppCredentialHeader(input: PaymentInput): BuiltHeader {
  const { base64 } = buildEnvelope(input);
  // MPP retry header: Authorization: SolanaCharge credential="<base64>"
  return {
    name: HEADER_AUTHORIZATION,
    value: `${SCHEME_SOLANA_CHARGE} credential="${base64}"`,
  };
}

export function decodeEnvelope(base64: string): unknown {
  return JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
}

export function verifyEnvelopeSignature(envelope: {
  payload: {
    agent: string;
    resource: string;
    recipient: string;
    amount: string;
    asset: string;
    nonce: string;
    timestampMs: number;
    signature: string;
  };
  network: string;
}): boolean {
  // Test-only helper — the gateway has its own verifier. Useful for exercising
  // round-trip integrity in unit tests so we catch payload-shape drift.
  const payload = canonicalPayload({
    resource: envelope.payload.resource,
    recipient: envelope.payload.recipient,
    amount: envelope.payload.amount,
    asset: envelope.payload.asset,
    network: envelope.network,
    nonce: envelope.payload.nonce,
    timestampMs: envelope.payload.timestampMs,
  });
  const sig = bs58.decode(envelope.payload.signature);
  const pk = bs58.decode(envelope.payload.agent);
  return nacl.sign.detached.verify(
    new TextEncoder().encode(payload),
    sig,
    pk,
  );
}
