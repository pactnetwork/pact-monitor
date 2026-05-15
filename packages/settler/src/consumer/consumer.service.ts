// ConsumerService — NestJS facade over the backend-agnostic QueueConsumer.
//
// Backwards-compat shim: existing callers (BatcherService, pipeline tests)
// import { ConsumerService, SettleMessage } from "./consumer.service". The
// public surface is preserved; the actual queue implementation is selected
// in ConsumerModule (see consumer.module.ts) based on QUEUE_BACKEND env.
//
// Default backend is PubSubQueueConsumer so mainnet's runtime behavior is
// byte-identical to the pre-adapter code path.

import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import type { QueueConsumer, SettleMessage } from "./queue-consumer.interface";

export type { SettleMessage } from "./queue-consumer.interface";

export const QUEUE_CONSUMER = Symbol("QUEUE_CONSUMER");

@Injectable()
export class ConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConsumerService.name);

  constructor(@Inject(QUEUE_CONSUMER) private readonly consumer: QueueConsumer) {}

  async onModuleInit(): Promise<void> {
    await this.consumer.init();
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer.destroy();
  }

  setEnqueueCallback(cb: (msg: SettleMessage) => void): void {
    this.consumer.setEnqueueCallback(cb);
  }

  drain(): SettleMessage[] {
    return this.consumer.drain();
  }

  ack(messages: SettleMessage[]): void {
    this.consumer.ack(messages);
  }

  nack(messages: SettleMessage[]): void {
    this.consumer.nack(messages);
  }

  get queueLength(): number {
    return this.consumer.queueLength;
  }
}
