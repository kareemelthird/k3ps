'use client';

/**
 * PaymentMixChart — donut for cash/wallet/other payment mix (design §6 C5).
 * `debt` is excluded (inert — ADR-0006 Decision 3 / design §2.2).
 * Center = settled total. Arabic-Indic digits. All strings via i18n.
 *
 * Fix (design-uplift): center overlay uses position:absolute (ring always visible).
 * Placeholder ring renders when there is no data (chart-track color).
 * null/undefined payment methods are normalised to 'unknown'.
 * 'unknown' and 'debt' translation keys added to ar.json §chart.legend.
 */

import { useTranslations } from 'next-intl';
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { formatEgp, toArabicDigits } from '@ps/core';
import type { PaymentMixRow } from '../types';

// Chart color tokens (design-system §10)
const PAYMENT_COLORS: Record<string, string> = {
  cash:    '#10B981', // chart-cash green
  wallet:  '#3B82F6', // chart-orders blue
  other:   '#64748B', // N400 neutral
  unknown: '#64748B', // same neutral — normalised unknown methods
};
const COLOR_TRACK = '#1E293B'; // chart-track: N700

interface PaymentMixChartProps {
  data: PaymentMixRow[];
  height?: number;
}

export function PaymentMixChart({ data, height = 240 }: PaymentMixChartProps) {
  const t = useTranslations();

  // Exclude 'debt' (inert this phase — ADR-0006 Decision 3).
  // Guard against blank/unknown methods from the database.
  const slices = data
    .filter((r) => r.payment_method !== 'debt')
    .map((row) => {
      const method = row.payment_method || 'unknown';
      const labelKey = `chart.legend.${method}` as Parameters<typeof t>[0];
      return {
        name:  method,
        value: row.amount,
        color: PAYMENT_COLORS[method] ?? '#64748B',
        label: (t(labelKey) as string) || method,
      };
    })
    .filter((s) => s.value > 0);

  const hasData = slices.length > 0;
  const total = slices.reduce((sum, s) => sum + s.value, 0);

  // Placeholder ring when no data
  const plotSlices = hasData
    ? slices
    : [{ name: '_empty', value: 1, color: COLOR_TRACK, label: '' }];

  const tooltipFormatter = (value: unknown, name: unknown): [string, string] => {
    const num = typeof value === 'number' ? value : 0;
    const key = String(name ?? '');
    const slice = slices.find((s) => s.name === key);
    const pctRaw = total > 0 ? ((num / total) * 100).toFixed(1) : '0.0';
    const pct = toArabicDigits(pctRaw);
    return [`${formatEgp(num)} (${pct}٪)`, slice?.label ?? key];
  };

  return (
    <div dir="ltr" style={{ height, position: 'relative' }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={plotSlices}
            cx="50%"
            cy="50%"
            innerRadius="55%"
            outerRadius="80%"
            dataKey="value"
            paddingAngle={hasData ? 2 : 0}
            isAnimationActive={false}
          >
            {plotSlices.map((entry) => (
              <Cell key={entry.name} fill={entry.color} />
            ))}
          </Pie>
          {hasData && (
            <Tooltip
              formatter={tooltipFormatter}
              contentStyle={{
                backgroundColor: '#131A26',
                border: '1px solid #1E293B',
                borderRadius: 8,
                color: '#EEF2F6',
                fontSize: 13,
              }}
            />
          )}
          {hasData && (
            <Legend
              formatter={(_value, entry) => {
                const e = entry as unknown as { payload: { label: string } };
                return e.payload?.label ?? _value;
              }}
              wrapperStyle={{ color: '#94A3B8', fontSize: 12 }}
            />
          )}
        </PieChart>
      </ResponsiveContainer>

      {/* Settled total — centered over the donut hole via absolute overlay */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: hasData ? '30%' : 0,
        }}
        className="pointer-events-none flex flex-col items-center justify-center"
      >
        <p className="text-micro text-text-muted">{t('kpi.gross.label')}</p>
        <p className="text-label text-text font-bold tabular-nums">{formatEgp(total)}</p>
      </div>
    </div>
  );
}
