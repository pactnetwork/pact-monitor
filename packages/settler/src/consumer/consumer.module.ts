import { Module, type FactoryProvider, type Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PubSub } from "@google-cloud/pubsub";
import { ConsumerService, QUEUE_CONSUMER } from "./consumer.service";
import { PubSubQueueConsumer } from "./pubsub-queue-consumer";
import { RedisStreamsQueueConsumer } from "./redis-streams-queue-consumer";
import type { QueueConsumer } from "./queue-consumer.interface";

// Backend selection — see plan/devnet-mirror-build §4.4–4.5.
//
// QUEUE_BACKEND defaults to "pubsub" so mainnet behavior is byte-identical:
// the PubSub provider is eagerly constructed and the consumer wraps it
// exactly as the pre-refactor module did. When QUEUE_BACKEND=redis-streams
// (devnet on Railway) the PubSub provider returns a stub (the redis branch
// of the QUEUE_CONSUMER factory ignores it) and ioredis is lazy-required
// only at that point.

// Symbolic provider for the optional Redis client. Constructed only when
// QUEUE_BACKEND === "redis-streams". When the pubsub backend is active
// this resolves to `null` and the QUEUE_CONSUMER factory never touches it.
export const REDIS_CLIENT = Symbol("REDIS_CLIENT");

const pubsubProvider: FactoryProvider<PubSub> = {
  provide: PubSub,
  useFactory: (): PubSub => new PubSub(),
};

const redisClientProvider: FactoryProvider<unknown> = {
  provide: REDIS_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): unknown => {
    const backend = config.get<string>("QUEUE_BACKEND") ?? "pubsub";
    if (backend !== "redis-streams") return null;
    // Lazy-require ioredis only when the redis-streams backend is selected
    // so mainnet's pubsub boot path never loads the Redis client.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const IORedis = require("ioredis").default ?? require("ioredis");
    return new IORedis(config.getOrThrow<string>("REDIS_URL"));
  },
};

const queueConsumerProvider: FactoryProvider<QueueConsumer> = {
  provide: QUEUE_CONSUMER,
  inject: [ConfigService, PubSub, REDIS_CLIENT],
  useFactory: (
    config: ConfigService,
    pubsub: PubSub,
    redis: unknown,
  ): QueueConsumer => {
    const backend = config.get<string>("QUEUE_BACKEND") ?? "pubsub";
    if (backend === "pubsub") {
      return new PubSubQueueConsumer(pubsub, {
        projectId: config.getOrThrow<string>("PUBSUB_PROJECT"),
        subscriptionName: config.getOrThrow<string>("PUBSUB_SUBSCRIPTION"),
      });
    }
    if (backend === "redis-streams") {
      if (!redis) {
        throw new Error(
          "REDIS_CLIENT provider returned null despite QUEUE_BACKEND=redis-streams",
        );
      }
      return new RedisStreamsQueueConsumer(
        redis as import("ioredis").Redis,
        {
          stream: config.getOrThrow<string>("REDIS_STREAM"),
          group: config.get<string>("REDIS_CONSUMER_GROUP") ?? "settler",
        },
      );
    }
    throw new Error(`Unknown QUEUE_BACKEND="${backend}"`);
  },
};

const providers: Provider[] = [
  pubsubProvider,
  redisClientProvider,
  queueConsumerProvider,
  ConsumerService,
];

@Module({
  providers,
  exports: [ConsumerService],
})
export class ConsumerModule {}
