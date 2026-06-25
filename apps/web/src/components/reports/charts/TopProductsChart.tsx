'use client';

/**
 * TopProductsChart — horizontal bar, top N products (design §6 C3).
 * Toggle: qty ↔ revenue. Bars grow from the right (RTL).
 * Product name at start, value at bar end (direct-labeling).
 * Arabic-Indic digits on axis ticks. All strings via i18n.
 */

import { useTranslations } from 'next-intl';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  LabelList,
} from 'recharts';
import { formatEgp, toArabicDigits } from '@ps/core';
import type { TopProductRow } from '../types';

const COLOR_BAR = '#14B8A6'; // chart-time teal
const COLOR_AXIS = '#94A3B8';
const TOP_N = 10;

type Toggle = 'qty' | 'revenue';

interface TopProductsChartProps {
  data: TopProductRow[];
  toggle: Toggle;
  height?: number;
}

export function TopProductsChart({ data, toggle, height = 280 }: TopProductsChartProps) {
  const t = useTranslations();

  // Take top N, sorted by the current toggle
  const sorted = [...data]
    .sort((a, b) => (toggle === 'revenue' ? b.revenue - a.revenue : b.qty - a.qty))
    .slice(0, TOP_N)
    .reverse(); // reverse so highest is at top in horizontal bar

  const chartData = sorted.map((row) => ({
    name: row.name,
    value: toggle === 'revenue' ? row.revenue : row.qty,
    _isRevenue: toggle === 'revenue',
  }));

  const formatTick = (val: number) =>
    toggle === 'revenue' ? toArabicDigits(String(Math.floor(val / 100))) : toArabicDigits(String(val));

  // Recharts 3: value may be undefined in the type union; guard at runtime.
  const tooltipFormatter = (value: unknown): [string, string] => {
    const num = typeof value === 'number' ? value : 0;
    if (toggle === 'revenue') return [formatEgp(num), t('chart.legend.time')];
    return [toArabicDigits(String(num)), t('chart.toggle.qty')];
  };

  return (
    <div dir="ltr" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={chartData}
          layout="vertical"
          margin={{ top: 0, right: 60, left: 8, bottom: 0 }}
          barSize={16}
        >
          <XAxis
            type="number"
            tickFormatter={formatTick}
            tick={{ fill: COLOR_AXIS, fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            type="category"
            dataKey="name"
            tick={{ fill: COLOR_AXIS, fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={100}
          />
          <Tooltip
            formatter={tooltipFormatter}
            contentStyle={{
              backgroundColor: '#131A26',
              border: '1px solid #1E293B',
              borderRadius: 8,
              color: '#EEF2F6',
              fontSize: 13,
            }}
            cursor={{ fill: 'rgba(148,163,184,0.08)' }}
          />
          <Bar dataKey="value" fill={COLOR_BAR} radius={[0, 4, 4, 0]}>
            <LabelList
              dataKey="value"
              position="right"
              formatter={(v: unknown) => {
                const num = typeof v === 'number' ? v : Number(v ?? 0);
                return toggle === 'revenue'
                  ? toArabicDigits(String(Math.floor(num / 100))) + ' ' + t('chart.axis.egp')
                  : toArabicDigits(String(num));
              }}
              style={{ fill: COLOR_AXIS, fontSize: 11 }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
