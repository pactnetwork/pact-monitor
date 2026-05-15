// Settlement event publishing.
//
// The proxy publishes a `SettlementEvent` (camelCase, bigint-as-string) for
// every wrapped call. Two backends are supported:
//
//   - "pubsub" (default, mainnet)      — Cloud Pub/Sub via @google-cloud/pubsub
//   - "redis-streams" (devnet/Railway) — Redis stream XADD via ioredis
//
// Both swallow errors so the wrapped fetch hot path never blocks on event
// delivery. The backend is selected by the QUEUE_BACKEND env var; when
// unset (mainnet's current state), behavior is byte-identical to the
// pre-adapter code path — PubSubEventSink with no Redis client loaded.

import { createRequire } from "node:module";
import {
  PubSubEventSink,
  RedisStreamsEventSink,
  type EventSink,
  type PubSubTopicPublisher,
  type RedisStreamPublisher,
  type SettlementEvent,
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

/**
 * Build a RedisStreamsEventSink. Imports `ioredis` lazily so mainnet (where
 * QUEUE_BACKEND is unset) never loads the Redis client at all.
 */
export function createRedisStreamsSink(
  redisUrl: string,
  streamName: string,
): EventSink {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { default: IORedis } = require("ioredis") as typeof import("ioredis");
  const client = new IORedis(redisUrl);
  const publisher: RedisStreamPublisher = {
    async publish(stream: string, event: SettlementEvent): Promise<string> {
      // ioredis xadd: key, id, ...field/value pairs. Use "*" so Redis
      // generates the ID. Store the entire event as one JSON-encoded field
      // — settler decodes by name.
      const id = await client.xadd(stream, "*", "event", JSON.stringify(event));
      // ioredis types xadd as returning `string | null`; in practice "*"
      // always yields a string. Defensive fallback for the null branch.
      return id ?? "";
    },
  };
  return new RedisStreamsEventSink({ publisher, stream: streamName });
}

/**
 * Build the active EventSink based on QUEUE_BACKEND.
 *
 * - QUEUE_BACKEND unset or "pubsub" → PubSubEventSink (mainnet default,
 *   byte-identical to pre-adapter behavior).
 * - QUEUE_BACKEND="redis-streams"   → RedisStreamsEventSink (devnet).
 *
 * Throws on unrecognised backend values to fail fast at boot.
 */
export interface CreateEventSinkOptions {
  /** Backend selector. Defaults to "pubsub" when not provided. */
  backend?: string;
  /** Pub/Sub project ID (required when backend is "pubsub"). */
  pubsubProject?: string;
  /** Pub/Sub topic name (required when backend is "pubsub"). */
  pubsubTopic?: string;
  /** Redis URL (required when backend is "redis-streams"). */
  redisUrl?: string;
  /** Redis stream name (required when backend is "redis-streams"). */
  redisStream?: string;
}

export function createEventSink(opts: CreateEventSinkOptions): EventSink {
  const backend = opts.backend ?? "pubsub";
  if (backend === "redis-streams") {
    if (!opts.redisUrl || !opts.redisStream) {
      throw new Error(
        "createEventSink: QUEUE_BACKEND=redis-streams requires REDIS_URL and REDIS_STREAM",
      );
    }
    return createRedisStreamsSink(opts.redisUrl, opts.redisStream);
  }
  if (backend === "pubsub") {
    if (!opts.pubsubProject || !opts.pubsubTopic) {
      throw new Error(
        "createEventSink: QUEUE_BACKEND=pubsub requires PUBSUB_PROJECT and PUBSUB_TOPIC",
      );
    }
    return createPubSubSink(opts.pubsubProject, opts.pubsubTopic);
  }
  throw new Error(`createEventSink: unknown QUEUE_BACKEND="${backend}"`);
}
