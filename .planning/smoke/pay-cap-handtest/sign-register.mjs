// Dependency-free signer for POST /v1/coverage/register.
//
// Replicates the pact-cli envelope BYTE-FOR-BYTE (see
// packages/cli/src/lib/facilitator.ts + transport.ts and
// packages/facilitator/src/middleware/verify-signature.ts):
//
//   canonical payload = "v1\nPOST\n/v1/coverage/register\n<ts>\n<nonce>\n<bodyHash>"
//   bodyHash          = sha256hex(bodyBytes)   (the EXACT bytes POSTed)
//   nonce             = bs58(16 random bytes)
//   sig               = ed25519_sign(utf8(payload), agentSecretKey)  -> bs58
//   headers           = content-type, x-pact-agent, x-pact-timestamp,
//                       x-pact-nonce, x-pact-signature, x-pact-project
//
// Uses only Node built-ins (crypto, fs) — no bs58/tweetnacl/web3.js — so it
// runs from any cwd. ed25519 signing is done with Node's crypto by wrapping the
// 32-byte seed in the fixed ed25519 PKCS8 prefix. The agent NEVER prints/saves
// its secret key — only the public key.
//
// Unverified mode: payee + paymentSignature are OMITTED, so the facilitator
// skips on-chain payment verification and the per-call imputed-cost cap is the
// only thing bounding the refund.

import { createHash, randomBytes, sign as edSign, createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";

const ALPH = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(s) {
  let bytes = [0];
  for (const c of s) {
    let carry = ALPH.indexOf(c);
    if (carry < 0) throw new Error("bad base58 char");
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (let k = 0; k < s.length && s[k] === "1"; k++) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}
function b58encode(buf) {
  let digits = [0];
  for (const b of buf) {
    let carry = b;
    for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let s = "";
  for (const b of buf) { if (b === 0) s += "1"; else break; }
  for (let k = digits.length - 1; k >= 0; k--) s += ALPH[digits[k]];
  return s;
}

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const walletPath = arg("wallet");
const amount = arg("amount");
const resource = arg("resource", "https://pay.local/handtest");
const verdict = arg("verdict", "server_error");
const project = arg("project", "handtest");
const asset = arg("asset", process.env.USDC_MINT);
const url = (arg("url", process.env.FACILITATOR_URL) || "http://localhost:8080").replace(/\/$/, "");
const reqOut = arg("reqout");
const resOut = arg("resout");

if (!walletPath || !amount || !asset) {
  console.error("usage: --wallet <path> --amount <baseUnits> --asset <mint> [--resource --verdict --url --reqout --resout]");
  process.exit(2);
}

// --- Load agent keypair (NEVER print the secret) ---
const secretKeyB58 = JSON.parse(readFileSync(walletPath, "utf8")).secretKey;
const sk64 = b58decode(secretKeyB58); // 64 bytes: seed(32) || pubkey(32)
if (sk64.length !== 64) throw new Error(`expected 64-byte secretKey, got ${sk64.length}`);
const seed = Buffer.from(sk64.slice(0, 32));
const pubFromBytes = b58encode(sk64.slice(32, 64));

// Build an ed25519 private key from the seed via the fixed PKCS8 prefix.
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
// Cross-check: pubkey derived from the private key must equal last-32-bytes.
const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
const pubFromKey = b58encode(spki.subarray(spki.length - 32));
if (pubFromKey !== pubFromBytes) throw new Error("pubkey mismatch: keypair file is malformed");
const agent = pubFromBytes;

// --- Build the request body (UNVERIFIED mode: no payee, no paymentSignature) ---
const body = {
  agent,
  resource,
  scheme: "x402",
  amountBaseUnits: String(amount),
  asset,
  verdict,
  latencyMs: 12000,
};
const bodyStr = JSON.stringify(body);

// --- Sign the canonical envelope ---
const ts = Date.now();
const nonce = b58encode(randomBytes(16));
const bodyHash = bodyStr ? createHash("sha256").update(bodyStr, "utf8").digest("hex") : "";
const payload = `v1\nPOST\n/v1/coverage/register\n${ts}\n${nonce}\n${bodyHash}`;
const sig = edSign(null, Buffer.from(payload, "utf8"), privateKey); // 64-byte ed25519 sig
const sigB58 = b58encode(sig);

const headers = {
  "content-type": "application/json",
  "x-pact-agent": agent,
  "x-pact-timestamp": String(ts),
  "x-pact-nonce": nonce,
  "x-pact-signature": sigB58,
  "x-pact-project": project,
};

// Persist the request artifact (no secrets — signature/pubkey are public).
if (reqOut) {
  const reqArtifact = {
    url: `${url}/v1/coverage/register`,
    method: "POST",
    agentPubkey: agent,
    canonicalPayload: payload,
    headers,
    body,
  };
  const { writeFileSync } = await import("node:fs");
  writeFileSync(reqOut, JSON.stringify(reqArtifact, null, 2));
}

// --- Fire ---
const resp = await fetch(`${url}/v1/coverage/register`, { method: "POST", headers, body: bodyStr });
const text = await resp.text();
let parsed;
try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
const out = { httpStatus: resp.status, response: parsed };
if (resOut) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(resOut, JSON.stringify(out, null, 2));
}
console.log(`[sign-register] agent=${agent} amount=${amount} -> HTTP ${resp.status}`);
console.log(JSON.stringify(parsed));
process.exit(resp.status >= 200 && resp.status < 300 ? 0 : 1);
