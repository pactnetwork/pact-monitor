import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PubSub, Message, Subscription } from "@google-cloud/pubsub";

export interface SettleMessage {
  id: string;
  data: Record<string, unknown>;
  raw: Message;
}

@Injectable()
export class ConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConsumerService.name);
  private subscription: Subscription | null = null;
  private readonly queue: SettleMessage[] = [];
  private onEnqueue: ((msg: SettleMessage) => void) | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly pubsub: PubSub
  ) {}

  onModuleInit() {
    const projectId = this.config.getOrThrow<string>("PUBSUB_PROJECT");
    const subscriptionName = this.config.getOrThrow<string>("PUBSUB_SUBSCRIPTION");
    const fullName = `projects/${projectId}/subscriptions/${subscriptionName}`;
    this.subscription = this.pubsub.subscription(fullName);

    this.subscription.on("message", (msg: Message) => {
      const settle: SettleMessage = {
        id: msg.id,
        data: JSON.parse(msg.data.toString("utf8")),
        raw: msg,
      };
      this.queue.push(settle);
      this.onEnqueue?.(settle);
    });

    this.subscription.on("error", (err) => {
      this.logger.error("Pub/Sub subscription error", err);
    });
  }

  onModuleDestroy() {
    this.subscription?.removeAllListeners();
    this.subscription?.close();
  }

  setEnqueueCallback(cb: (msg: SettleMessage) => void) {
    this.onEnqueue = cb;
  }

  drain(): SettleMessage[] {
    return this.queue.splice(0, this.queue.length);
  }

  ack(messages: SettleMessage[]) {
    for (const m of messages) {
      m.raw.ack();
    }
  }

  nack(messages: SettleMessage[]) {
    for (const m of messages) {
      m.raw.nack();
    }
  }

  get queueLength(): number {
    return this.queue.length;
  }
}
