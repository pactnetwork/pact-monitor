# @pact-network/pact-zerog-dashboard

Next.js 15 dashboard for Pact-0G. Tells the demo story end-to-end in 3 minutes.

## Status

🚧 **Skeleton.** Week 3 work.

## Panels (locked at Day 17)

1. **Pool live** — per-endpoint balance, lifetime premiums + refunds + fees. Polls indexer-evm `/api/endpoints`.
2. **Recent calls** — last 20 settled calls. Each row links to `chainscan.0g.ai/tx/<txHash>` and to the 0G Storage evidence blob (via indexer hydration, not direct SDK).
3. **Wallet** — wagmi connect, mUSDC balance + allowance, "Top up pool" button (calls `PactCore.topUpCoveragePool`).
4. **Demo runner** — button that fires N inference calls through `market-proxy-zerog`. Shows banner overlays per 0G component (Chain / Storage / INFT) so judges can't miss them.

## Notes

- `@0gfoundation/0g-storage-ts-sdk` is Node-only (uses `fs.appendFileSync`) and **must never** reach the client bundle. The dashboard reads evidence via `indexer-evm`'s REST API. Enforced via `next.config.mjs#serverExternalPackages`.
- Wallet connect: wagmi + injected (MetaMask) only for hackathon. WalletConnect deferred.
- No SSR for tx-signing UI — wallet panel is client-side only.
