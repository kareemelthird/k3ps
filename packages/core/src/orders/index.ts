/**
 * orders — void-aware exact-integer order/session aggregation (ADR-0006).
 *
 * Produces the `orders_total` the (unchanged) pricing engine folds into a
 * session's `grand_total`. Integer piastres; no rounding (Decision 8); pure.
 */
export {
  type OrderLineInput,
  type OrderRollupInput,
  computeOrderTotal,
  computeOrdersTotalForSession,
} from './order-total';
