'use client';

/**
 * ReportsView — main orchestrator for the Phase 6 reports dashboard (ADR-0007).
 *
 * Contract:
 *   - Fetches cutover_hour from settings (key='business_day') at mount.
 *   - Fetches branches for the scope filter at mount.
 *   - Default scope: last 7 business days, all branches.
 *   - Calls 5 reporting RPCs in parallel whenever scope changes.
 *   - All money via @ps/core (formatEgp). No client-side re-derivation.
 *   - Shift difference sum is client-side (ADR-0007 Decision 1 sanctioned exception).
 *   - CSV export reads the same data as on-screen numbers (AC 21).
 *   - RTL layout. All strings via i18n.
 *
 * Security (CLAUDE.md §5 / HARD RULE):
 *   - Uses anon/publishable Supabase key only.
 *   - All RLS + RPC owner-gate enforce tenant isolation server-side.
 *   - tenant_id is never sent from client — it comes from the signed JWT claim.
 *   - Branch filter is UX, not a security boundary (security is RLS + RPC gate).
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import {
  businessDayKey,
  businessDayRange,
  nowIso,
  DEFAULT_CUTOVER_HOUR,
  CAFE_TZ,
  toArabicDigits,
} from '@ps/core';
import { getBrowserClient } from '@/lib/supabase/client';
import { useAuth } from '@/lib/auth/AuthContext';
import { ScopeBar } from './ScopeBar';
import { KpiRow } from './KpiRow';
import { ChartCard } from './ChartCard';
import { ReportTabs } from './ReportTabs';
import { RevenueOverTimeChart } from './charts/RevenueOverTimeChart';
import { RevenueSplitChart } from './charts/RevenueSplitChart';
import { TopProductsChart } from './charts/TopProductsChart';
import { DeviceUtilizationChart } from './charts/DeviceUtilizationChart';
import { PaymentMixChart } from './charts/PaymentMixChart';
import { ByDayTable, ByDeviceTable, ByProductTable, ByShiftTable } from './ReportTable';
import type { Branch } from '@ps/core';
import type {
  RevenueByDayRow,
  ByDeviceRow,
  TopProductRow,
  PaymentMixRow,
  ShiftRow,
  KpiTotals,
  Scope,
} from './types';
import type { ReportTab } from './ReportTabs';

// ── Date helpers (pure, no dayjs — avoids server-bundle duplication) ──────────

/** Subtract n calendar days from a YYYY-MM-DD key, returns YYYY-MM-DD. */
function subtractDays(key: string, n: number): string {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Compute the default scope (last 7 business days, all branches). */
function defaultScope(cutoverHour: number): Scope {
  const todayKey = businessDayKey(nowIso(), cutoverHour, CAFE_TZ);
  return {
    fromKey: subtractDays(todayKey, 6), // inclusive — 7 days total
    toKey: todayKey,
    preset: 'last7',
    branchId: null,
  };
}

// ── KPI derivation ────────────────────────────────────────────────────────────

/** Derive KpiTotals from raw RPC data. No float money math — only integer sums. */
function computeKpiTotals(
  revenueByDay: RevenueByDayRow[],
  paymentMix: PaymentMixRow[],
): KpiTotals {
  const totals = revenueByDay.reduce(
    (acc, r) => ({
      gross: acc.gross + r.gross,
      timeTotal: acc.timeTotal + r.time_total,
      ordersTotal: acc.ordersTotal + r.orders_total,
      discount: acc.discount + r.discount,
      sessionCount: acc.sessionCount + r.session_count,
      walkinOrderCount: acc.walkinOrderCount + r.walkin_order_count,
    }),
    { gross: 0, timeTotal: 0, ordersTotal: 0, discount: 0, sessionCount: 0, walkinOrderCount: 0 },
  );

  const cashRow = paymentMix.find((r) => r.payment_method === 'cash');
  const cashRevenue = cashRow?.amount ?? 0;

  return { ...totals, cashRevenue };
}

// ── ReportsView ───────────────────────────────────────────────────────────────

export function ReportsView() {
  const t = useTranslations();
  const { claim } = useAuth();

  // ── Settings + branches (fetched once at mount) ───────────────────────────

  const [cutoverHour, setCutoverHour] = useState<number>(DEFAULT_CUTOVER_HOUR);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  // ── Scope state ───────────────────────────────────────────────────────────

  const [scope, setScope] = useState<Scope>(() => defaultScope(DEFAULT_CUTOVER_HOUR));

  // ── Report data ───────────────────────────────────────────────────────────

  const [revenueByDay, setRevenueByDay] = useState<RevenueByDayRow[]>([]);
  const [byDevice, setByDevice] = useState<ByDeviceRow[]>([]);
  const [topProducts, setTopProducts] = useState<TopProductRow[]>([]);
  const [paymentMix, setPaymentMix] = useState<PaymentMixRow[]>([]);
  const [shifts, setShifts] = useState<ShiftRow[]>([]);

  const [dataLoading, setDataLoading] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);

  // ── UI state ──────────────────────────────────────────────────────────────

  const [activeTab, setActiveTab] = useState<ReportTab>('byDay');
  const [productToggle, setProductToggle] = useState<'qty' | 'revenue'>('revenue');

  // ── Fetch settings + branches on mount ───────────────────────────────────

  useEffect(() => {
    if (!claim) return;

    async function fetchMeta() {
      try {
        const supabase = getBrowserClient();

        // Parallel: settings + branches
        const [settingsResult, branchesResult] = await Promise.all([
          supabase
            .from('settings')
            .select('value')
            .eq('key', 'business_day')
            .single(),
          supabase
            .from('branches')
            .select('*')
            .eq('is_active', true)
            .order('name', { ascending: true }),
        ]);

        // Parse cutover_hour (defaults to 6 if missing)
        const settingsValue = settingsResult.data?.value as { cutover_hour?: number } | null;
        const fetchedCutover = settingsValue?.cutover_hour ?? DEFAULT_CUTOVER_HOUR;

        setCutoverHour(fetchedCutover);
        setBranches((branchesResult.data as Branch[]) ?? []);
        setSettingsLoaded(true);

        // Re-derive default scope if cutoverHour differs (affects 'today'/'yesterday' only)
        if (fetchedCutover !== DEFAULT_CUTOVER_HOUR) {
          setScope((prev) => {
            if (prev.preset === 'custom') return prev; // user already customised — don't overwrite
            return defaultScope(fetchedCutover);
          });
        }
      } catch {
        // Non-blocking; defaults remain in place
        setSettingsLoaded(true);
      }
    }

    void fetchMeta();
  }, [claim]);

  // ── Fetch report data whenever scope or cutoverHour changes ───────────────

  const fetchData = useCallback(async () => {
    if (!claim || !settingsLoaded) return;

    setDataLoading(true);
    setDataError(null);

    const { fromIso, toIso } = businessDayRange(
      scope.fromKey,
      scope.toKey,
      cutoverHour,
      CAFE_TZ,
    );

    try {
      const supabase = getBrowserClient();

      const params = {
        p_from:    fromIso,
        p_to:      toIso,
        p_branch:  scope.branchId,
        p_cutover: cutoverHour,
      };

      const [r1, r2, r3, r4, r5] = await Promise.all([
        supabase.rpc('report_revenue_by_day', params),
        supabase.rpc('report_by_device',      params),
        supabase.rpc('report_top_products',   params),
        supabase.rpc('report_payment_mix',    params),
        supabase.rpc('report_shifts',         params),
      ]);

      // Surface the first error
      const firstError = [r1, r2, r3, r4, r5].find((r) => r.error)?.error;
      if (firstError) {
        setDataError(firstError.message ?? t('state.error.generic'));
        return;
      }

      setRevenueByDay((r1.data as RevenueByDayRow[]) ?? []);
      setByDevice((r2.data as ByDeviceRow[]) ?? []);
      setTopProducts((r3.data as TopProductRow[]) ?? []);
      setPaymentMix((r4.data as PaymentMixRow[]) ?? []);
      setShifts((r5.data as ShiftRow[]) ?? []);
    } catch (err) {
      setDataError(err instanceof Error ? err.message : t('state.error.generic'));
    } finally {
      setDataLoading(false);
    }
  }, [claim, settingsLoaded, scope, cutoverHour, t]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  // ── Derived ───────────────────────────────────────────────────────────────

  const kpiTotals = computeKpiTotals(revenueByDay, paymentMix);

  const hasAnyData = revenueByDay.length > 0 || byDevice.length > 0
    || topProducts.length > 0 || paymentMix.length > 0 || shifts.length > 0;

  // Aggregate totals for RevenueSplitChart (summed from revenueByDay)
  const splitTimeTotal   = revenueByDay.reduce((s, r) => s + r.time_total, 0);
  const splitOrdersTotal = revenueByDay.reduce((s, r) => s + r.orders_total, 0);
  const splitDiscount    = revenueByDay.reduce((s, r) => s + r.discount, 0);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-xl">
      {/* ── Page header ────────────────────────────────────────────────────── */}
      <div className="space-y-2xs">
        <h1 className="text-h1 text-text">{t('reports.title')}</h1>
        <p className="text-label text-text-muted">{t('reports.subtitle')}</p>
      </div>

      {/* ── Scope bar (date range + branch filter) ──────────────────────── */}
      <ScopeBar
        scope={scope}
        branches={branches}
        cutoverHour={cutoverHour}
        onScopeChange={setScope}
        loading={dataLoading}
      />

      {/* ── KPI cards ───────────────────────────────────────────────────── */}
      <KpiRow
        totals={hasAnyData ? kpiTotals : null}
        loading={dataLoading}
        error={!!dataError}
        onRetry={() => void fetchData()}
      />

      {/* ── Chart grid (2×2 + 1) ────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-md">
        {/* C1: Revenue over time */}
        <ChartCard
          titleKey="chart.revenueOverTime.title"
          summaryKey="chart.summary.revenueOverTime"
          loading={dataLoading}
          error={dataError}
          onRetry={() => void fetchData()}
          empty={!dataLoading && !dataError && revenueByDay.length === 0}
        >
          <RevenueOverTimeChart data={revenueByDay} />
        </ChartCard>

        {/* C2: Revenue split (donut) */}
        <ChartCard
          titleKey="chart.revenueSplit.title"
          summaryKey="chart.summary.revenueSplit"
          loading={dataLoading}
          error={dataError}
          onRetry={() => void fetchData()}
          empty={!dataLoading && !dataError && revenueByDay.length === 0}
        >
          <RevenueSplitChart
            timeTotal={splitTimeTotal}
            ordersTotal={splitOrdersTotal}
            discount={splitDiscount}
            gross={kpiTotals.gross}
          />
        </ChartCard>

        {/* C3: Top products (with qty/revenue toggle) */}
        <ChartCard
          titleKey="chart.topProducts.title"
          summaryKey="chart.summary.topProducts"
          loading={dataLoading}
          error={dataError}
          onRetry={() => void fetchData()}
          empty={!dataLoading && !dataError && topProducts.length === 0}
          toggle={
            <div className="flex gap-2xs bg-surface-2 rounded-xs p-2xs">
              {(['revenue', 'qty'] as const).map((opt) => (
                <button
                  key={opt}
                  type="button"
                  aria-pressed={productToggle === opt}
                  onClick={() => setProductToggle(opt)}
                  className={`px-sm py-xs rounded-xs text-caption font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary
                    ${productToggle === opt ? 'bg-surface text-primary shadow-e0' : 'text-text-muted hover:text-text'}`}
                >
                  {opt === 'revenue' ? t('chart.toggle.revenue') : t('chart.toggle.qty')}
                </button>
              ))}
            </div>
          }
        >
          <TopProductsChart data={topProducts} toggle={productToggle} />
        </ChartCard>

        {/* C4: Device utilization */}
        <ChartCard
          titleKey="chart.deviceUtilization.title"
          summaryKey="chart.summary.deviceUtilization"
          loading={dataLoading}
          error={dataError}
          onRetry={() => void fetchData()}
          empty={!dataLoading && !dataError && byDevice.length === 0}
        >
          <DeviceUtilizationChart
            data={byDevice}
            fromKey={scope.fromKey}
            toKey={scope.toKey}
          />
        </ChartCard>
      </div>

      {/* C5: Payment mix (full-width) */}
      <ChartCard
        titleKey="chart.paymentMix.title"
        summaryKey="chart.summary.paymentMix"
        loading={dataLoading}
        error={dataError}
        onRetry={() => void fetchData()}
        empty={!dataLoading && !dataError && paymentMix.length === 0}
      >
        <PaymentMixChart data={paymentMix} />
      </ChartCard>

      {/* ── Report table tabs ────────────────────────────────────────────── */}
      <div className="space-y-md">
        <ReportTabs active={activeTab} onChange={setActiveTab} />

        {/* Active table panel */}
        {activeTab === 'byDay' && (
          <ByDayTable
            data={revenueByDay}
            loading={dataLoading}
            error={dataError}
            onRetry={() => void fetchData()}
          />
        )}
        {activeTab === 'byDevice' && (
          <ByDeviceTable
            data={byDevice}
            fromKey={scope.fromKey}
            toKey={scope.toKey}
            loading={dataLoading}
            error={dataError}
            onRetry={() => void fetchData()}
          />
        )}
        {activeTab === 'byProduct' && (
          <ByProductTable
            data={topProducts}
            loading={dataLoading}
            error={dataError}
            onRetry={() => void fetchData()}
          />
        )}
        {activeTab === 'byShift' && (
          <ByShiftTable
            data={shifts}
            loading={dataLoading}
            error={dataError}
            onRetry={() => void fetchData()}
          />
        )}
      </div>

      {/* ── Refresh hint ─────────────────────────────────────────────────── */}
      {!dataLoading && hasAnyData && (
        <div className="flex items-center justify-end gap-sm">
          <p className="text-caption text-text-faint">
            {t('reports.lastUpdated', {
              time: toArabicDigits(
                new Intl.DateTimeFormat('ar-EG', {
                  hour: 'numeric',
                  minute: '2-digit',
                  timeZone: CAFE_TZ,
                }).format(new Date()),
              ),
            })}
          </p>
          <button
            type="button"
            onClick={() => void fetchData()}
            className="text-caption text-primary hover:text-primary/80 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-xs"
          >
            {t('reports.refresh')}
          </button>
        </div>
      )}
    </div>
  );
}
