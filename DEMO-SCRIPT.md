# Demo video script — Pact Network on Arbitrum (≈90 seconds)

Goal: show one real insured API call fail and get refunded on-chain, live. ESL-plain voiceover. Record screen + voice.

## Before you record (open these tabs)
1. Dashboard: https://market-dashboard-production-0489.up.railway.app
2. A terminal (for the live call)
3. Arbiscan tx (the first settle, as backup): https://sepolia.arbiscan.io/tx/0x4754ee52f0fd04bb3383897a4ae772f3a6dae1c331ad167565e6499db310b6b1
4. Verified contract: https://sepolia.arbiscan.io/address/0x79A91E5965094266d221Aaef8E66d6C364819edb#code

The stack is live and funded. A fresh call will settle on-chain in about 5 seconds.

## The live command (run on camera in step 2)
```bash
curl -s "https://market-proxy-production-29f9.up.railway.app/v1/dummy/quote/AAPL?fail=1&pact_wallet=0xaeC07b96123715D434C212B41AFdd73f4DDA29c4" -H "x-pact-network: arbitrum-sepolia" -i | grep -i "x-pact"
```
It returns HTTP 503 plus these headers: `x-pact-premium: 1000`, `x-pact-refund: 11000`, `x-pact-outcome: server_error`, `x-pact-settlement-pending: 1`.

## Shot list

**0:00–0:15 — What it is.**
Show the dashboard. Say:
"This is Pact Network on Arbitrum. It is insurance for AI agent API calls. An agent pays a small fee per call. If the call fails, the agent gets paid back on-chain. No claim form, no human."

**0:15–0:40 — Make a real failing call.**
Switch to the terminal. Run the command above. Say:
"Here an agent calls an API through Pact Network. I force the API to fail with a 503. The agent paid a premium of 1000. Pact owes it a refund of 11000."
Point at the `x-pact-refund: 11000` header.

**0:40–1:00 — The refund settles on-chain.**
Wait about 5 seconds. Refresh the dashboard. Say:
"The refund just settled on Arbitrum. Calls went from 1 to 2. Refunds paid went up. This is real on-chain money, not a mock."
Point at the updated counts.

**1:00–1:20 — On-chain proof.**
Open Arbiscan (the new tx, or the backup tx link). Say:
"Here is the transaction. You can see the USDC refund go to the agent, and the network treasury take its cut."
Point at the USDC transfers.

**1:20–1:30 — Deployed and verified.**
Open the verified contract (#code tab, green check). Say:
"All three contracts are deployed and verified on Arbitrum Sepolia. Thank you."

## Tips
- Make the terminal font large.
- If the dashboard count does not move in ~10s, refresh once more (settler batches every few seconds).
- Keep it under 2 minutes; 90 seconds is ideal.
- After recording, add the video link to the HackQuest project page and to SUBMISSION.md.

## Fallback if you cannot record live
Use the backup Arbiscan tx (the first settle) + dashboard screenshots, narrated with the same script. The orchestrator can also capture annotated screenshots via the browser tool on request.
