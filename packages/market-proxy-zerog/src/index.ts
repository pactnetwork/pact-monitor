/**
 * Pact-0G market proxy entrypoint.
 *
 * Hono routes:
 *   ALL /v1/:slug/*        — insured proxy to a 0G Compute provider
 *   GET /v1/agents/:addr   — read-only agent snapshot
 *   GET /health
 *
 * Reuse from @pact-network/market-proxy:
 *   - Hono routing skeleton
 *   - wrapFetch integration
 *   - endpoint slug routing logic
 *
 * Rewrite:
 *   - agent auth: ed25519 → ECDSA (verifyMessage)
 *   - balance check: SPL Token ATA → ERC20 allowance + balance
 *   - upstream call: static URL → ZerogComputeClient.callInference
 *
 * STATUS: skeleton. Week 2 work.
 */

console.log('market-proxy-zerog: not yet implemented — see packages/market-proxy/ for the reference');
process.exit(0);
