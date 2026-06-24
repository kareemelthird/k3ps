/**
 * Tests for void-aware order/session aggregation (ADR-0006 Decisions 2 & 8).
 *
 * Invariants:
 *   - exact integer Σ qty × unit_price; NO rounding;
 *   - voided LINES (is_void) excluded; voided ORDERS (status==='void') excluded;
 *   - open AND paid orders both count toward orders_total;
 *   - empty / all-void ⇒ 0;
 *   - feeds computeGrandTotal's orders_total unchanged.
 */
import {
  computeOrderTotal,
  computeOrdersTotalForSession,
  type OrderLineInput,
  type OrderRollupInput,
} from './order-total';
import { computeGrandTotal } from '../pricing';

describe('computeOrderTotal — exact integer sum (Decision 8)', () => {
  test('sums qty × unit_price over lines', () => {
    const lines: OrderLineInput[] = [
      { qty: 2, unit_price: 1500 }, // 3000
      { qty: 1, unit_price: 750 }, // 750
      { qty: 3, unit_price: 1000 }, // 3000
    ];
    expect(computeOrderTotal(lines)).toBe(6750);
  });

  test('single line', () => {
    expect(computeOrderTotal([{ qty: 1, unit_price: 2500 }])).toBe(2500);
  });

  test('empty order ⇒ 0', () => {
    expect(computeOrderTotal([])).toBe(0);
  });

  test('is_void: false is included; omitted is_void treated as not void', () => {
    const lines: OrderLineInput[] = [
      { qty: 2, unit_price: 1000, is_void: false },
      { qty: 1, unit_price: 500 },
    ];
    expect(computeOrderTotal(lines)).toBe(2500);
  });

  test('voided line is excluded', () => {
    const lines: OrderLineInput[] = [
      { qty: 2, unit_price: 1000 }, // 2000
      { qty: 5, unit_price: 9999, is_void: true }, // excluded
      { qty: 1, unit_price: 500 }, // 500
    ];
    expect(computeOrderTotal(lines)).toBe(2500);
  });

  test('all-void ⇒ 0', () => {
    const lines: OrderLineInput[] = [
      { qty: 2, unit_price: 1000, is_void: true },
      { qty: 1, unit_price: 500, is_void: true },
    ];
    expect(computeOrderTotal(lines)).toBe(0);
  });

  test('result is an exact integer (no rounding artifacts)', () => {
    // 7 × 333 = 2331 — exact, no fractional drift.
    expect(computeOrderTotal([{ qty: 7, unit_price: 333 }])).toBe(2331);
  });

  test('defensive: negative qty contributes 0, never a credit', () => {
    const lines: OrderLineInput[] = [
      { qty: -3, unit_price: 1000 }, // floored to 0
      { qty: 2, unit_price: 1000 }, // 2000
    ];
    expect(computeOrderTotal(lines)).toBe(2000);
  });

  test('defensive: non-integer qty/unit_price are rounded', () => {
    // qty 2.4 → 2, unit_price 99.6 → 100 ⇒ 200
    expect(computeOrderTotal([{ qty: 2.4, unit_price: 99.6 }])).toBe(200);
  });

  test('zero unit_price line contributes 0', () => {
    expect(
      computeOrderTotal([
        { qty: 5, unit_price: 0 },
        { qty: 1, unit_price: 1000 },
      ]),
    ).toBe(1000);
  });
});

describe('computeOrdersTotalForSession — multi-order rollup (Decision 3)', () => {
  test('sums non-void orders', () => {
    const orders: OrderRollupInput[] = [
      { status: 'open', lines: [{ qty: 2, unit_price: 1000 }] }, // 2000
      { status: 'paid', lines: [{ qty: 1, unit_price: 1500 }] }, // 1500
    ];
    expect(computeOrdersTotalForSession(orders)).toBe(3500);
  });

  test('open AND paid orders both count', () => {
    const orders: OrderRollupInput[] = [
      { status: 'open', lines: [{ qty: 1, unit_price: 1000 }] },
      { status: 'paid', lines: [{ qty: 1, unit_price: 1000 }] },
    ];
    expect(computeOrdersTotalForSession(orders)).toBe(2000);
  });

  test('voided ORDER is excluded entirely', () => {
    const orders: OrderRollupInput[] = [
      { status: 'open', lines: [{ qty: 1, unit_price: 1000 }] }, // 1000
      { status: 'void', lines: [{ qty: 99, unit_price: 9999 }] }, // excluded
    ];
    expect(computeOrdersTotalForSession(orders)).toBe(1000);
  });

  test('void LINE inside a non-void order is excluded; order still counts', () => {
    const orders: OrderRollupInput[] = [
      {
        status: 'paid',
        lines: [
          { qty: 2, unit_price: 1000 }, // 2000
          { qty: 1, unit_price: 500, is_void: true }, // excluded
        ],
      },
    ];
    expect(computeOrdersTotalForSession(orders)).toBe(2000);
  });

  test('empty session ⇒ 0', () => {
    expect(computeOrdersTotalForSession([])).toBe(0);
  });

  test('all orders void ⇒ 0', () => {
    const orders: OrderRollupInput[] = [
      { status: 'void', lines: [{ qty: 1, unit_price: 1000 }] },
      { status: 'void', lines: [{ qty: 2, unit_price: 2000 }] },
    ];
    expect(computeOrdersTotalForSession(orders)).toBe(0);
  });

  test('order with no lines contributes 0', () => {
    const orders: OrderRollupInput[] = [
      { status: 'open', lines: [] },
      { status: 'paid', lines: [{ qty: 1, unit_price: 800 }] },
    ];
    expect(computeOrdersTotalForSession(orders)).toBe(800);
  });

  test('feeds computeGrandTotal as orders_total (unchanged engine)', () => {
    const orders: OrderRollupInput[] = [
      { status: 'open', lines: [{ qty: 2, unit_price: 1000 }] }, // 2000
      { status: 'paid', lines: [{ qty: 1, unit_price: 500 }] }, // 500
    ];
    const ordersTotal = computeOrdersTotalForSession(orders); // 2500
    const grand = computeGrandTotal({
      time_total: 10000,
      orders_total: ordersTotal,
      discount: 1000,
    });
    expect(grand).toBe(11500); // 10000 + 2500 − 1000
  });
});
