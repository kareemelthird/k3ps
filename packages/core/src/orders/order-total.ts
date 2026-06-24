/**
 * Orders — void-aware exact-integer order/session aggregation (ADR-0006
 * Decisions 2 & 8).
 *
 * `qty` and `unit_price` are already integers (piastres), so an order total is
 * an EXACT integer sum of `qty × unit_price` over non-void lines — there is NO
 * rounding at all (unlike time billing, which rounds minutes per segment). This
 * keeps every order total trivially reconstructible from its line snapshots.
 *
 * This module produces the `orders_total` that the (unchanged) pricing engine
 * `computeGrandTotal(...)` folds into a session's `grand_total`.
 *
 * HARD RULES (CLAUDE.md §2, §4):
 *   - Integer piastres only; never floats; never accumulate rounding (here:
 *     never round at all — Decision 8).
 *   - Pure: no clock read, no I/O. Same input → same output.
 *   - No React / RN / Expo / Next / Supabase imports.
 */
import type { Piastres } from '../money';

/** Minimal shape of an order line the total math needs. */
export interface OrderLineInput {
  /** Integer quantity (>= 1 in practice). */
  qty: number;
  /** Integer piastres, snapshot at add-time. */
  unit_price: Piastres;
  /** Default false; voided lines are excluded from the total. */
  is_void?: boolean;
}

/** Minimal shape of an order the session-rollup needs. */
export interface OrderRollupInput {
  /** A `'void'` order is excluded entirely from the session rollup. */
  status: 'open' | 'paid' | 'void';
  /** The order's lines (void-aware via {@link computeOrderTotal}). */
  lines: OrderLineInput[];
}

/**
 * Σ (qty × unit_price) over NON-VOID lines. Exact integer piastres — NO rounding
 * (qty and unit_price are already integers; Decision 8). A line with
 * `is_void === true` is excluded. Empty / all-void ⇒ 0. Pure; no clock read.
 *
 * Defensive: a malformed line must never inflate a bill, so `qty` and
 * `unit_price` are coerced to their `Math.round` value and `qty` is floored at 0
 * (a negative qty contributes 0, not a credit). Callers pass validated integers;
 * this is belt-and-braces only.
 */
export function computeOrderTotal(lines: OrderLineInput[]): Piastres {
  let total = 0;
  for (const line of lines) {
    if (line.is_void === true) continue;
    const qty = Math.max(0, Math.round(line.qty));
    const unitPrice = Math.round(line.unit_price);
    total += qty * unitPrice;
  }
  return total;
}

/**
 * Σ of {@link computeOrderTotal}(order.lines) over the session's NON-VOID orders
 * (`status !== 'void'`). This is exactly the `orders_total` that
 * `computeGrandTotal(...)` folds into a session's `grand_total` (ADR-0005 §6) —
 * `computeGrandTotal` is UNCHANGED; this only produces its input. Empty ⇒ 0.
 * Pure; integer piastres; no clock read.
 *
 * NB: open AND paid orders both count toward `orders_total` while the session is
 * live (snacks consumed are owed regardless of an order's own status); only a
 * voided ORDER (`status === 'void'`) or a voided LINE (`is_void`) is excluded.
 */
export function computeOrdersTotalForSession(
  orders: OrderRollupInput[],
): Piastres {
  let total = 0;
  for (const order of orders) {
    if (order.status === 'void') continue;
    total += computeOrderTotal(order.lines);
  }
  return total;
}
