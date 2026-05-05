export interface SettleEvent {
  call_id: string;
  agent_wallet: string;
  slug: string;
  outcome: "ok" | "client_error" | "server_error" | "timeout";
  breach: boolean;
  reason?: "latency" | "5xx" | "network";
  premium_lamports: string;
  refund_lamports: string;
  latency_ms: number;
  timestamp: string;
}

export interface PubSubTopic {
  publishMessage(opts: { json: unknown }): Promise<string>;
}

export interface EventPublisher {
  publish(event: SettleEvent): Promise<void>;
}

export class PubSubEventPublisher implements EventPublisher {
  constructor(private readonly topic: PubSubTopic) {}

  async publish(event: SettleEvent): Promise<void> {
    try {
      await this.topic.publishMessage({ json: event });
    } catch (err) {
      console.error("[events] pubsub publish error", err);
    }
  }
}

export function createPubSubPublisher(project: string, topicName: string): EventPublisher {
  // Lazy import so tests can mock without loading pubsub SDK
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PubSub } = require("@google-cloud/pubsub") as typeof import("@google-cloud/pubsub");
  const client = new PubSub({ projectId: project });
  const topic = client.topic(topicName);
  return new PubSubEventPublisher(topic as unknown as PubSubTopic);
}
