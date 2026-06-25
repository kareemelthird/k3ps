'use client';

/**
 * RevenueOverTimeChart — stacked vertical bar, one bar per business day (design §6 C1).
 * Stacks: time (teal) + orders (blue).
 * RTL: XAxis reversed so earliest day is at the right (natural RTL time flow).
 * Arabic-Indic digits on ticks/tooltips via tickFormatter.
 * All strings via i18n.
 *
 * Note: The chart container uses dir="ltr" for SVG compatibility; RTL is achieved
 * through XAxis reversed + sorted data (oldest first → reversed shows oldest at right).
 */

import { useTranslations } from 'next-intl';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { toArabicDigits, formatEgp } from '@ps/core';
import type { RevenueByDayRow } from '../types';

// Chart color tokens (design-system §10)
const COLOR_TIME   = '#14B8A6';
const COLOR_ORDERS = '#3B82F6';
const COLOR_GRID   = '#1E293B';
const COLOR_AXIS   = '#94A3B8';

/** Format a YYYY-MM-DD key as a short Arabic date label "١٢/٦" */
function shortDateAr(key: string): string {
  const d = new Date(`${key}T00:00:00Z`);
  const day = toArabicDigits(String(d.getUTCDate()));
  const month = toArabicDigits(String(d.getUTCMonth() + 1));
  return `${day}/${month}`;
}

/** Format piastres as EGP with Arabic-Indic digits (no suffix for tight axis) */
function tickEgp(val: number): string {
  if (val >= 100_000_00) return toArabicDigits((val / 100_000_00).toFixed(1)) + 'م';  // millions
  if (val >= 100_000)   return toArabicDigits((val / 100_000).toFixed(0)) + 'أ'; // thousands
  return toArabicDigits(String(Math.floor(val / 100))); // raw EGP pounds
}

interface RevenueOverTimeChartProps {
  data: RevenueByDayRow[];
  height?: number;
}

export function RevenueOverTimeChart({ data, height = 240 }: RevenueOverTimeChartProps) {
  const t = useTranslations();

  // Sort ascending (oldest first); with reversed XAxis, oldest appears at right (RTL)
  const sorted = [...data].sort((a, b) => a.business_day.localeCompare(b.business_day));

  const chartData = sorted.map((row) => ({
    day: row.business_day,
    dayLabel: shortDateAr(row.business_day),
    time: row.time_total,
    orders: row.orders_total,
  }));

  // Recharts 3: value/name may be undefined in the type union; guard at runtime.
  const tooltipFormatter = (value: unknown, name: unknown): [string, string] => {
    const num = typeof value === 'number' ? value : 0;
    const key = String(name ?? '');
    const label = key === 'time' ? t('chart.legend.time') : t('chart.legend.orders');
    return [formatEgp(num), label];
  };

  const labelFormatter = (label: unknown): string => {
    const key = typeof label === 'string' ? label : String(label ?? '');
    const d = new Date(`${key}T00:00:00Z`);
    const formatted = new Intl.DateTimeFormat('ar-EG', { day: 'numeric', month: 'long' }).format(d);
    return toArabicDigits(formatted);
  };

  return (
    <div dir="ltr" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={COLOR_GRID} vertical={false} />
          <XAxis
            dataKey="day"
            reversed
            tickFormatter={(val) => shortDateAr(val as string)}
            tick={{ fill: COLOR_AXIS, fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tickFormatter={tickEgp}
            tick={{ fill: COLOR_AXIS, fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={50}
          />
          <Tooltip
            formatter={tooltipFormatter}
            labelFormatter={labelFormatter}
            contentStyle={{
              backgroundColor: '#131A26',
              border: '1px solid #1E293B',
              borderRadius: 8,
              color: '#EEF2F6',
              fontSize: 13,
            }}
            cursor={{ fill: 'rgba(148,163,184,0.08)' }}
          />
          <Legend
            formatter={(value) =>
              value === 'time' ? t('chart.legend.time') : t('chart.legend.orders')
            }
            wrapperStyle={{ color: COLOR_AXIS, fontSize: 12 }}
          />
          <Bar dataKey="time"   name="time"   stackId="a" fill={COLOR_TIME}   radius={[0, 0, 0, 0]} />
          <Bar dataKey="orders" name="orders" stackId="a" fill={COLOR_ORDERS} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
