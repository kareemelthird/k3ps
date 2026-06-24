/**
 * Shifts — cash-drawer reconciliation (ADR-0006 Decision 3).
 *
 * The drawer math an owner sees at shift close:
 *   expected_cash = opening_cash + cash_sales − payouts
 *   difference    = counted_cash − expected_cash   (NOT clamped)
 *
 * `difference` is deliberately UN-clamped: a negative number is a real shortage
 * the owner needs to see, a positive number is an overage. Clamping a short
 * drawer to zero would hide cash loss — exactly the bug this guards against.
 *
 * HARD RULES (CLAUDE.md §2, §4):
 *   - Integer piastres only; never floats; no rounding (all inputs are already
 *     integer piastres — nothing to round).
 *   - Pure: no clock read, no I/O, no querying. It sums what it is given; the
 *     caller builds `cash_sales` from CASH-settled rows only (Decision 3).
 *   - No React / RN / Expo / Next / Supabase imports.
 */
import type { Piastres } from '../money';

export interface ShiftReconciliationInput {
  /** Integer piastres >= 0 — the opening float in the drawer. */
  opening_cash: Piastres;
  /**
   * Integer piastres — Σ CASH-settled session `grand_total`s + CASH walk-in
   * order totals stamped with this `shift_id`. wallet/other/debt are EXCLUDED
   * by the caller (Decision 3); this function sums what it is given.
   */
  cash_sales: Piastres;
  /** Integer piastres — cash paid OUT of the drawer. Default 0. */
  payouts?: Piastres;
  /** Integer piastres — the physical count at close (= actual_cash). */
  counted_cash: Piastres;
}

export interface ShiftReconciliation {
  /** opening_cash + cash_sales − payouts. */
  expected_cash: Piastres;
  /** counted_cash − expected_cash; positive = OVER, negative = SHORT. */
  difference: Piastres;
}

/**
 * Pure drawer reconciliation:
 *   expected_cash = opening_cash + cash_sales − payouts
 *   difference    = counted_cash − expected_cash   (NOT clamped — short is negative)
 *
 * Integer piastres throughout; no rounding (all inputs are integers); no clock
 * read. The caller is responsible for building `cash_sales` from CASH-settled
 * rows only (Decision 3) — this function never queries. `payouts` defaults to 0.
 */
export function computeShiftReconciliation(
  input: ShiftReconciliationInput,
): ShiftReconciliation {
  const payouts = input.payouts ?? 0;
  const expected_cash = input.opening_cash + input.cash_sales - payouts;
  const difference = input.counted_cash - expected_cash;
  return { expected_cash, difference };
}
