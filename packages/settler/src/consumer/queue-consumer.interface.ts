// Backend-agnostic queue consumer interface.
//
// The settler reads SettleMessages from a queue, batches them, and submits
// settle_batch txs on-chain. The original implementation was tightly coupled
// to @google-cloud/pubsub. To support devnet on Railway (where Pub/Sub isn't
// available), the consumer is now an interface with two implementations:
//
//   - PubSubQueueConsumer    (mainnet, default — preserves byte-identical
//                             behavior when QUEUE_BACKEND is unset)
//   - RedisStreamsQueueConsumer (devnet)
//
// SettleMessage no longer carries a backend-specific `raw` field. Each
// implementation attaches `ack()` and `nack()` closures at enqueue time so
// callers (batcher, pipeline) interact with the message via the interface
// only.

export interface SettleMessage {
  /** Backend message ID (Pub/Sub message ID, Redis stream entry ID). */
  id: string;
  /** Parsed JSON payload — the SettlementEvent published by the proxy. */
  data: Record<string, unknown>;
  /** Acknowledge to the backend. Idempotent — calling twice is a no-op. */
  ack(): void;
  /**
   * Negatively acknowledge — release for redelivery. For Pub/Sub this calls
   * `msg.nack()` (immediate redelivery). For Redis Streams it leaves the
   * entry in the consumer-group PEL so XCLAIM-style retry can pick it up.
   */
  nack(): void;
}

export interface QueueConsumer {
  /** Start consuming. Called from NestJS OnModuleInit. */
  init(): void | Promise<void>;
  /** Stop consuming and release backend resources. Called from OnModuleDestroy. */
  destroy(): void | Promise<void>;
  /** Register a callback fired when a new message is enqueued. */
  setEnqueueCallback(cb: (msg: SettleMessage) => void): void;
  /** Atomically remove and return all currently-queued messages. */
  drain(): SettleMessage[];
  /** Number of messages currently queued in memory awaiting drain. */
  readonly queueLength: number;
  /** Bulk acknowledge. */
  ack(messages: SettleMessage[]): void;
  /** Bulk negatively acknowledge. */
  nack(messages: SettleMessage[]): void;
}
