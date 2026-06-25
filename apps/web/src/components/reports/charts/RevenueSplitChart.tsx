'use client';

/**
 * RevenueSplitChart — donut showing time / orders / discount split (design §6 C2).
 * Center text = Gross (the headline figure = time + orders − discount).
 * Legend at start. All strings via i18n. Arabic-Indic digits. RTL.
 */

import { useTranslations } from 'next-intl';
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { formatEgp, toArabicDigits } from '@ps/core';

// Chart color tokens (design-system §10)
const COLOR_TIME     = '#14B8A6';
const COLOR_ORDERS   = '#3B82F6';
const COLOR_DISCOUNT = '#F59E0B';

interface RevenueSplitChartProps {
  timeTotal: number;     // piastres
  ordersTotal: number;   // piastres
  discount: number;      // piastres
  gross: number;         // piastres (= time + orders − discount)
  height?: number;
}

export function RevenueSplitChart({
  timeTotal,
  ordersTotal,
  discount,
  gross,
  height = 240,
}: RevenueSplitChartProps) {
  const t = useTranslations();

  const slices = [
    { name: 'time',     value: Math.max(0, timeTotal),   color: COLOR_TIME,     label: t('chart.legend.time') },
    { name: 'orders',   value: Math.max(0, ordersTotal), color: COLOR_ORDERS,   label: t('chart.legend.orders') },
    { name: 'discount', value: Math.max(0, discount),    color: COLOR_DISCOUNT, label: t('chart.legend.discount') },
  ].filter((s) => s.value > 0);

  // Recharts 3: value/name may be undefined in the type union; guard at runtime.
  const tooltipFormatter = (value: unknown, name: unknown): [string, string] => {
    const num = typeof value === 'number' ? value : 0;
    const key = String(name ?? '');
    const slice = slices.find((s) => s.name === key);
    return [formatEgp(num), slice?.label ?? key];
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
              const dataEntry = entry as unknown as { payload: { name: string; label: string } };
              return dataEntry.payload?.label ?? _value;
            }}
            wrapperStyle={{ color: '#94A3B8', fontSize: 12 }}
          />
          {/* Center label via foreignObject trick */}
        </PieChart>
      </ResponsiveContainer>
      {/* Gross overlay (centered over the donut hole) */}
      <div
        style={{ position: 'relative', marginTop: -(height * 0.72), height: height * 0.72 }}
        className="pointer-events-none flex flex-col items-center justify-center"
      >
        <p className="text-micro text-text-muted">{t('kpi.gross.label')}</p>
        <p className="text-label text-text font-bold tabular-nums">{formatEgp(gross)}</p>
      </div>
    </div>
  );
}
