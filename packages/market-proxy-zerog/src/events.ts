// Settlement event publishing — chain-agnostic, ported from the Solana
// market-proxy. The proxy publishes a wrap `SettlementEvent` (the SAME shape
// settler-evm consumes; `agentPubkey` carries the 0x EVM address) to Cloud
// Pub/Sub for every insured call. `PubSubEventSink` (from @pact-network/wrap)
// swallows publish errors so the wrapped-fetch hot path never blocks.

import { createRequire } from 'node:module';
import {
  PubSubEventSink,
  type EventSink,
  type PubSubTopicPublisher,
} from '@pact-network/wrap';

// ESM has no bare `require`; synthesise one so the GCP client stays lazily
// loaded (it pulls grpc, which we don't want in the test path).
const require = createRequire(import.meta.url);

/** Wrap a pre-built topic publisher. The testable seam — no GCP needed. */
export function pubSubSinkFromTopic(topic: PubSubTopicPublisher): EventSink {
  return new PubSubEventSink({ topic });
}

/**
 * Build a PubSubEventSink. Imports `@google-cloud/pubsub` lazily so unit
 * tests can exercise `pubSubSinkFromTopic` without pulling in the GCP SDK.
 */
export function createPubSubSink(project: string, topicName: string): EventSink {
  const { PubSub } =
    require('@google-cloud/pubsub') as typeof import('@google-cloud/pubsub');
  const client = new PubSub({ projectId: project });
  const topic = client.topic(topicName);
  return pubSubSinkFromTopic(topic as unknown as PubSubTopicPublisher);
}
