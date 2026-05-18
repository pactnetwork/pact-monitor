#!/usr/bin/env node
/**
 * goldrush-verify-cli — manual exercise of the verification gate.
 *
 * Usage:
 *   GOLDRUSH_API_KEY=... pnpm --filter @pact-network/backend verify:goldrush \
 *     --tx <signature> \
 *     --agent <agentPubkey> \
 *     [--recipient <recipientPubkey>] \
 *     [--amount <uiAmount>] \
 *     [--at <iso8601>]
 *
 * Prints:
 *   1. The "before" state: what claim adjudication used to see at this call
 *      site — i.e. nothing, just trust-the-agent.
 *   2. The "after" state: the VerificationDetail returned by the verifier,
 *      with confidence + reason + latency + cache_hit.
 *
 * Intended for the Step 4 before/after capture. Rick (or anyone) can paste
 * a real settled tx sig from Syra/Xona/Helius and see the gate fire end-to-
 * end without standing up the Fastify server or a Postgres DB.
 *
 * Exit code is 0 regardless of result — this is a probe, not a CI gate.
 */
import {
  GoldRushVerifier,
  createDefaultClient,
  type VerificationDetail,
} from "../services/goldrush-verifier.js";

interface Args {
  tx: string | null;
  agent: string | null;
  recipient: string | null;
  amount: number | null;
  at: Date;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    tx: null,
    agent: null,
    recipient: null,
    amount: null,
    at: new Date(),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tx") out.tx = argv[++i] ?? null;
    else if (a === "--agent") out.agent = argv[++i] ?? null;
    else if (a === "--recipient") out.recipient = argv[++i] ?? null;
    else if (a === "--amount") out.amount = Number(argv[++i]);
    else if (a === "--at") {
      const v = argv[++i] ?? null;
      if (v) out.at = new Date(v);
    } else if (a === "--help" || a === "-h") {
      // eslint-disable-next-line no-console
      console.log(
        "Usage: pnpm --filter @pact-network/backend verify:goldrush --tx <sig> --agent <pubkey> [--recipient <pubkey>] [--amount <baseUnits>] [--at <iso8601>]",
      );
      process.exit(0);
    }
  }
  return out;
}

function fmt(d: VerificationDetail): string {
  const parts = [
    `result=${d.result}`,
    `confidence=${d.confidence}`,
    `latency_ms=${d.latencyMs ?? "n/a"}`,
    `cache_hit=${d.cacheHit}`,
    `reason="${d.reason}"`,
  ];
  return parts.join(" ");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.tx || !args.agent) {
    // eslint-disable-next-line no-console
    console.error("--tx and --agent are required. Run with --help for usage.");
    process.exit(2);
  }

  const client = createDefaultClient();
  if (!client) {
    // eslint-disable-next-line no-console
    console.error("GOLDRUSH_API_KEY not set — verifier would no-op as 'skipped'.");
    // We still run, to demonstrate the no-op path.
  }

  const verifier = new GoldRushVerifier({ client });

  // eslint-disable-next-line no-console
  console.log("=== BEFORE (existing claim adjudication) ===");
  // eslint-disable-next-line no-console
  console.log(
    "  Pact's claim adjudication trusts the agent's classification + on-chain caps.",
  );
  // eslint-disable-next-line no-console
  console.log(
    "  No external check that the upstream x402 settlement actually happened.",
  );
  // eslint-disable-next-line no-console
  console.log(`  Inputs known:`);
  // eslint-disable-next-line no-console
  console.log(`    agent_pubkey=${args.agent}`);
  // eslint-disable-next-line no-console
  console.log(`    recipient=${args.recipient ?? "(unknown)"}`);
  // eslint-disable-next-line no-console
  console.log(`    expected_amount=${args.amount ?? "(unknown)"}`);
  // eslint-disable-next-line no-console
  console.log(`    call_at=${args.at.toISOString()}`);

  const detail = await verifier.verify({
    txSignature: args.tx,
    agentPubkey: args.agent,
    recipientAddress: args.recipient,
    expectedAmount: args.amount,
    callTimestamp: args.at,
  });

  // eslint-disable-next-line no-console
  console.log("=== AFTER (GoldRush verification gate) ===");
  // eslint-disable-next-line no-console
  console.log(`  ${fmt(detail)}`);

  // eslint-disable-next-line no-console
  console.log("=== INTERPRETATION ===");
  switch (detail.result) {
    case "match":
      // eslint-disable-next-line no-console
      console.log("  GoldRush confirms the upstream tx happened with matching parameters.");
      // eslint-disable-next-line no-console
      console.log("  Claim adjudication proceeds with elevated confidence.");
      break;
    case "mismatch":
      // eslint-disable-next-line no-console
      console.log("  GoldRush has no matching tx (or sender/recipient/amount differ).");
      // eslint-disable-next-line no-console
      console.log("  Adjudication still proceeds (golden rule), but the discrepancy");
      // eslint-disable-next-line no-console
      console.log("  is logged + counted for operator review.");
      break;
    case "stale":
      // eslint-disable-next-line no-console
      console.log("  GoldRush returned a tx but its blockTime drifts too far from the");
      // eslint-disable-next-line no-console
      console.log("  call timestamp — likely indexing lag. Adjudication proceeds.");
      break;
    case "unavailable":
      // eslint-disable-next-line no-console
      console.log("  GoldRush call failed (timeout, 5xx, 429, or rate-limited).");
      // eslint-disable-next-line no-console
      console.log("  Adjudication falls through to existing trust-the-agent + on-chain caps.");
      break;
    case "skipped":
      // eslint-disable-next-line no-console
      console.log("  Verifier skipped (no tx sig recorded, or no API key configured).");
      // eslint-disable-next-line no-console
      console.log("  Adjudication runs exactly as it did pre-integration.");
      break;
  }

  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Verifier CLI crashed unexpectedly:", err);
  process.exit(1);
});
