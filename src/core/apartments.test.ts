import { describe, expect, it } from 'vitest';
import {
  applyPatches,
  currencyDigits,
  formatUnitNumber,
  isSelectable,
  matchesFilter,
  statusColor,
  STATUS_COLORS,
} from './apartments';
import type { Apartment } from './types';

const apt = (over: Partial<Apartment> = {}): Apartment => ({
  id: 'a1',
  number: '101',
  floor: 1,
  status: 'available',
  rooms: 2,
  areaM2: 64,
  price: { amountMinor: 12_000_000, currency: 'AZN' },
  ...over,
});

describe('apartments', () => {
  it('colours known statuses and greys out unknown ones', () => {
    expect(statusColor('sold')).toBe(STATUS_COLORS.sold);
    expect(statusColor('on-hold')).toBe(STATUS_COLORS.unknown);
  });

  it('only lets listed statuses be selected', () => {
    expect(isSelectable(apt(), ['available'])).toBe(true);
    expect(isSelectable(apt({ status: 'sold' }), ['available'])).toBe(false);
    expect(isSelectable(apt({ status: 'on-hold' }), ['available'])).toBe(false);
  });

  it('filters by status, rooms, floor, price and area', () => {
    expect(matchesFilter(apt(), null)).toBe(true);
    expect(matchesFilter(apt(), { status: ['available'] })).toBe(true);
    expect(matchesFilter(apt(), { status: ['sold'] })).toBe(false);
    expect(matchesFilter(apt(), { rooms: [3] })).toBe(false);
    expect(matchesFilter(apt({ rooms: undefined }), { rooms: [2] })).toBe(false);
    expect(matchesFilter(apt(), { minFloor: 2 })).toBe(false);
    expect(matchesFilter(apt(), { maxPrice: 12_000_000 })).toBe(true);
    expect(matchesFilter(apt({ price: undefined }), { maxPrice: 1 })).toBe(false);
    expect(matchesFilter(apt(), { minArea: 60, maxArea: 70 })).toBe(true);
  });

  it('merges patches by id and reports unknown ids', () => {
    const list = [apt(), apt({ id: 'a2', number: '102' })];
    const { apartments, unknownIds } = applyPatches(list, [
      { id: 'a2', status: 'sold' },
      { id: 'zz', status: 'sold' },
    ]);
    expect(apartments[1]?.status).toBe('sold');
    expect(apartments[1]?.number).toBe('102');
    expect(apartments[0]).toBe(list[0]);
    expect(list[1]?.status).toBe('available');
    expect(unknownIds).toEqual(['zz']);
  });

  it('knows how many decimals each currency has', () => {
    expect(currencyDigits('AZN')).toBe(2);
    expect(currencyDigits('JPY')).toBe(0);
    expect(currencyDigits('KWD')).toBe(3);
    expect(currencyDigits('not a code')).toBe(2);
  });

  it('formats unit numbers from a pattern', () => {
    expect(formatUnitNumber('{floor}{nn}', 12, 3)).toBe('1203');
    expect(formatUnitNumber('{floor}-{n}', 2, 7)).toBe('2-7');
    expect(formatUnitNumber('A{nnn}', 0, 5)).toBe('A005');
  });
});
