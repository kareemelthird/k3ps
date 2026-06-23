/**
 * Inventory ledger — pure, framework-free stock math.
 *
 * On-hand for a product is the SUM of its ledger movement deltas
 * (restock/initial +, sale −, adjust ±, void = exact reversal of a sale).
 * On-hand MAY go negative: that is an oversell signal, deliberately not clamped,
 * so the counter can see and reconcile it (CLAUDE.md / pricing-engine-guard).
 *
 * A product is "tracked" when `stock` is not null; untracked products
 * (e.g. brewed coffee) have no managed count.
 */

/** Default low-stock threshold (inclusive) when a product sets none. */
export const LOW_STOCK_DEFAULT = 5;

/** Stock bucket for display/alerting. */
export type StockStatus = 'untracked' | 'out' | 'low' | 'ok';

/**
 * Minimal shape of a stock-ledger movement this module needs.
 * (The full domain row is `StockMovement` in the types module; this is the
 * structural subset the pure ledger math operates on.)
 */
export interface MovementDelta {
  product_id: string;
  delta: number;
}

/** Minimal shape of a product this module needs for valuation/tracking. */
export interface ValuedProduct {
  id: string;
  /** Managed count; `null` = untracked. */
  stock: number | null;
  /** Unit cost in piastres; `null` = no cost recorded. */
  cost: number | null;
}

/** A product is tracked (has a managed count) when `stock` is not null. */
export function isTracked(product: Pick<ValuedProduct, 'stock'>): boolean {
  return product.stock != null;
}

/**
 * On-hand per product id = Σ movement deltas.
 * Result may be negative (oversell signal) — never clamped.
 */
export function computeLevels(movements: MovementDelta[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of movements) {
    out[m.product_id] = (out[m.product_id] ?? 0) + m.delta;
  }
  return out;
}

/**
 * Offsetting deltas that reverse a set of recorded sale movements (for a void).
 * Driven by the ACTUAL recorded sales — not the product's current tracked flag —
 * so a void restores exactly what was sold even if the product was later
 * untracked. For each input, `delta` is negated, so sale + void = 0 per product.
 */
export function offsettingVoids(sales: MovementDelta[]): MovementDelta[] {
  return sales.map((s) => ({ product_id: s.product_id, delta: -s.delta }));
}

/**
 * Status bucket for a product given its on-hand and an (inclusive) low
 * threshold.
 * - Pass `null` or `undefined` to signal an untracked product → 'untracked'.
 * - `<= 0` → 'out'; `<= low` (inclusive) → 'low'; otherwise 'ok'.
 *
 * @example stockStatus(null)    → 'untracked'
 * @example stockStatus(0)       → 'out'
 * @example stockStatus(5, 5)    → 'low'  (inclusive threshold)
 * @example stockStatus(6, 5)    → 'ok'
 */
export function stockStatus(
  onHand: number | null | undefined,
  low: number = LOW_STOCK_DEFAULT,
): StockStatus {
  if (onHand === null || onHand === undefined) return 'untracked';
  if (onHand <= 0) return 'out';
  if (onHand <= low) return 'low';
  return 'ok';
}

/**
 * Total inventory value at cost (piastres) summed over products that are
 * tracked, costed, and have positive on-hand. Untracked / uncosted / non-positive
 * entries are ignored.
 */
export function inventoryValue(
  products: ValuedProduct[],
  levels: Record<string, number>,
): number {
  let value = 0;
  for (const p of products) {
    if (p.stock == null || p.cost == null) continue;
    const onHand = levels[p.id] ?? 0;
    if (onHand > 0) value += onHand * p.cost;
  }
  return value;
}
