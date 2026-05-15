import { describe, it, expect } from 'vitest';
import { SettlementStatus, RecipientKind } from '../src/types.js';
import { pactCoreAbi } from '../src/abi.js';

describe('SettlementStatus enum (shifted +1 from v1; no Refunded)', () => {
  it('has the exact contract discriminants', () => {
    expect(SettlementStatus.Unsettled).toBe(0);
    expect(SettlementStatus.Settled).toBe(1);
    expect(SettlementStatus.DelegateFailed).toBe(2);
    expect(SettlementStatus.PoolDepleted).toBe(3);
    expect(SettlementStatus.ExposureCapClamped).toBe(4);
  });

  it('does NOT define a Refunded state', () => {
    expect(
      (SettlementStatus as Record<string, unknown>).Refunded,
    ).toBeUndefined();
  });

  it('RecipientKind matches the contract', () => {
    expect(RecipientKind.Treasury).toBe(0);
    expect(RecipientKind.Affiliate).toBe(1);
  });
});

describe('EndpointConfig field order vs the ABI getter', () => {
  it('matches the flattened endpointConfig() output order exactly', () => {
    const fn = (pactCoreAbi as readonly { type: string; name?: string; outputs?: { name?: string }[] }[])
      .find((i) => i.type === 'function' && i.name === 'endpointConfig');
    expect(fn).toBeTruthy();
    const abiOrder = (fn!.outputs ?? []).map((o) => o.name);

    // The order bindings.ts maps positionally into the EndpointConfig type.
    const expected = [
      'agentTokenId',
      'flatPremium',
      'percentBps',
      'imputedCost',
      'latencySloMs',
      'exposureCapPerHour',
      'currentPeriodStart',
      'currentPeriodRefunds',
      'totalCalls',
      'totalBreaches',
      'totalPremiums',
      'totalRefunds',
      'lastUpdated',
      'paused',
      'exists',
    ];
    expect(abiOrder).toEqual(expected);
  });
});
