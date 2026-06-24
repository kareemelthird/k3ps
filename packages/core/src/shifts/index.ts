/**
 * shifts — cash-drawer reconciliation (ADR-0006 Decision 3).
 *
 * `difference` is un-clamped: negative = shortage, positive = over. Integer
 * piastres; pure; no querying (the caller supplies CASH-settled `cash_sales`).
 */
export {
  type ShiftReconciliationInput,
  type ShiftReconciliation,
  computeShiftReconciliation,
} from './reconciliation';
