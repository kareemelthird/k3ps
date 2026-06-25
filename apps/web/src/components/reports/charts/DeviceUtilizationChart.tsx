'use client';

/**
 * DeviceUtilizationChart — horizontal bar per device (design §6 C4).
 * Primary: busy minutes. Secondary: util % of 24h (clearly labelled "% من ٢٤ ساعة").
 * ADR-0007 Decision 4: denominator is 24h × daysInRange — an approximation, not
 * opening-hours. The axis title makes this explicit so it is never misread.
 * Arabic-Indic digits. All strings via i18n.
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
import { toArabicDigits, daysInRange } from '@ps/core';
import type { ByDeviceRow } from '../types';

const COLOR_BAR  = '#3B82F6'; // chart-orders blue
const COLOR_AXIS = '#94A3B8';

interface DeviceUtilizationChartProps {
  data: ByDeviceRow[];
  fromKey: string;
  toKey: string;
  height?: number;
}

export function DeviceUtilizationChart({ data, fromKey, toKey, height = 240 }: DeviceUtilizationChartProps) {
  const t = useTranslations();

  const days = daysInRange(fromKey, toKey);
  const totalMinutes = days * 24 * 60;

  const sorted = [...data]
    .sort((a, b) => b.busy_minutes - a.busy_minutes)
    .slice(0, 10)
    .reverse();

  const chartData = sorted.map((row) => {
    const pct = totalMinutes > 0 ? (row.busy_minutes / totalMinutes) * 100 : 0;
    return {
      name: row.device_name,
      busyMinutes: row.busy_minutes,
      pct: Math.min(100, parseFloat(pct.toFixed(1))),
    };
  });

  // Recharts 3: value/name may be undefined in the type union; guard at runtime.
  const tooltipFormatter = (value: unknown, name: unknown): [string, string] => {
    const num = typeof value === 'number' ? value : 0;
    const key = String(name ?? '');
    if (key === 'pct') {
      return [toArabicDigits(num.toFixed(1)) + t('format.percentSuffix'), t('col.utilization')];
    }
    return [toArabicDigits(String(num)) + ' ' + t('format.duration.minutes'), t('col.busyMinutes')];
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
            domain={[0, 100]}
            tickFormatter={(v) => toArabicDigits(String(v)) + t('format.percentSuffix')}
            tick={{ fill: COLOR_AXIS, fontSize: 11 }}
            label={{
              value: t('chart.axis.utilizationOf24h'),
              position: 'insideBottom',
              offset: -2,
              fill: COLOR_AXIS,
              fontSize: 10,
            }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            type="category"
            dataKey="name"
            tick={{ fill: COLOR_AXIS, fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={90}
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
          <Bar dataKey="pct" fill={COLOR_BAR} radius={[0, 4, 4, 0]}>
            <LabelList
              dataKey="pct"
              position="right"
              formatter={(v: unknown) => {
                const num = typeof v === 'number' ? v : Number(v ?? 0);
                return toArabicDigits(num.toFixed(1)) + t('format.percentSuffix');
              }}
              style={{ fill: COLOR_AXIS, fontSize: 11 }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
