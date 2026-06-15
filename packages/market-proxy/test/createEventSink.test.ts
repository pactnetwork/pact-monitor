// createEventSink — backend dispatch + validation.
//
// We test the error/validation paths exhaustively. The happy paths
// (returning real PubSubEventSink / RedisStreamsEventSink instances) are
// covered indirectly by:
//   - events.test.ts (PubSubEventSink behavior via mocked topic)
//   - wrap's __tests__/eventSink.test.ts (both sinks via mocked publishers)
// Exercising the actual factory output would trigger lazy require of
// @google-cloud/pubsub or ioredis with live constructors, which is a
// runtime concern not a unit-test concern.

import { describe, test, expect } from "vitest";
import { createEventSink } from "../src/lib/events";

describe("createEventSink — validation", () => {
  test("rejects unknown backend value", () => {
    expect(() =>
      createEventSink({
        backend: "kafka",
        pubsubProject: "p",
        pubsubTopic: "t",
      }),
    ).toThrow(/unknown QUEUE_BACKEND="kafka"/);
  });

  test("defaults to pubsub when backend is undefined", () => {
    // No pubsub fields provided → throws "PUBSUB_PROJECT and PUBSUB_TOPIC".
    // This confirms the default branch is "pubsub", not a different default.
    expect(() => createEventSink({})).toThrow(/QUEUE_BACKEND=pubsub/);
  });

  test("pubsub backend requires PUBSUB_PROJECT", () => {
    expect(() =>
      createEventSink({
        backend: "pubsub",
        pubsubTopic: "t",
      }),
    ).toThrow(/PUBSUB_PROJECT and PUBSUB_TOPIC/);
  });

  test("pubsub backend requires PUBSUB_TOPIC", () => {
    expect(() =>
      createEventSink({
        backend: "pubsub",
        pubsubProject: "p",
      }),
    ).toThrow(/PUBSUB_PROJECT and PUBSUB_TOPIC/);
  });

  test("redis-streams backend requires REDIS_URL", () => {
    expect(() =>
      createEventSink({
        backend: "redis-streams",
        redisStream: "pact-settle-events",
      }),
    ).toThrow(/REDIS_URL and REDIS_STREAM/);
  });

  test("redis-streams backend requires REDIS_STREAM", () => {
    expect(() =>
      createEventSink({
        backend: "redis-streams",
        redisUrl: "redis://localhost:6379",
      }),
    ).toThrow(/REDIS_URL and REDIS_STREAM/);
  });
});
