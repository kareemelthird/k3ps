/**
 * TypeScript interfaces for the Phase 6 reporting RPC row shapes.
 * Exactly matches the SQL function return types in 0007_reporting_functions.sql.
 * All money fields are integer piastres (bigint in SQL → number in JS client).
 * ADR-0007.
 */

/** Row returned by report_revenue_by_day */
export interface RevenueByDayRow {
  business_day: string;
  time_total: number;
  orders_total: number;
  discount: number;
  gross: number;
  session_count: number;
  walkin_order_count: number;
}

/** Row returned by report_by_device */
export interface ByDeviceRow {
  device_id: string;
  device_name: string;
  busy_minutes: number;
  session_count: number;
  revenue: number;
}

/** Row returned by report_top_products */
export interface TopProductRow {
  product_id: string;
  name: string;
  category: string | null;
  qty: number;
  revenue: number;
  cost: number | null;
}

/** Row returned by report_payment_mix */
export interface PaymentMixRow {
  payment_method: string;
  amount: number;
  txn_count: number;
}

/** Row returned by report_shifts */
export interface ShiftRow {
  shift_id: string;
  business_day: string;
  opened_at: string;
  closed_at: string;
  opening_cash: number;
  expected_cash: number;
  actual_cash: number;
  difference: number;
  manager_id: string;
}

/** All report data fetched for the current scope */
export interface ReportsData {
  revenueByDay: RevenueByDayRow[];
  byDevice: ByDeviceRow[];
  topProducts: TopProductRow[];
  paymentMix: PaymentMixRow[];
  shifts: ShiftRow[];
}

/** Derived KPI totals summed over the scope (from revenueByDay rows) */
export interface KpiTotals {
  gross: number;
  timeTotal: number;
  ordersTotal: number;
  discount: number;
  sessionCount: number;
  walkinOrderCount: number;
  cashRevenue: number;
}

/** Scope: the date range + branch filter that drives every report query */
export interface Scope {
  fromKey: string;
  toKey: string;
  preset: RangePreset;
  branchId: string | null; // null = all branches
}

export type RangePreset =
  | 'today'
  | 'yesterday'
  | 'last7'
  | 'thisMonth'
  | 'lastMonth'
  | 'custom';
