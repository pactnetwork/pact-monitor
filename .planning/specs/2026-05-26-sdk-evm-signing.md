# SDK EVM Signing — Design Contract

**Status:** Design, awaiting impl
**Owner:** Pact Network
**Closes:** G-5 from multi-network smoke test (SDK + CLI are Solana-only; cannot sign requests with an EVM EOA)
**Target branch:** `feat/multi-network`

---

## 1. Status quo recap

Today, every covered `pact.fetch()` call carries an Ed25519 signature over a fixed canonical payload. The SDK builds the headers in `packages/sdk/src/proxy-transport.ts:86` (`buildAuthHeaders`) and signs with `nacl.sign.detached` using the Keypair's 64-byte secret resolved at `packages/sdk/src/signer.ts:52` (`resolveSecretKey`). Headers shipped: `x-pact-agent` (bs58 pubkey), `x-pact-timestamp`, `x-pact-nonce` (bs58 random), `x-pact-signature` (bs58 64-byte sig), `x-pact-project`, and the optional `x-pact-network` discriminator.

The proxy verifies in `packages/market-proxy/src/middleware/verify-signature.ts:93` (`verifyPactSignature`). The middleware **already** branches on agent key format: a `0x` address routes to `viem.verifyMessage` (EIP-191), anything else routes to `nacl.sign.detached.verify`. A cross-VM guard at `verify-signature.ts:164` rejects an Ed25519 agent on an EVM endpoint (and vice versa) when the endpoint network resolver is wired.

**The gap is SDK-side only.** `resolveSecretKey` returns `null` for non-Keypair signers, `golden-fetch.ts:91` degrades any such call to a bare fetch, and `buildAuthHeaders` is hardcoded to `nacl.sign.detached`. An EVM agent has no signing path.

---

## 2. Canonical message format

**Recommendation: match the existing Solana canonical bytes verbatim, but bump the version tag to `v2` and include the network discriminator inside the signed bytes.**

```
v2\n{METHOD}\n{path+search}\n{NETWORK}\n{tsMs}\n{nonce}\n{bodyHash}
```

| Field | Source | Notes |
| --- | --- | --- |
| `v2` | literal | New tag. `v1` (without `NETWORK`) stays accepted by the proxy for one release for backwards compat (see §9). |
| `METHOD` | `init.method`, uppercased | Same as v1. |
| `path+search` | `URL(proxiedUrl).pathname + .search` | Same as v1. Includes `/v1/<slug>/...`. |
| `NETWORK` | `x-pact-network` header value, or literal `""` when absent | **Required to be in the signed bytes.** Without this, an EVM agent's signed request to `base-sepolia` is byte-identical to the same agent's signed request to `arc-testnet`, and an attacker can cross-replay within the agent's nonce window. The cross-VM guard prevents Solana↔EVM replay but not EVM↔EVM or Solana-devnet↔Solana-mainnet. |
| `tsMs` | `Date.now()` | Same ±30 s skew window (`DEFAULT_SKEW_MS = 30_000` at `verify-signature.ts:45`). |
| `nonce` | bs58 of 16 random bytes | **Unchanged.** A bs58 string works for both VMs — it is opaque to the signature primitive. Same single-use nonce cache, same 60 s TTL (`DEFAULT_REPLAY_TTL_MS`). |
| `bodyHash` | hex sha256 of body bytes, or `""` for empty | Same as v1. |

Rationale: the SDK and CLI are the only two writers of this payload (`packages/sdk/src/proxy-transport.ts:33`, `packages/cli/src/lib/transport.ts:36`). Both already build the same string. Adding one field at one position keeps the diff minimal and removes the existing same-VM cross-network replay window.

---

## 3. Signature algorithm

**Recommendation: EIP-191 personal_sign.**

Concretely, the EVM signer computes:

