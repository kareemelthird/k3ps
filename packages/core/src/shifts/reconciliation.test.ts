/**
 * Tests for shift cash reconciliation (ADR-0006 Decision 3).
 *
 * Invariants:
 *   - expected_cash = opening_cash + cash_sales − payouts;
 *   - difference    = counted_cash − expected_cash, UN-clamped
 *     (negative = shortage, positive = over, 0 = exact);
 *   - integer piastres; payouts defaults to 0; pure.
 */
import {
  computeShiftReconciliation,
  type ShiftReconciliationInput,
} from './reconciliation';

describe('computeShiftReconciliation', () => {
  test('exact drawer: difference 0', () => {
    const input: ShiftReconciliationInput = {
      opening_cash: 50000,
      cash_sales: 120000,
      payouts: 0,
      counted_cash: 170000,
    };
    expect(computeShiftReconciliation(input)).toEqual({
      expected_cash: 170000,
      difference: 0,
    });
  });

  test('shortage: counted < expected ⇒ negative difference (not clamped)', () => {
    const input: ShiftReconciliationInput = {
      opening_cash: 50000,
      cash_sales: 120000,
      payouts: 0,
      counted_cash: 165000, // 5000 short
    };
    const r = computeShiftReconciliation(input);
    expect(r.expected_cash).toBe(170000);
    expect(r.difference).toBe(-5000);
  });

  test('over: counted > expected ⇒ positive difference', () => {
    const input: ShiftReconciliationInput = {
      opening_cash: 50000,
      cash_sales: 120000,
      payouts: 0,
      counted_cash: 173000, // 3000 over
    };
    const r = computeShiftReconciliation(input);
    expect(r.expected_cash).toBe(170000);
    expect(r.difference).toBe(3000);
  });

  test('payouts reduce expected_cash', () => {
    const input: ShiftReconciliationInput = {
      opening_cash: 50000,
      cash_sales: 120000,
      payouts: 20000, // paid out of drawer
      counted_cash: 150000,
    };
    expect(computeShiftReconciliation(input)).toEqual({
      expected_cash: 150000, // 50000 + 120000 − 20000
      difference: 0,
    });
  });

  test('payouts defaults to 0 when omitted', () => {
    const input: ShiftReconciliationInput = {
      opening_cash: 10000,
      cash_sales: 5000,
      counted_cash: 15000,
    };
    expect(computeShiftReconciliation(input)).toEqual({
      expected_cash: 15000,
      difference: 0,
    });
  });

  test('payouts with a shortage', () => {
    const input: ShiftReconciliationInput = {
      opening_cash: 10000,
      cash_sales: 50000,
      payouts: 5000,
      counted_cash: 52000, // expected 55000 ⇒ −3000
    };
    const r = computeShiftReconciliation(input);
    expect(r.expected_cash).toBe(55000);
    expect(r.difference).toBe(-3000);
  });

  test('zero everything ⇒ all zero', () => {
    expect(
      computeShiftReconciliation({
        opening_cash: 0,
        cash_sales: 0,
        counted_cash: 0,
      }),
    ).toEqual({ expected_cash: 0, difference: 0 });
  });

  test('opening float with no sales, drawer untouched', () => {
    expect(
      computeShiftReconciliation({
        opening_cash: 30000,
        cash_sales: 0,
        payouts: 0,
        counted_cash: 30000,
      }),
    ).toEqual({ expected_cash: 30000, difference: 0 });
  });

  test('result is integer piastres (no float drift)', () => {
    const r = computeShiftReconciliation({
      opening_cash: 12345,
      cash_sales: 67890,
      payouts: 111,
      counted_cash: 80000,
    });
    expect(Number.isInteger(r.expected_cash)).toBe(true);
    expect(Number.isInteger(r.difference)).toBe(true);
    expect(r.expected_cash).toBe(80124); // 12345 + 67890 − 111
    expect(r.difference).toBe(-124);
  });
});
