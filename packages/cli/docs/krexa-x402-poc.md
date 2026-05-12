# `pact pay --krexa` Krexa x402 POC

Minimum proof-of-concept routing `pact pay` to a Krexa Compute Gateway
x402 flow. The default `pact pay` path (post-0.2.0) spawns the
`solana-foundation/pay` binary, which only understands x402.org canonical
headers. Krexa publishes services with a bare `PAYMENT-REQUIRED` header
(no `X-` prefix) and a `PAYMENT-SIGNATURE` retry header carrying an
on-chain USDC transfer signature, so it needs a dedicated path.

`--krexa` is a flag opt-in: when present, the pay-binary spawn and the
Pact coverage side-call are both skipped. Settlement is a per-request
on-chain USDC transfer signed by the project's Pact wallet.

This POC is **not production-ready** — see "What this POC does NOT do"
at the bottom.

## What it does

1. User runs `pact pay --krexa <curl-args>` where `<curl-args>` is a
   verbatim curl invocation against the Krexa endpoint.
2. The CLI spawns `curl -i -s <args>` and captures status, headers,
   body.
3. If the response is `HTTP 402` with a base64-encoded `PAYMENT-REQUIRED`
   header, the orchestrator:
   - Selects the first Solana requirement offered (or one matching
     `--cluster`-style preferred network).
   - Builds an SPL `TransferChecked` instruction sending USDC from the
     Pact wallet's ATA to the gateway's `payTo` ATA.
   - Signs with the project's `wallet.json` keypair (or
     `PACT_PRIVATE_KEY`).
   - Submits via `sendAndConfirmTransaction` against the configured RPC
     (default `https://api.mainnet-beta.solana.com`, override with
     `KREXA_RPC_URL`).
4. Re-invokes curl with `PAYMENT-SIGNATURE: <txSig>` injected.
5. Krexa verifies the on-chain transfer, returns the LLM completion;
   the wrapper writes the upstream body to stdout (passthrough mode) or
   wraps it in a `krexa_payment_made` envelope (`--json` mode).

## Live demo recipe

Cheapest model on Krexa is Claude Haiku 4.5 at $0.005 USDC per call.
Total cost per demo run is ~$0.005 USDC + ~0.001 SOL fee, well under
$0.01.

Prereqs (off-CLI, manual):

1. Request a Krexa invite at https://krexa.xyz.
2. `npx @krexa/cli init` then `krexa activate KREXA-XXXX-XXXX`
   (single-use, binds permanently to first wallet).
3. Fund mainnet wallet with ~$1 USDC + 0.01 SOL.
4. Note the `X-API-Key` Krexa issues for your activated agent.

Then:

```bash
pact pay --krexa \
  -X POST \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $KREXA_API_KEY" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "messages": [{"role":"user","content":"What is x402?"}],
    "ownerAddress": "<your-agent-pubkey>"
  }' \
  https://tcredit-backend.onrender.com/api/v1/solana/compute/<agent>/complete
```

Expected wire trace:

- Call 1: `HTTP 402` + `PAYMENT-REQUIRED: <base64>`
- Wrapper builds + submits USDC transfer tx (verifiable on Solscan).
- Call 2: `HTTP 200` + Anthropic completion JSON.

With `--json`, the envelope reports `status: "krexa_payment_made"` and
embeds `payment.txSignature` for chain-verification.

## Why a dedicated `--krexa` flag (not auto-detect via `pact pay`)

The 0.2.0 pivot replaced the in-house curl-runner with a thin wrapper
around the `solana-foundation/pay` binary. `pay` owns x402.org canonical
parsing, signing, and retry — but does not recognise Krexa's bare-header
flavour, so wrapping `pay` with Krexa support would require either
patching `pay` upstream or running pay-then-fallback. `--krexa` is the
surgical alternative: opt-in, self-contained, leaves the pay-binary path
unchanged.

## What this POC does NOT do

- No support for `krexa x402 verify` or `krexa x402 pay` (direct payment).
- No retry on tx failure (RPC drop, blockhash expired) — surfaces error
  and exits.
- No ATA-creation idempotent fallback. If the recipient ATA does not
  exist the tx will fail; assumes Krexa pre-creates its gateway ATA.
- No replay-protection bookkeeping client-side. Krexa enforces single-use
  signatures server-side; the wrapper does not detect double-submission.
- No Pact coverage side-call: Krexa runs without a Pact-aware gateway, so
  there is no insured pool to register against.
- `@solana/spl-token` is not pulled in — the SPL `TransferChecked`
  instruction is hand-encoded.

## Why on-chain settlement here vs Pact's allowance model

Pact Network's `pact-allowance` scheme (used by the standard `pact pay`
path via the `pay` binary) signs an off-chain authorization that the
gateway debits against a pre-approved SPL Allowance. Krexa's published
x402 services don't run a Pact-aware gateway, so they need a
self-contained on-chain proof per call. Different trust model, separate
code path.