```
prefixed = "\x19Ethereum Signed Message:\n" + decimalLen(payload) + payload
sig      = secp256k1.sign(keccak256(prefixed), privKey)         // 65-byte r||s||v
header   = "0x" + hex(sig)                                       // x-pact-signature
```

This is exactly what `viem.signMessage({ message })` produces and exactly what `viem.verifyMessage` already validates in the proxy. No hand-rolled crypto on either side.

EIP-712 (typed data) is rejected: the wallet UX argument is moot — agents sign in code, not Metamask — and typed data forces a domain separator + schema that adds proxy-side validation surface for zero gain. EIP-191 is the smallest viable EVM signing primitive.

---

## 4. `x-pact-agent` header format

**Recommendation: 0x-prefixed, EIP-55 checksummed address (e.g. `0x1c84F2...`). No dual header. No bs58 wrapping.**

Reasons:
- EVM-native; matches what `viem.isAddress` already gates on at `verify-signature.ts:156`.
- The proxy already infers VM from format (`isAddress(agent) ? "evm" : "solana"`) — no new header needed.
- bs58-wrapping an EVM address forces a custom decode on the proxy and is hostile to every existing EVM tool (block explorers, faucets, wallet libraries).

SDK MUST emit checksummed form; the proxy MUST be tolerant of mixed case (viem's `isAddress` is by default; this should not change).

---

## 5. Signature algo discriminator

**Recommendation: keep the existing format-based inference. Do NOT add `x-pact-sig-algo`.**

Precedence on the proxy (already in code):

1. `isAddress(x-pact-agent)` → `evm` → viem EIP-191 path
2. Otherwise → `solana` → tweetnacl Ed25519 path
3. If `x-pact-network` is present and resolves to a VM family, **cross-check** against (1). Mismatch → 401 `pact_auth_bad_sig` with the existing cross-mode message (`verify-signature.ts:164`).

This avoids a new header, avoids ambiguity, and avoids a downgrade attack where an attacker forges `x-pact-sig-algo` to send an EVM payload through the (weaker, in some sense) Solana path.

The `chains.json` (or its in-memory registry equivalent) lookup is informational: it lets the proxy reject `solana-mainnet` paired with a `0x` agent before the signature math runs. That early reject is already implemented and stays.

---

## 6. Edge cases the impl must handle

| Scenario | Required behavior |
| --- | --- |
| `x-pact-network` missing | Proxy treats canonical payload as if `NETWORK=""` (the literal empty string, still in the signed bytes). SDK MUST send `NETWORK=""` in v2 bytes when no network is configured — silently identical to "no endpointNetwork supplied". |
| `x-pact-network` is `base-sepolia` but `x-pact-agent` is a bs58 Solana pubkey | Reject `401 pact_auth_bad_sig` via the existing cross-mode guard. (Inverse case: same.) |
| `x-pact-network` is `arc-testnet` but the agent's signature was over `base-sepolia` bytes | Verification fails (different signed string) → reject `401 pact_auth_bad_sig`. This is the whole point of §2. |
| Signature too short / too long / not hex / not bs58 | Reject `401 pact_auth_bad_sig` — uniform error path. EVM: viem `verifyMessage` returns false on malformed sig; Solana: existing length check at `verify-signature.ts:197`. |
| EIP-191 with stray `v=0`/`v=1` (legacy ledger) | viem handles both; no SDK-side handling required. |
| Empty body POST | `bodyHash = ""` (string), same as v1. |
| `x-pact-agent` present but no `x-pact-signature` / `x-pact-timestamp` / `x-pact-nonce` / `x-pact-project` | `401 pact_auth_missing` — unchanged. |

---

## 7. Files that will change

### SDK (`packages/sdk/src/`)

| File | Change |
| --- | --- |
| `signer.ts` | Introduce a discriminated `PactSigner` union: `SolanaPactSigner` (current `Keypair` / wallet adapter) and `EvmPactSigner` (new — wraps a viem `LocalAccount` / 0x-private-key). Add `resolveSignFn(signer): (payload: Uint8Array) => Promise<Uint8Array \| string>` so `proxy-transport.ts` is signer-agnostic. Add `signerVm(signer): "solana" \| "evm"`. |
| `config.ts` | Extend `endpointNetwork` validation: when set to a non-Solana network, require an EVM signer. Replace the 64-byte Ed25519 secret check (`config.ts:175`) with a discriminated validator: ed25519 secret OR 0x-prefixed 32-byte secp256k1 private key (`requestSigningSecretKey: Uint8Array \| \`0x${string}\``). Cross-check that the private key derives the claimed agent address (Solana branch already does this; mirror for EVM via `privateKeyToAccount`). |
| `proxy-transport.ts` | `buildAuthHeaders` becomes signer-aware. Build the v2 payload (§2), call `signer.signPayload(payload)`, format the resulting signature per VM (bs58 for Solana, `0x`-hex for EVM), and pick the right `x-pact-agent` shape. `bodyToBytes`, `cleanForwardHeaders`, `parsePactHeaders` are untouched. |
| `golden-fetch.ts` | `GoldenFetchDeps.secretKey: Uint8Array \| null` → `GoldenFetchDeps.sign: SignFn \| null`. `if (!deps.signRequests \|\| !deps.sign) bare(...)` keeps the degrade contract verbatim. |
| `factory.ts` | Wire `resolveSignFn(cfg.signer)` instead of `resolveSecretKey`. Pass `cfg.endpointNetwork` into the payload builder (it's already on `goldenDeps`). |
| `network.ts` | No change. EVM `endpointNetwork` strings are free-form and live in `chains.json`/registry; the SDK does not validate them against a closed list. |
| `__tests__/proxy-transport.test.ts`, `__tests__/golden-fetch.test.ts`, `__tests__/config.test.ts` | Add EVM-path mirrors of every existing Solana case. |
| `package.json` | Add `viem` as a dep if not already present (it is — used by `@pact-network/protocol-evm-v1-client`). No new deps. |

### Proxy (`packages/market-proxy/src/middleware/`)

| File | Change |
| --- | --- |
| `verify-signature.ts` | (a) Update `buildSignaturePayload` to accept and embed `network` per §2; (b) accept both `v1` (legacy, network omitted) and `v2` (network included) tags for one release — SDK ships v2, CLI continues on v1 until a follow-up PR cuts it over; (c) extract `network` from `c.req.header("x-pact-network") ?? ""` and use it for both VM lookup and payload reconstruction; (d) no other changes — the EVM branch (lines 173-186) already calls `viem.verifyMessage(payload)` and stays correct so long as `payload` matches what the SDK signed. |

### CLI (`packages/cli/src/lib/transport.ts`)

Out of scope for this PR (CLI EVM wallet flow is the separately-tracked design in memory `[[project_cli_evm_wallet_init]]`). When the CLI lands EVM signing it MUST use the same signer abstraction and same v2 payload — the design here is what it consumes.

---

## 8. Test matrix

### SDK tests (Vitest, `packages/sdk/src/__tests__/`)

| Test | Asserts |
| --- | --- |
| `proxy-transport — buildAuthHeaders EVM happy path` | Builds v2 payload over `(POST, /v1/helius-rpc/?api=1, base-sepolia, ts, nonce, bodyHash)`. Asserts `x-pact-agent` is checksummed 0x, `x-pact-signature` is 0x-prefixed 132-char hex (65 bytes), `x-pact-network=base-sepolia`. |
| `proxy-transport — Solana path unchanged` | Byte-for-byte identical headers for a Solana Keypair signer with `endpointNetwork="solana-devnet"`. Snapshot test against a fixed `now()` and `randomBytes`. |
| `signer — resolveSignFn picks the right primitive` | Keypair → ed25519 path produces 64-byte sig; 0x-prefixed private key → secp256k1 path produces 65-byte sig. |
| `config — EVM signer with Solana endpointNetwork rejected` | `validateConfig` throws `CONFIG_INVALID` with a clear message. (Inverse case: Solana signer with EVM endpointNetwork.) |
| `golden-fetch — EVM degrade when secretKey/sign is null` | `signRequests: true` + EVM signer with no private key → `degraded: true, reason: "unsigned"`. |

### Proxy tests (`packages/market-proxy/src/middleware/__tests__/`)

| Test | Asserts |
| --- | --- |
| `verify-signature — EVM happy path (v2)` | A request signed with viem `privateKeyToAccount(...).signMessage()` over the v2 payload, sent with `x-pact-network=base-sepolia`, accepts and stashes `verifiedAgent`. |
| `verify-signature — wrong-chain replay rejected` | Same headers as above but `x-pact-network=arc-testnet`. Must `401 pact_auth_bad_sig` (payload reconstruction differs → sig invalid). |
| `verify-signature — Solana payload on EVM verification fails` | bs58 signature + 0x agent → `401`. |
| `verify-signature — EVM payload on Solana verification fails` | 0x signature + bs58 agent → `401`. |
| `verify-signature — v1 (legacy, no network field) still accepted for Solana` | One-release compatibility window. Drops in the follow-up PR. |
| `verify-signature — same-VM cross-network replay rejected for EVM` | Network swap on a captured EVM request → `401`. (Same test as wrong-chain replay, named explicitly for the threat model.) |
| `verify-signature — Solana devnet→mainnet replay rejected` | Network swap on a captured Solana request → `401`. |

---

## 9. Migration / backwards compatibility

- **Solana SDK payload bytes change** (v1 → v2). Risk: existing covered Solana calls 401 against an old proxy or vice versa. Mitigation: the proxy accepts both `v1` and `v2` tags for one release (Step 1 of the PR sequence). The SDK ships v2 from day one — older SDK consumers still send v1 and the proxy still accepts. A follow-up PR removes v1 once telemetry confirms no v1 traffic from non-CLI clients.
- **Existing wire headers** (`x-pact-agent`, `x-pact-timestamp`, `x-pact-nonce`, `x-pact-signature`, `x-pact-project`, `x-pact-network`) are unchanged. No new headers.
- **`PactConfig`**: additive only. `signer` accepts a new variant; `requestSigningSecretKey` widens its type union. Existing Solana-only callers (Keypair + bs58 secret) compile unchanged.
- **CLI**: unchanged in this PR (still v1). The proxy compat window covers it.

---

## 10. Out of scope

- CLI EVM signing (tracked in `[[project_cli_evm_wallet_init]]`).
- Settler / indexer changes — they consume on-chain settlement events, not request signatures.
- Wallet-standard / WalletConnect / Metamask integrations — agents sign in code, not in a browser wallet.
- Dashboard UI showing EVM agents.
- EIP-712 typed-data signing.
- A new signature algorithm discriminator header.
- Replacing the in-memory replay cache with Redis (filed separately; same-process scope is fine for the single-replica Cloud Run proxy today, called out at `verify-signature.ts:53`).
- Rotating `x-pact-network` to a closed-enum validation in the SDK.

---

## Open design forks resolved

| Question | Resolved by |
| --- | --- |
| Match canonical bytes vs. fork? | Match, bump to `v2` with `NETWORK` field — §2. |
| EIP-191 vs EIP-712? | EIP-191 — §3. |
| 0x address vs bs58-wrap vs dual header? | Plain 0x checksum — §4. |
| Algo header vs format inference? | Format inference (already in proxy) — §5. |
| One-release v1 acceptance? | Yes, single-release compat window — §9. |

If any of the recommendations is rejected in review, the rest of the spec is unaffected so long as the SDK and proxy stay byte-identical on the payload they each construct.
