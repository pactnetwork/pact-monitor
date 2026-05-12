// Settlement event publishing for pay.sh-covered calls.
//
// The facilitator publishes a `SettlementEvent` onto the SAME Cloud Pub/Sub
// topic the market-proxy publishes to (env PUBSUB_TOPIC). The existing settler
// (`packages/settler/`) consumes that topic and drives `settle_batch` on-chain
// against the relevant CoveragePool — for pay.sh-covered calls that pool is
// the synthetic-slug `pay-default` pool (env PAY_DEFAULT_SLUG).
//
// Shape: a superset of @pact-network/wrap's `SettlementEvent` (camelCase,
// bigint-as-decimal-string) plus three pay.sh-specific fields:
//   - source:   always "pay.sh" — lets the indexer tag the Call row
//   - verified: did the facilitator verify the payment on-chain? false when
//               the receipt arrived without `payee` + `paymentSignature`
//               (pay 0.16.0 doesn't expose them — see coverage.ts)
//   - payee:    the merchant pubkey the agent paid (bs58), or null when the
//               receipt didn't carry it (unverified mode)
//   - resource: the URL/resource that was paid for
//   - coverageId: the facilitator's coverage record id (== the Pub/Sub
//                 callId). Deterministic from the payment tx sig when verified;
//                 a fresh random UUIDv4-shaped id when unverified.
//
// The settler's batcher only reads `callId / agentPubkey / endpointSlug /
// premiumLamports / refundLamports / latencyMs / outcome / ts` — the extra
// fields ride along untouched. The settler's indexer-pusher additionally
// forwards `source` to the indexer (one-line patch shipped in this PR).
//
// We do NOT depend on @pact-network/wrap's `PubSubEventSink` here because that
// is typed to the bare `SettlementEvent`; we publish the superset directly via
// a thin wrapper. `@google-cloud/pubsub` is lazy-required so unit tests can
// stub the publisher without pulling in the GCP/grpc tree.

import { createRequire } from "node:module";
import type { Outcome } from "@pact-network/wrap";

const require = createRequire(import.meta.url);

export interface PaySettlementEvent {
  /** 36-char UUID-shaped id, deterministic from the payment tx signature. */
  callId: string;
  /** bs58 agent pubkey. */
  agentPubkey: string;
  /** Synthetic coverage-pool slug (MVP: always `pay-default`). */
  endpointSlug: string;
  /** bigint as decimal string, e.g. "1000". */
  premiumLamports: string;
  /** bigint as decimal string. 0 unless the verdict outcome is a covered breach. */
  refundLamports: string;
  latencyMs: number;
  outcome: Outcome;
  /** ISO-8601 timestamp of when the pay.sh call completed. */
  ts: string;
  // ---- pay.sh-specific extensions ----
  /** Always "pay.sh" — distinguishes this from gateway-path events. */
  source: "pay.sh";
  /**
   * True if the facilitator verified the payment on-chain (the receipt carried
   * both `payee` and `paymentSignature`). False for "unverified" / degrade-mode
   * registrations — accepted on the agent's signed word, bounded by the
   * on-chain hourly exposure cap. The settler/indexer forward this untouched.
   */
  verified: boolean;
  /** Merchant pubkey the agent paid (bs58), or null when not supplied (unverified mode). */
  payee: string | null;
  /** The URL/resource that was paid for. */
  resource: string;
  /** Facilitator coverage record id (same value as callId). */
  coverageId: string;
}

export interface EventPublisher {
  publish(event: PaySettlementEvent): Promise<void>;
}

/** In-memory publisher — for tests. */
export class MemoryEventPublisher implements EventPublisher {
  public readonly events: PaySettlementEvent[] = [];
  async publish(event: PaySettlementEvent): Promise<void> {
    this.events.push(event);
  }
  reset(): void {
    this.events.length = 0;
  }
}

interface PubSubTopicLike {
  publishMessage(args: { json: unknown }): Promise<string>;
}

/**
 * Pub/Sub-backed publisher. Errors are swallowed (logged) so a Pub/Sub blip
 * never fails the register call — the call already settled with the merchant
 * directly; the worst case is the on-chain settlement is delayed and the CLI
 * just can't print a final tx signature yet (the agent can retry register).
 */
export class PubSubEventPublisher implements EventPublisher {
  private readonly topic: PubSubTopicLike;
  private readonly onError: (err: unknown) => void;

  constructor(opts: { topic: PubSubTopicLike; onError?: (err: unknown) => void }) {
    this.topic = opts.topic;
    this.onError =
      opts.onError ??
      ((err) => {
        // eslint-disable-next-line no-console
        console.warn("[facilitator] Pub/Sub publish failed", err);
      });
  }

  async publish(event: PaySettlementEvent): Promise<void> {
    try {
      await this.topic.publishMessage({ json: event });
    } catch (err) {
      this.onError(err);
    }
  }
}

/**
 * Build a Pub/Sub-backed EventPublisher. Lazy-requires `@google-cloud/pubsub`
 * (it pulls grpc transitively, which we'd rather not load in test contexts).
 */
export function createPubSubPublisher(
  project: string,
  topicName: string,
): EventPublisher {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PubSub } = require("@google-cloud/pubsub") as typeof import("@google-cloud/pubsub");
  const client = new PubSub({ projectId: project });
  const topic = client.topic(topicName);
  return new PubSubEventPublisher({ topic: topic as unknown as PubSubTopicLike });
}
