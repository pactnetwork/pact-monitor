// Settlement event publishing.
//
// The proxy publishes a `SettlementEvent` (camelCase, bigint-as-string) to
// Cloud Pub/Sub for every wrapped call. We delegate the actual publish to
// `PubSubEventSink` from @pact-network/wrap, which wraps the topic
// publisher and swallows errors so the wrapped fetch hot path never blocks
// on event delivery.

import { createRequire } from "node:module";
import {
  PubSubEventSink,
  type EventSink,
  type PubSubTopicPublisher,
} from "@pact-network/wrap";

// market-proxy is `"type": "module"` (ESM). The bare `require` global isn't
// defined in ESM modules, so we synthesise one via createRequire to keep the
// existing lazy-load pattern below working without a top-level
// `import("@google-cloud/pubsub")` (which would force grpc into the test path).
const require = createRequire(import.meta.url);

/**
 * Build a PubSubEventSink. Imports `@google-cloud/pubsub` lazily so unit
 * tests can stub the topic publisher without pulling in the GCP SDK.
 */
export function createPubSubSink(project: string, topicName: string): EventSink {
  // Lazy require — the GCP client pulls grpc transitively, which we'd
  // rather not load in test contexts.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PubSub } = require("@google-cloud/pubsub") as typeof import("@google-cloud/pubsub");
  const client = new PubSub({ projectId: project });
  const topic = client.topic(topicName);
  return new PubSubEventSink({
    topic: topic as unknown as PubSubTopicPublisher,
  });
}
