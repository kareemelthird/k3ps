/**
 * reports — pure time/range helpers for the owner dashboard (ADR-0007 Decision 5).
 * No money aggregation lives here: the piastre sums are exact integer Σ in SQL.
 */
export {
  type BusinessDayWindow,
  businessDayRange,
  daysInRange,
} from './report-helpers';
