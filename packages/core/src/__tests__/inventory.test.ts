/**
 * Tests for inventory module — AC 13–17.
 * All AC references are from docs/specs/phase-2-tenant-foundation.md.
 */

import {
  LOW_STOCK_DEFAULT,
  computeLevels,
  stockStatus,
  offsettingVoids,
  inventoryValue,
  isTracked,
} from '../inventory/stock';

// ─── AC 14: computeLevels ────────────────────────────────────────────────────

describe('computeLevels', () => {
  test('AC 14a: +10 then -3 → level 7', () => {
    const movements = [
      { product_id: 'p', delta: +10 },
      { product_id: 'p', delta: -3 },
    ];
    const levels = computeLevels(movements);
    expect(levels['p']).toBe(7);
  });

  test('AC 14b: may go negative (oversell signal, NOT clamped)', () => {
    const movements = [
      { product_id: 'p', delta: +2 },
      { product_id: 'p', delta: -5 },
    ];
    const levels = computeLevels(movements);
    expect(levels['p']).toBe(-3);
  });

  test('empty movements returns empty record', () => {
    expect(computeLevels([])).toEqual({});
  });

  test('multiple products are tracked independently', () => {
    const movements = [
      { product_id: 'a', delta: 5 },
      { product_id: 'b', delta: 3 },
      { product_id: 'a', delta: -2 },
    ];
    const levels = computeLevels(movements);
    expect(levels['a']).toBe(3);
    expect(levels['b']).toBe(3);
  });

  test('single movement', () => {
    const levels = computeLevels([{ product_id: 'x', delta: 10 }]);
    expect(levels['x']).toBe(10);
  });
});

// ─── AC 15: stockStatus ──────────────────────────────────────────────────────

describe('stockStatus', () => {
  test('AC 15a: stockStatus(0) === out', () => {
    expect(stockStatus(0)).toBe('out');
  });

  test('AC 15b: stockStatus(5, 5) === low (inclusive threshold)', () => {
    expect(stockStatus(5, 5)).toBe('low');
  });

  test('AC 15c: stockStatus(6, 5) === ok', () => {
    expect(stockStatus(6, 5)).toBe('ok');
  });

  test('AC 15d: untracked (null/undefined) === untracked', () => {
    expect(stockStatus(null)).toBe('untracked');
    expect(stockStatus(undefined)).toBe('untracked');
  });

  test('negative on-hand → out', () => {
    expect(stockStatus(-1)).toBe('out');
  });

  test('default low threshold is LOW_STOCK_DEFAULT (5)', () => {
    expect(LOW_STOCK_DEFAULT).toBe(5);
    expect(stockStatus(5)).toBe('low'); // exactly at default threshold
    expect(stockStatus(6)).toBe('ok');
  });

  test('stockStatus(1, 10) === low', () => {
    expect(stockStatus(1, 10)).toBe('low');
  });

  test('stockStatus(11, 10) === ok', () => {
    expect(stockStatus(11, 10)).toBe('ok');
  });
});

// ─── AC 16: offsettingVoids ──────────────────────────────────────────────────

describe('offsettingVoids', () => {
  test('AC 16: each void is exact negation of its sale delta', () => {
    const sales = [
      { product_id: 'a', delta: -3 },
      { product_id: 'b', delta: -1 },
    ];
    const voids = offsettingVoids(sales);
    expect(voids).toEqual([
      { product_id: 'a', delta: 3 },
      { product_id: 'b', delta: 1 },
    ]);
  });

  test('sale + void = 0 per product', () => {
    const sales = [{ product_id: 'p', delta: -7 }];
    const voids = offsettingVoids(sales);
    const saleDelta = sales[0]?.delta ?? 0;
    const voidDelta = voids[0]?.delta ?? 0;
    expect(saleDelta + voidDelta).toBe(0);
  });

  test('empty sales returns empty voids', () => {
    expect(offsettingVoids([])).toEqual([]);
  });

  test('preserves product_id', () => {
    const sales = [{ product_id: 'unique-id-123', delta: -5 }];
    const voids = offsettingVoids(sales);
    expect(voids[0]?.product_id).toBe('unique-id-123');
  });

  test('handles positive sales (restock) if caller passes them', () => {
    const sales = [{ product_id: 'x', delta: 10 }];
    const voids = offsettingVoids(sales);
    expect(voids[0]?.delta).toBe(-10);
  });
});

// ─── AC 17: inventoryValue ───────────────────────────────────────────────────

describe('inventoryValue', () => {
  test('AC 17a: sums onHand × cost only for tracked, costed, positive-stock', () => {
    const products = [
      { id: 'a', stock: 5, cost: 1000 },   // tracked, costed, positive → 5000
      { id: 'b', stock: null, cost: 500 },  // untracked → excluded
      { id: 'c', stock: 3, cost: null },    // no cost → excluded
      { id: 'd', stock: 0, cost: 200 },     // zero stock (out) → excluded (the levels says 0)
    ];
    const levels: Record<string, number> = { a: 5, b: 10, c: 3, d: 0 };
    expect(inventoryValue(products, levels)).toBe(5000);
  });

  test('AC 17b: negative stock entries are excluded', () => {
    const products = [{ id: 'x', stock: 5, cost: 100 }];
    const levels: Record<string, number> = { x: -2 };
    expect(inventoryValue(products, levels)).toBe(0);
  });

  test('multiple tracked, costed products', () => {
    const products = [
      { id: 'a', stock: 1, cost: 200 }, // 3 on-hand × 200 = 600
      { id: 'b', stock: 1, cost: 50 },  // 10 on-hand × 50 = 500
    ];
    const levels = { a: 3, b: 10 };
    expect(inventoryValue(products, levels)).toBe(1100);
  });

  test('empty products → 0', () => {
    expect(inventoryValue([], {})).toBe(0);
  });

  test('product missing from levels → treated as 0, excluded', () => {
    const products = [{ id: 'missing', stock: 5, cost: 100 }];
    expect(inventoryValue(products, {})).toBe(0);
  });
});

// ─── isTracked ───────────────────────────────────────────────────────────────

describe('isTracked', () => {
  test('returns true when stock is a number', () => {
    expect(isTracked({ stock: 0 })).toBe(true);
    expect(isTracked({ stock: 5 })).toBe(true);
  });

  test('returns false when stock is null', () => {
    expect(isTracked({ stock: null })).toBe(false);
  });
});
