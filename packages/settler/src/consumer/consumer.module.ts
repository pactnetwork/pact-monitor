import { Module, type FactoryProvider, type Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PubSub } from "@google-cloud/pubsub";
import { ConsumerService, QUEUE_CONSUMER } from "./consumer.service";
import { PubSubQueueConsumer } from "./pubsub-queue-consumer";
import type { QueueConsumer } from "./queue-consumer.interface";

// Backend selection — see plan/devnet-mirror-build §4.4–4.5.
//
// QUEUE_BACKEND defaults to "pubsub" so mainnet behavior is byte-identical:
// the PubSub provider is eagerly constructed and the consumer wraps it
// exactly as the pre-refactor module did. When QUEUE_BACKEND=redis-streams
// (devnet on Railway) the Pub/Sub provider is skipped entirely — see the
// RedisStreamsQueueConsumer factory branch (Wave 5).

const pubsubProvider: FactoryProvider<PubSub> = {
  provide: PubSub,
  inject: [ConfigService],
  useFactory: (config: ConfigService): PubSub => {
    const backend = config.get<string>("QUEUE_BACKEND") ?? "pubsub";
    if (backend !== "pubsub") {
      // When devnet is selected we still satisfy the DI graph by returning
      // a never-used PubSub instance. The Redis consumer branch in the
      // QUEUE_CONSUMER factory below ignores it. Constructing the SDK is
      // cheap (no network until you call subscribe()) so this stays safe.
      return new PubSub();
    }
    return new PubSub();
  },
};

const queueConsumerProvider: FactoryProvider<QueueConsumer> = {
  provide: QUEUE_CONSUMER,
  inject: [ConfigService, PubSub],
  useFactory: (config: ConfigService, pubsub: PubSub): QueueConsumer => {
    const backend = config.get<string>("QUEUE_BACKEND") ?? "pubsub";
    if (backend === "pubsub") {
      return new PubSubQueueConsumer(pubsub, {
        projectId: config.getOrThrow<string>("PUBSUB_PROJECT"),
        subscriptionName: config.getOrThrow<string>("PUBSUB_SUBSCRIPTION"),
      });
    }
    // Wave 5 wires the Redis branch here.
    throw new Error(
      `QUEUE_BACKEND="${backend}" is not yet supported in this build`,
    );
  },
};

const providers: Provider[] = [
  pubsubProvider,
  queueConsumerProvider,
  ConsumerService,
];

@Module({
  providers,
  exports: [ConsumerService],
})
export class ConsumerModule {}
