# Agent Quickstart — Insuring AI Agent API Calls

This guide walks a developer through making their first insured API call on Pact Network's devnet. You'll get test USDC, enable a policy on a pool, call an API through the Pact SDK, and watch a claim settle on-chain when the call fails.

**Estimated time:** 10 minutes. **Cost:** zero (devnet).

---

## 1. Get TEST-USDC from the faucet

Visit the scorecard faucet at **[pactnetwork.io/scorecard/faucet](https://pactnetwork.io/scorecard/faucet)** (or `http://localhost:5175/scorecard/faucet` if you're running the stack locally).

1. Click **Connect Phantom** — make sure your wallet is on **Devnet** (Phantom → Settings → Developer Settings → Testnet Mode: on, Network: Solana Devnet).
2. Enter an amount (default 1,000) and click **Claim TEST-USDC**.
3. You should see a transaction signature and an Explorer link within ~2 seconds. Follow the link to verify the mint.

Rate limit: **1 drip per wallet per 10 minutes**, max **10,000 TEST-USDC per request**.

> **Faucet disabled?** The faucet is devnet-only. If the backend is pointed at mainnet or testnet, or `FAUCET_KEYPAIR_BASE58` is unset, the page shows a banner with the reason and the button stays disabled.

You'll also need a small amount of **devnet SOL** (for transaction rent). Run `solana airdrop 1` with a Solana CLI, or use [faucet.solana.com](https://faucet.solana.com).

---

## 2. Enable insurance on a pool

Every API provider listed on the scorecard has an on-chain **pool** keyed by hostname (e.g. `api.coingecko.com`). To insure your calls to that provider, you create a **policy** — a PDA derived from (pool, your wallet) — and pre-fund it with TEST-USDC. The protocol deducts premiums from that balance as you make calls, and pays out refunds from the pool vault when calls fail.

The easiest way to see this end-to-end is the bundled external-agent demo. It works without Phantom mint authority — anyone can run it:

```bash
cd samples/demo
pnpm install
pnpm tsx external-agent.ts api.coingecko.com 3
```

The script:
1. Loads or generates a demo agent keypair at `~/.config/solana/pact-demo-agent.json`.
2. Tops up SOL via `solana airdrop` (or skips if balance is OK).
3. Drips TEST-USDC from the public faucet at `POST /api/v1/faucet/drip` — no Phantom required.
4. Calls `enable_insurance` to create a policy on the target pool (or `top_up_delegation` if a policy already exists for this agent + hostname).
5. Runs 3 successful calls through `@pact-network/monitor`.
6. Runs 1 forced timeout (latency budget = 1ms) — classified as `timeout`, **claimable**.
7. Runs 1 forced 404 — classified as `client_error`, **NOT claimable**.
8. Prints pool deltas and Solana Explorer links.

> The full `insured-agent.ts` demo is also bundled but requires the Pact deployer's Phantom mint-authority keypair. Prefer `external-agent.ts` unless you have direct mint access.

Watch for the "submit_claim" step after the timeout call — that's the backend oracle noticing the claimable classification and filing a refund against the pool vault. The 404 call is intentionally not refunded: 4xx is an agent-side issue (wrong URL, bad auth, rate-limited), not a provider failure, so it should never trigger an insurance payout.

### Claim eligibility table

| Classification | When? | Refund |
|---|---|---|
| `success` | 2xx + valid body + within latency budget | — |
| `timeout` | 2xx but latency exceeded the agent's threshold | 100% |
| `server_error` | 5xx, network unreachable, DNS failure, connection reset | 100% |
| `schema_mismatch` | 2xx but response body fails the agent's expected shape | 75% |
| `client_error` | 4xx (404, 400, 401, 403, 429, ...) | **none** |
| `latency_sla` | latency-SLA breach surfaced by the backend later | 50% |

---

## 3. Use the SDK in your own code

```ts
import { pactMonitor } from "@pact-network/monitor";

const pact = pactMonitor({
  apiKey: process.env.PACT_API_KEY!,       // issued via the admin CLI
  backendUrl: "https://pactnetwork.io",    // Cloud Run URL in staging
  agentPubkey: myAgentKeypair.publicKey.toBase58(),
});

const res = await pact.fetch("https://api.coingecko.com/api/v3/ping", {
  expectedSchema: { type: "object", required: ["gecko_says"] },
  latencyThresholdMs: 3_000,
});
```

Every `pact.fetch` call is classified into one of `success | timeout | error | schema_mismatch` and flushed to the backend. Failures trigger on-chain claims against your active policy — the refund lands in your wallet's USDC ATA once the oracle confirms.

**How to get a `PACT_API_KEY`:** ask your admin (or yourself, if you're self-hosting) to run:

```bash
pnpm --filter @pact-network/backend run generate-key my-agent --agent-pubkey <your-pubkey>
```

Keys are hashed in the `api_keys` table — they're printed once at creation and never stored in plaintext.

---

## 4. Verify claims on the scorecard

After a failed call, open **[pactnetwork.io/scorecard/provider/<id>](https://pactnetwork.io/scorecard)** and scroll to the recent claims panel. Your claim appears within a few seconds, tagged with the trigger type (`timeout`, `error`, `schema_mismatch`, `latency_sla`).

You can also query the API directly:

```bash
curl https://pactnetwork.io/api/v1/claims?agent_pubkey=<your-pubkey>
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "Faucet disabled" banner | Backend on mainnet/unknown network, or `FAUCET_KEYPAIR_BASE58` unset | Point backend at devnet; populate env from Phantom keypair |
| `enable_insurance` fails with `InsufficientFunds` | Wallet has < `min_pool_deposit` TEST-USDC | Claim more from the faucet (max 10k/request) |
| Claim row never appears | Call wasn't tagged with `agent_pubkey` | Pass `agentPubkey` in the SDK config, not just `apiKey` |
| 429 on faucet drip | Rate limited (1/10min per wallet) | Wait for the countdown on the button |
| 410 on faucet drip | Backend detects mainnet-beta genesis hash | Check `SOLANA_RPC_URL` is actually devnet |

For the full operational runbook see `docs/PHASE3.md`. For the protocol design see `docs/superpowers/specs/2026-04-10-phase3-insurance-design.md`.
