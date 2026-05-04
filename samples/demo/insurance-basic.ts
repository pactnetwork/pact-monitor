// Pact Insurance — Minimal Read-Only Integration
//
// Demonstrates the SDK's read paths (estimateCoverage, getPolicy) against
// a live devnet pool. SAFE to run from a clean clone — does not send a
// transaction, does not need a funded keypair, does not need TEST-USDC.
//
// What this prints:
//   - The current insurance rate (basis points) and per-call premium for a
//     hypothetical 10_000-lamport ($0.01) call.
//   - Whether the configured agent already has an active policy on the
//     target pool, and if so its delegated allowance + claims received.
//
// What this does NOT do:
//   - enable_insurance (creates a policy on-chain). For the full
//     happy-path demo — fund a keypair, drip USDC, enable insurance, run
//     monitor.fetch(), file a claim — see `external-agent.ts`.
//   - top_up_delegation, submit_claim, or any other write.
//
// Run (from samples/demo, after `pnpm install` at the repo root):
//   pnpm run insurance-basic [hostname]
//
// The `pnpm run` form chains a `build:deps` step that compiles
// @pact-network/monitor and @pact-network/insurance to their dist/
// directories first. Invoking `pnpm tsx insurance-basic.ts ...`
// directly will fail with ERR_MODULE_NOT_FOUND on a fresh clone until
// those packages are built.
//
// Env (all optional):
//   SOLANA_RPC_URL              default: https://api.devnet.solana.com
//   SOLANA_PROGRAM_ID           default: pinocchio program ID baked in SDK
//   PACT_AGENT_KEYPAIR_PATH     default: ~/.config/solana/id.json
//                               If the file doesn't exist, the demo
//                               generates a transient keypair just to
//                               exercise getPolicy() — the read still works.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Keypair } from "@solana/web3.js";
import { PactInsurance, generated } from "@pact-network/insurance";

const HOSTNAME = process.argv[2] || "api.coingecko.com";
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID =
  process.env.SOLANA_PROGRAM_ID || generated.PACT_INSURANCE_PROGRAM_ADDRESS;
const KEYPAIR_PATH =
  process.env.PACT_AGENT_KEYPAIR_PATH ||
  path.join(os.homedir(), ".config/solana/id.json");

function loadOrEphemeralKeypair(p: string): { kp: Keypair; ephemeral: boolean } {
  if (fs.existsSync(p)) {
    return {
      kp: Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf-8"))),
      ),
      ephemeral: false,
    };
  }
  // No keypair on disk — generate a throwaway. Read paths still resolve
  // against this pubkey (getPolicy will return null, which is the correct
  // answer for a never-before-seen pubkey). This makes the demo runnable
  // from a clean clone with zero pre-reqs.
  return { kp: Keypair.generate(), ephemeral: true };
}

const { kp: agent, ephemeral } = loadOrEphemeralKeypair(KEYPAIR_PATH);

console.log(`[cfg] hostname:    ${HOSTNAME}`);
console.log(`[cfg] rpc:         ${RPC_URL}`);
console.log(`[cfg] program:     ${PROGRAM_ID}`);
console.log(
  `[cfg] agent:       ${agent.publicKey.toBase58()}` +
    (ephemeral ? "  (ephemeral — no keypair file at " + KEYPAIR_PATH + ")" : ""),
);
console.log("");

const insurance = new PactInsurance({ rpcUrl: RPC_URL, programId: PROGRAM_ID }, agent);

// ---- Read 1: per-call premium estimate. No agent state required, just the
//             pool's current insurance rate. Throws if the pool doesn't
//             exist (e.g. a typo'd hostname).
try {
  const estimate = await insurance.estimateCoverage(HOSTNAME, 10_000n);
  console.log(`[estimate] rate:           ${estimate.rateBps} bps`);
  console.log(`[estimate] per-call premium: ${estimate.perCallPremium} lamports (for a 10_000-lamport call)`);
  console.log(`[estimate] estimated calls:  ${estimate.estimatedCalls}`);
} catch (err) {
  console.error(`[estimate] FAILED: ${(err as Error).message}`);
  console.error(
    `           No pool exists for "${HOSTNAME}". Try one of:\n` +
      `             api.coingecko.com, api.dexscreener.com, api.helius.xyz,\n` +
      `             quote-api.jup.ag, solana-mainnet.quiknode.pro`,
  );
  process.exit(1);
}
console.log("");

// ---- Read 2: policy state for this agent. Returns null if the agent has
//             never enabled insurance on this pool (the common case for a
//             cold clone — see external-agent.ts to enable one).
const policy = await insurance.getPolicy(HOSTNAME);
if (policy) {
  console.log(`[policy] active:           ${policy.active}`);
  console.log(`[policy] agent_id:         ${policy.agentId}`);
  console.log(`[policy] delegated:        ${policy.delegatedAmount} lamports`);
  console.log(`[policy] premiums_paid:    ${policy.totalPremiumsPaid}`);
  console.log(`[policy] claims_received:  ${policy.totalClaimsReceived}`);
  console.log(`[policy] calls_covered:    ${policy.callsCovered}`);
  console.log(`[policy] expires_at:       ${policy.expiresAt}`);
} else {
  console.log(`[policy] none — this agent has no policy on "${HOSTNAME}".`);
  console.log("");
  console.log("To enable insurance and run the full happy-path demo:");
  console.log(`  pnpm --filter @pact-network/sample-demo run external-agent ${HOSTNAME}`);
  console.log("");
  console.log(
    "external-agent.ts handles the full lifecycle: fund SOL + USDC via the",
  );
  console.log(
    "public faucet, enable_insurance, run monitor.fetch() calls, force a",
  );
  console.log("claimable failure, and verify the on-chain refund.");
}
