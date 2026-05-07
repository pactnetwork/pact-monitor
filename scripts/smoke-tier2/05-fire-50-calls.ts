/**
 * 05-fire-50-calls.ts — generate 50 wrap-style classified events and publish
 * them to the Pub/Sub emulator on topic `pact-settle-events`.
 *
 * Distribution (per task spec):
 *   35× ok               (70%)  → premium = endpoint.flat_premium_lamports
 *    5× latency_breach   (10%)  → premium = flat_premium, refund = imputed_cost
 *    5× server_error     (10%)  → premium = flat_premium, refund = imputed_cost
 *    3× client_error     ( 6%)  → premium = 0           (settler MUST drop these — FIX-1)
 *    2× network_error    ( 4%)  → premium = 0           (also non-billable)
 *
 * Calls are spread evenly across the 5 endpoints (10 calls each).
 *
 * Settleable events the settler MUST submit on-chain: 35 ok + 5 latency_breach
 * + 5 server_error = 45 events. With MAX_BATCH_SIZE = 3 and an ack deadline
 * of 60s, the settler should fire ⌈45/3⌉ = 15 batches (or 14 if a partial
 * tail forms). Each batch lands one settle_batch tx.
 */
import { PubSub } from "@google-cloud/pubsub";
import { randomBytes } from "node:crypto";
import {
  ENDPOINTS,
  NUM_AGENTS,
  PUBSUB_PROJECT,
  PUBSUB_TOPIC,
} from "./lib/paths";
import { loadState, patchState } from "./lib/state";

const TARGET_DIST = {
  ok: 35,
  latency_breach: 5,
  server_error: 5,
  client_error: 3,
  network_error: 2,
} as const;

type Outcome = keyof typeof TARGET_DIST;

interface FireEvent {
  callId: string;
  agentPubkey: string;
  endpointSlug: string;
  premiumLamports: string;
  refundLamports: string;
  latencyMs: number;
  outcome: Outcome;
  ts: string;
}

function randomCallId(): string {
  const b = randomBytes(16);
  // Format as 32-char hex (no dashes — settler accepts both).
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function main() {
  process.env.PUBSUB_EMULATOR_HOST ??= "127.0.0.1:8085";
  process.env.PUBSUB_PROJECT_ID ??= PUBSUB_PROJECT;

  const state = loadState();
  if (!state.endpoints || !state.agents) {
    throw new Error("missing endpoints / agents in state — run 02 + 03 first");
  }

  // Build the 50-event sequence.
  const events: FireEvent[] = [];
  const outcomes: Outcome[] = [];
  for (const [outcome, count] of Object.entries(TARGET_DIST) as [Outcome, number][]) {
    for (let i = 0; i < count; i++) outcomes.push(outcome);
  }
  // Sanity
  if (outcomes.length !== 50) throw new Error(`got ${outcomes.length} outcomes, expected 50`);

  // Fisher-Yates shuffle for unbiased mixing.
  for (let i = outcomes.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [outcomes[i], outcomes[j]] = [outcomes[j], outcomes[i]];
  }

  const nowMs = Date.now();
  for (let i = 0; i < outcomes.length; i++) {
    const outcome = outcomes[i];
    const ep = ENDPOINTS[i % ENDPOINTS.length];
    const agent = state.agents[i % NUM_AGENTS];
    let premium: bigint = ep.flatPremium;
    let refund: bigint = 0n;
    let latencyMs = ep.sla / 2;

    if (outcome === "latency_breach") {
      latencyMs = ep.sla * 2;
      refund = 10_000n; // = imputedCost from 02
    } else if (outcome === "server_error") {
      latencyMs = ep.sla / 3;
      refund = 10_000n;
    } else if (outcome === "client_error" || outcome === "network_error") {
      premium = 0n;
      refund = 0n;
      latencyMs = outcome === "client_error" ? 50 : 0;
    }

    events.push({
      callId: randomCallId(),
      agentPubkey: agent.pubkey,
      endpointSlug: ep.slug,
      premiumLamports: premium.toString(),
      refundLamports: refund.toString(),
      latencyMs,
      outcome,
      ts: new Date(nowMs - i * 25).toISOString(),
    });
  }

  // Publish to emulator
  const pubsub = new PubSub({ projectId: PUBSUB_PROJECT });
  const topic = pubsub.topic(PUBSUB_TOPIC);

  // Pace publishes so the settler's MAX_BATCH_SIZE=3 batcher fills serially
  // rather than firing many concurrent settle_batch txs (which can cause
  // Postgres deadlocks in the indexer's per-Agent upserts — B12 finding).
  // Tunable via PACE_MS env; default 250ms => ~12.5s spread across 50 events.
  const paceMs = Number(process.env.PACE_MS ?? "250");
  let counts = { ok: 0, latency_breach: 0, server_error: 0, client_error: 0, network_error: 0 };
  for (const ev of events) {
    counts[ev.outcome]++;
    const data = Buffer.from(JSON.stringify(ev));
    await topic.publishMessage({ data });
    if (paceMs > 0) await new Promise((r) => setTimeout(r, paceMs));
  }

  console.log("Published 50 events");
  console.log(JSON.stringify(counts, null, 2));

  patchState({ totalEventsFired: events.length });

  // Estimate expected batch count: 45 settleable events / 3 batch size = 15
  const settleable = counts.ok + counts.latency_breach + counts.server_error;
  const expectedBatches = Math.ceil(settleable / 3);
  console.log(`Expected settleable events: ${settleable}`);
  console.log(`Expected batches: ${expectedBatches} (with MAX_BATCH_SIZE=3)`);
  console.log(`Settler must drop: ${counts.client_error + counts.network_error} zero-premium events`);

  console.log("\n== smoke-tier2/05-fire-50-calls OK ==");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
