# Pact Network — Samples

## demo/
Hackathon demo script. Calls real Solana APIs through the SDK and syncs to backend in real-time. Run during presentations with the scorecard open.

```bash
cd samples/demo && pnpm tsx monitor.ts
```

## playground/
Browser-based monitor playground. Paste any URL, click Monitor, see the result. Open `samples/playground/index.html` in your browser.

## agent-integration/
Copy-paste examples for integrating the SDK into your agent:
- `basic.ts` — Minimal 10-line integration
- `with-schema-validation.ts` — Detect broken API responses
- `with-x402.ts` — Track USDC payment amounts
