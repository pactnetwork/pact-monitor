import { describe, it, expect } from 'vitest';
import {
  type Hex,
  type Address,
  encodeEventTopics,
  encodeAbiParameters,
} from 'viem';
import { pactCoreAbi } from '../src/abi.js';
import {
  decodePactCoreEvent,
  decodeCallSettled,
  PACT_CORE_EVENT_NAMES,
} from '../src/events.js';
import { SettlementStatus } from '../src/types.js';

type AbiEventInput = { name: string; type: string; indexed?: boolean };

/** Build a synthetic log (topics + data) for an event from an args record. */
function fakeLog(eventName: string, args: Record<string, unknown>) {
  const ev = (pactCoreAbi as readonly { type: string; name?: string; inputs?: AbiEventInput[] }[])
    .find((i) => i.type === 'event' && i.name === eventName);
  if (!ev) throw new Error(`no event ${eventName}`);
  const inputs = ev.inputs ?? [];

  const indexedArgs: Record<string, unknown> = {};
  for (const inp of inputs.filter((i) => i.indexed)) {
    indexedArgs[inp.name] = args[inp.name];
  }
  const topics = encodeEventTopics({
    abi: pactCoreAbi,
    eventName: eventName as never,
    args: indexedArgs as never,
  });

  const nonIndexed = inputs.filter((i) => !i.indexed);
  const data =
    nonIndexed.length === 0
      ? '0x'
      : encodeAbiParameters(
          nonIndexed.map((i) => ({ type: i.type })),
          nonIndexed.map((i) => args[i.name]),
        );

  return {
    data: data as Hex,
    topics: topics as [Hex, ...Hex[]],
    transactionHash: '0xabc' as Hex,
    logIndex: 3,
    blockNumber: 99n,
  };
}

const SLUG = '0x68656c697573000000000000000000' .padEnd(34, '0') as Hex;
const CALLID = '0x550e8400e29b41d4a716446655440000' as Hex;
const ADDR = '0x1111111111111111111111111111111111111111' as Address;
const ROOT =
  '0xabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcd' as Hex;

describe('events round-trip (hand-crafted logs → decodePactCoreEvent)', () => {
  it('exports exactly the 8 PactCore event names, matching the ABI', () => {
    const abiEvents = (pactCoreAbi as readonly { type: string; name?: string }[])
      .filter((i) => i.type === 'event')
      .map((i) => i.name)
      .sort();
    expect([...PACT_CORE_EVENT_NAMES].sort()).toEqual(abiEvents);
    expect(PACT_CORE_EVENT_NAMES.length).toBe(8);
  });

  it('CallSettled — incl. actualRefund (round-2 C1)', () => {
    const log = fakeLog('CallSettled', {
      callId: CALLID,
      slug: SLUG,
      agent: ADDR,
      status: SettlementStatus.PoolDepleted,
      premium: 10_000n,
      refund: 5_000n,
      actualRefund: 1_234n,
      rootHash: ROOT,
    });
    const ev = decodeCallSettled(log);
    expect(ev.eventName).toBe('CallSettled');
    expect(ev.callId).toBe(CALLID);
    expect(ev.slug).toBe(SLUG);
    expect(ev.agent.toLowerCase()).toBe(ADDR);
    expect(ev.status).toBe(SettlementStatus.PoolDepleted);
    expect(ev.premium).toBe(10_000n);
    expect(ev.refund).toBe(5_000n);
    expect(ev.actualRefund).toBe(1_234n);
    expect(ev.rootHash).toBe(ROOT);
    expect(ev.txHash).toBe('0xabc');
    expect(ev.logIndex).toBe(3);
    expect(ev.blockNumber).toBe(99n);
  });

  it('EndpointRegistered', () => {
    const ev = decodePactCoreEvent(
      fakeLog('EndpointRegistered', {
        slug: SLUG,
        agentTokenId: 42n,
        flatPremium: 1_000n,
        percentBps: 50,
        imputedCost: 7n,
        latencySloMs: 5_000,
        exposureCapPerHour: 9_000n,
      }),
    );
    expect(ev).toMatchObject({
      eventName: 'EndpointRegistered',
      agentTokenId: 42n,
      percentBps: 50,
      latencySloMs: 5_000,
    });
  });

  it('PoolToppedUp / RecipientPaid / EndpointPaused / ProtocolPaused', () => {
    expect(
      decodePactCoreEvent(
        fakeLog('PoolToppedUp', { slug: SLUG, funder: ADDR, amount: 500n }),
      ),
    ).toMatchObject({ eventName: 'PoolToppedUp', amount: 500n });

    expect(
      decodePactCoreEvent(
        fakeLog('RecipientPaid', { slug: SLUG, recipient: ADDR, amount: 9n }),
      ),
    ).toMatchObject({ eventName: 'RecipientPaid', amount: 9n });

    expect(
      decodePactCoreEvent(fakeLog('EndpointPaused', { slug: SLUG, paused: true })),
    ).toMatchObject({ eventName: 'EndpointPaused', paused: true });

    expect(
      decodePactCoreEvent(fakeLog('ProtocolPaused', { paused: false })),
    ).toMatchObject({ eventName: 'ProtocolPaused', paused: false });
  });

  it('EndpointConfigUpdated / FeeRecipientsUpdated (slug-only)', () => {
    expect(
      decodePactCoreEvent(fakeLog('EndpointConfigUpdated', { slug: SLUG })),
    ).toMatchObject({ eventName: 'EndpointConfigUpdated', slug: SLUG });
    expect(
      decodePactCoreEvent(fakeLog('FeeRecipientsUpdated', { slug: SLUG })),
    ).toMatchObject({ eventName: 'FeeRecipientsUpdated', slug: SLUG });
  });

  it('decodeCallSettled rejects a non-CallSettled log', () => {
    expect(() =>
      decodeCallSettled(fakeLog('ProtocolPaused', { paused: true })),
    ).toThrow();
  });
});
