import { describe, it, expect } from 'vitest';
import { type Abi, toFunctionSelector } from 'viem';
import { pactCoreAbi } from '../src/abi.js';
import {
  buildErrorSelectorMap,
  PACT_CORE_ERROR_SELECTORS,
  decodeContractError,
} from '../src/errors.js';

const abiErrorNames = (pactCoreAbi as readonly { type: string; name?: string }[])
  .filter((i) => i.type === 'error')
  .map((i) => i.name as string);

describe('error selector map (derived from ABI, never hard-coded)', () => {
  it('maps every ABI error entry exactly once', () => {
    const map = buildErrorSelectorMap(pactCoreAbi as unknown as Abi);
    expect(Object.keys(map).length).toBe(abiErrorNames.length);
    expect(new Set(Object.values(map))).toEqual(new Set(abiErrorNames));
  });

  it('includes inherited OZ errors (reachable revert paths)', () => {
    const names = new Set(Object.values(PACT_CORE_ERROR_SELECTORS));
    expect(names.has('ReentrancyGuardReentrantCall')).toBe(true);
    expect(names.has('SafeERC20FailedOperation')).toBe(true);
  });

  it('resolves a known selector to its error name', () => {
    const sel = toFunctionSelector('Unauthorized()');
    expect(PACT_CORE_ERROR_SELECTORS[sel]).toBe('Unauthorized');
  });

  it('NotImplemented was removed in task 2.0', () => {
    expect(abiErrorNames).not.toContain('NotImplemented');
  });
});

describe('decodeContractError', () => {
  it('returns undefined for a non-viem error', () => {
    expect(decodeContractError(new Error('plain'))).toBeUndefined();
    expect(decodeContractError('nope')).toBeUndefined();
    expect(decodeContractError(undefined)).toBeUndefined();
  });
});
