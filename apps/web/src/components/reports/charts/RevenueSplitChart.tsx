'use client';

/**
 * RevenueSplitChart — donut showing time / orders / discount split (design §6 C2).
 * Center text = Gross (the headline figure = time + orders − discount).
 * Legend at start. All strings via i18n. Arabic-Indic digits. RTL.
 *
 * Fix (design-uplift): center overlay now uses position:absolute so the donut ring
 * is always visible. Placeholder ring renders when all values are zero (empty state
 * shows the ring outline in chart-track color per design §10.6).
 */

import { useTranslations } from 'next-intl';
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { formatEgp } from '@ps/core';

// Chart color tokens (design-system §10)
const COLOR_TIME     = '#14B8A6';
const COLOR_ORDERS   = '#3B82F6';
const COLOR_DISCOUNT = '#F59E0B';
const COLOR_TRACK    = '#1E293B'; // chart-track: N700

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

  const hasData = slices.length > 0;

  // When all values are zero show a calm placeholder ring in chart-track color
  // (design §10.6: "a drawn, labelled, zeroed frame") — never a blank box.
  const plotSlices = hasData
    ? slices
    : [{ name: '_empty', value: 1, color: COLOR_TRACK, label: '' }];

  const tooltipFormatter = (value: unknown, name: unknown): [string, string] => {
    const num = typeof value === 'number' ? value : 0;
    const key = String(name ?? '');
    const slice = slices.find((s) => s.name === key);
    return [formatEgp(num), slice?.label ?? key];
  };

  return (
    // position:relative wraps both the chart and the absolute center overlay
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
            isAnimationActive={hasData}
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
                const dataEntry = entry as unknown as { payload: { name: string; label: string } };
                return dataEntry.payload?.label ?? _value;
              }}
              wrapperStyle={{ color: '#94A3B8', fontSize: 12 }}
            />
          )}
        </PieChart>
      </ResponsiveContainer>

      {/* Gross total — centered over the donut hole via absolute overlay */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          // Limit to chart area above the legend (roughly 70% of height)
          bottom: hasData ? '30%' : 0,
        }}
        className="pointer-events-none flex flex-col items-center justify-center"
      >
        <p className="text-micro text-text-muted">{t('kpi.gross.label')}</p>
        <p className="text-label text-text font-bold tabular-nums">{formatEgp(gross)}</p>
      </div>
    </div>
  );
}
