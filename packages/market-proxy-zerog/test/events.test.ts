import { describe, it, expect, vi } from 'vitest';
import type { SettlementEvent } from '@pact-network/wrap';
import { pubSubSinkFromTopic } from '../src/events';

const event: SettlementEvent = {
  callId: '550e8400-e29b-41d4-a716-446655440000',
  agentPubkey: '0x' + 'a'.repeat(40),
  endpointSlug: 'og-qwen',
  premiumLamports: '500',
  refundLamports: '0',
  latencyMs: 1200,
  outcome: 'ok',
  ts: '2026-05-15T12:00:00.000Z',
};

describe('pubSubSinkFromTopic', () => {
  it('forwards the event to topic.publishMessage as { json }', async () => {
    const publishMessage = vi.fn(async () => 'msg-id-1');
    const sink = pubSubSinkFromTopic({ publishMessage });
    await sink.publish(event);
    expect(publishMessage).toHaveBeenCalledWith({ json: event });
  });

  it('swallows a publish error (hot path must never throw)', async () => {
    const publishMessage = vi.fn(async () => {
      throw new Error('pubsub unavailable');
    });
    const sink = pubSubSinkFromTopic({ publishMessage });
    await expect(sink.publish(event)).resolves.toBeUndefined();
  });
});
