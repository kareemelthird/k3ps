'use client';

/**
 * PaymentMixChart — donut for cash/wallet/other payment mix (design §6 C5).
 * `debt` is excluded (inert — ADR-0006 Decision 3 / design §2.2).
 * Center = settled total. Arabic-Indic digits. All strings via i18n.
 */

import { useTranslations } from 'next-intl';
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { formatEgp } from '@ps/core';
import type { PaymentMixRow } from '../types';

// Chart color tokens (design-system §10)
const PAYMENT_COLORS: Record<string, string> = {
  cash:    '#10B981', // chart-cash green
  wallet:  '#3B82F6', // chart-orders blue
  other:   '#64748B', // N400 neutral
  unknown: '#64748B',
};

interface PaymentMixChartProps {
  data: PaymentMixRow[];
  height?: number;
}

export function PaymentMixChart({ data, height = 240 }: PaymentMixChartProps) {
  const t = useTranslations();

  // Exclude 'debt' (inert this phase — ADR-0006 Decision 3)
  const filtered = data.filter((r) => r.payment_method !== 'debt');

  const slices = filtered.map((row) => ({
    name: row.payment_method,
    value: row.amount,
    color: PAYMENT_COLORS[row.payment_method] ?? '#64748B',
    label: t(`chart.legend.${row.payment_method}` as `chart.legend.${string}`) || row.payment_method,
  }));

  const total = slices.reduce((sum, s) => sum + s.value, 0);

  // Recharts 3: value/name may be undefined in the type union; guard at runtime.
  const tooltipFormatter = (value: unknown, name: unknown): [string, string] => {
    const num = typeof value === 'number' ? value : 0;
    const key = String(name ?? '');
    const slice = slices.find((s) => s.name === key);
    const pct = total > 0 ? ((num / total) * 100).toFixed(1) : '0';
    return [`${formatEgp(num)} (${pct}%)`, slice?.label ?? key];
  };

  return (
    <div dir="ltr" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={slices}
            cx="50%"
            cy="50%"
            innerRadius="55%"
            outerRadius="80%"
            dataKey="value"
            paddingAngle={2}
          >
            {slices.map((entry) => (
              <Cell key={entry.name} fill={entry.color} />
            ))}
          </Pie>
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
          <Legend
            formatter={(_value, entry) => {
              const e = entry as unknown as { payload: { label: string } };
              return e.payload?.label ?? _value;
            }}
            wrapperStyle={{ color: '#94A3B8', fontSize: 12 }}
          />
        </PieChart>
      </ResponsiveContainer>
      {/* Center label: settled total */}
      <div
        style={{ position: 'relative', marginTop: -(height * 0.68), height: height * 0.68 }}
        className="pointer-events-none flex flex-col items-center justify-center"
      >
        <p className="text-micro text-text-muted">{t('kpi.gross.label')}</p>
        <p className="text-label text-text font-bold tabular-nums">{formatEgp(total)}</p>
      </div>
    </div>
  );
}
