'use client';

/**
 * KpiRow — five KPI cards in a row (design-system phase-6 §5).
 * Layout: 5 cols on desktop ≥1024, 2 cols on tablet 768-1023, 1 col on mobile.
 * Cards: Gross · Time · Orders · Discounts · Cash
 * No double-count: Gross is the headline; Time + Orders − Discounts are its parts.
 * All money via @ps/core formatEgp. RTL. i18n.
 */

import { useTranslations } from 'next-intl';
import { toArabicDigits } from '@ps/core';
import { KpiCard } from './KpiCard';
import type { KpiTotals } from './types';

// Chart color tokens (design-system §10, phase-6 §12)
const ACCENT = {
  gross:     '#14B8A6', // chart-time (teal, brand primary)
  time:      '#14B8A6', // chart-time
  orders:    '#3B82F6', // chart-orders
  discounts: '#F59E0B', // chart-discount
  cash:      '#10B981', // chart-cash
};

interface KpiRowProps {
  totals: KpiTotals | null;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
}

export function KpiRow({ totals, loading = false, error = false, onRetry }: KpiRowProps) {
  const t = useTranslations();

  const gross     = totals?.gross ?? 0;
  const timeTotal = totals?.timeTotal ?? 0;
  const orders    = totals?.ordersTotal ?? 0;
  const discount  = totals?.discount ?? 0;
  const sessions  = totals?.sessionCount ?? 0;
  const walkins   = totals?.walkinOrderCount ?? 0;
  const cash      = totals?.cashRevenue ?? 0;

  // Cash % of gross (Arabic-Indic, one decimal)
  const cashPct = gross > 0 ? ((cash / gross) * 100).toFixed(1) : '0.0';
  const cashPctAr = toArabicDigits(cashPct);

  // Qty sold: sum of walkin + session-attached order counts is not directly available
  // per day — the top-products qty comes from the products RPC. Here we approximate
  // using session + walkin counts for the KPI sub-lines.
  const sessionsAr = toArabicDigits(String(sessions));
  const walkinsAr  = toArabicDigits(String(walkins));

  return (
    <section aria-label={t('reports.title')}>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-sm">
        {/* 1. Gross — the headline number */}
        <KpiCard
          labelKey="kpi.gross.label"
          subKey="kpi.gross.sub"
          subParams={{ sessions: sessionsAr, walkins: walkinsAr }}
          valuePiastres={gross}
          accentColor={ACCENT.gross}
          loading={loading}
          error={error}
          onRetry={onRetry}
        />

        {/* 2. Time revenue */}
        <KpiCard
          labelKey="kpi.time.label"
          subKey="kpi.time.sub"
          subParams={{ n: sessionsAr }}
          valuePiastres={timeTotal}
          accentColor={ACCENT.time}
          loading={loading}
          error={error}
          onRetry={onRetry}
        />

        {/* 3. Orders revenue */}
        <KpiCard
          labelKey="kpi.orders.label"
          subKey="kpi.orders.sub"
          subParams={{ k: walkinsAr }}
          valuePiastres={orders}
          accentColor={ACCENT.orders}
          loading={loading}
          error={error}
          onRetry={onRetry}
        />

        {/* 4. Discounts */}
        <KpiCard
          labelKey="kpi.discounts.label"
          subKey="kpi.discounts.sub"
          subParams={{ n: sessionsAr }}
          valuePiastres={discount}
          accentColor={ACCENT.discounts}
          loading={loading}
          error={error}
          onRetry={onRetry}
        />

        {/* 5. Cash */}
        <KpiCard
          labelKey="kpi.cash.label"
          subKey="kpi.cash.sub"
          subParams={{ pct: cashPctAr }}
          valuePiastres={cash}
          accentColor={ACCENT.cash}
          loading={loading}
          error={error}
          onRetry={onRetry}
        />
      </div>
    </section>
  );
}
