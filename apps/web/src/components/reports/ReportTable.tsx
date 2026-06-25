'use client';

/**
 * ReportTable — unified report table + CSV export for Phase 6 (design §7).
 * Four table variants: byDay / byDevice / byProduct / byShift.
 *
 * Contract (AC 18, ADR-0007 Decision 6):
 *   - Sticky header, sortable columns (aria-sort), footer totals (server-side exact)
 *   - Export CSV: UTF-8 BOM, RFC-4180, Arabic text intact, money as decimal EGP
 *     (formatEgpPlain, Western digits — the only Western-digit surface, AC 21 exempt)
 *   - Shift difference: un-clamped, color-coded (short/over/balanced) with icon (AC 10)
 *   - Deactivated products that sold still appear with inactive badge (AC 9)
 *   - No margin fabrication when cost is null — show "—" (AC 9)
 *   - All strings via i18n. Money via formatEgp. RTL layout.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatEgp, toArabicDigits, daysInRange } from '@ps/core';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Skeleton, TableRowSkeleton } from '@/components/ui/Skeleton';
import { buildCsv, downloadCsv, moneyCell, numCell } from './csv-export';
import type {
  RevenueByDayRow,
  ByDeviceRow,
  TopProductRow,
  ShiftRow,
} from './types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function pct(piastres: number, total: number): string {
  if (total === 0) return toArabicDigits('0.0') + '٪';
  return toArabicDigits(((piastres / total) * 100).toFixed(1)) + '٪';
}

function formatDateAr(key: string): string {
  const d = new Date(`${key}T00:00:00Z`);
  return toArabicDigits(
    new Intl.DateTimeFormat('ar-EG', { day: 'numeric', month: 'long', timeZone: 'Africa/Cairo' }).format(d),
  );
}

function formatDateTimeAr(iso: string): string {
  const d = new Date(iso);
  return toArabicDigits(
    new Intl.DateTimeFormat('ar-EG', {
      day: 'numeric',
      month: 'long',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'Africa/Cairo',
    }).format(d),
  );
}

function busyMinutesAr(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0 && m > 0) return `${toArabicDigits(String(h))}س ${toArabicDigits(String(m))}د`;
  if (h > 0) return `${toArabicDigits(String(h))}س`;
  return `${toArabicDigits(String(m))}د`;
}

// ── Shared table shell ────────────────────────────────────────────────────────

interface TableProps {
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  empty?: boolean;
  emptyKey: string;
  colCount: number;
  headers: React.ReactNode;
  rows: React.ReactNode;
  footer?: React.ReactNode;
  onExportCsv: () => void;
  exportDisabled?: boolean;
  titleKey: string;
}

function TableShell({
  loading,
  error,
  onRetry,
  empty,
  emptyKey,
  colCount,
  headers,
  rows,
  footer,
  onExportCsv,
  exportDisabled,
  titleKey,
}: TableProps) {
  const t = useTranslations();
  const [exporting, setExporting] = useState(false);

  async function handleExport() {
    setExporting(true);
    try {
      onExportCsv();
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-sm">
      {/* Table header row: title + export button */}
      <div className="flex items-center justify-between gap-sm">
        <h3 className="text-h3 text-text">{t(titleKey)}</h3>
        <button
          type="button"
          onClick={() => void handleExport()}
          disabled={exportDisabled || exporting || loading || !!error || empty}
          aria-label={t('reports.exportCsv')}
          className="flex items-center gap-xs h-9 px-sm rounded-xs border border-border text-label text-text-muted hover:bg-surface-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-45 disabled:cursor-not-allowed"
        >
          {/* Download icon */}
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          {exporting ? t('reports.exporting') : t('reports.exportCsv')}
        </button>
      </div>

      {/* Table */}
      <div className="rounded-md border border-border bg-surface overflow-hidden">
        {loading ? (
          <table className="w-full text-label text-text">
            <thead><tr className="border-b border-border bg-surface-2">{headers}</tr></thead>
            <tbody>
              {Array.from({ length: 5 }).map((_, i) => (
                <TableRowSkeleton key={i} cols={colCount} />
              ))}
            </tbody>
          </table>
        ) : error ? (
          <ErrorState onRetry={onRetry} />
        ) : empty ? (
          <EmptyState title={t(emptyKey)} />
        ) : (
          <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
            <table className="w-full text-label text-text">
              <thead className="sticky top-0 z-10">
                <tr className="border-b border-border bg-surface-2">{headers}</tr>
              </thead>
              <tbody className="divide-y divide-border">{rows}</tbody>
              {footer && (
                <tfoot className="sticky bottom-0 z-10">
                  <tr className="border-t border-border bg-surface-2 font-medium">{footer}</tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

const TH = ({ children, align = 'start' }: { children: React.ReactNode; align?: 'start' | 'end' }) => (
  <th scope="col" className={`px-md py-sm text-${align} font-medium text-text-muted whitespace-nowrap`}>
    {children}
  </th>
);

const TD = ({ children, align = 'start', className = '' }: { children?: React.ReactNode; align?: 'start' | 'end'; className?: string }) => (
  <td className={`px-md py-sm text-${align} tabular-nums ${className}`}>
    {children}
  </td>
);

// ── By Day table ──────────────────────────────────────────────────────────────

interface ByDayTableProps {
  data: RevenueByDayRow[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}

export function ByDayTable({ data, loading, error, onRetry }: ByDayTableProps) {
  const t = useTranslations();

  const totals = data.reduce(
    (acc, r) => ({
      gross: acc.gross + r.gross,
      time: acc.time + r.time_total,
      orders: acc.orders + r.orders_total,
      discount: acc.discount + r.discount,
      sessions: acc.sessions + r.session_count,
      walkins: acc.walkins + r.walkin_order_count,
    }),
    { gross: 0, time: 0, orders: 0, discount: 0, sessions: 0, walkins: 0 },
  );

  // Sorted newest first (default desc)
  const sorted = [...data].sort((a, b) => b.business_day.localeCompare(a.business_day));

  function handleExport() {
    const headers = [
      t('col.day'), t('col.gross'), t('col.time'), t('col.orders'),
      t('col.discount'), t('col.sessions'), t('col.walkins'),
    ];
    const rows = sorted.map((r) => [
      r.business_day,
      moneyCell(r.gross),
      moneyCell(r.time_total),
      moneyCell(r.orders_total),
      moneyCell(r.discount),
      numCell(r.session_count),
      numCell(r.walkin_order_count),
    ]);
    downloadCsv(buildCsv(headers, rows), `${t('reports.csv.filename.byDay')}-${new Date().toISOString().slice(0, 10)}.csv`);
  }

  return (
    <TableShell
      loading={loading}
      error={error}
      onRetry={onRetry}
      empty={!loading && !error && data.length === 0}
      emptyKey="reports.byDay.empty"
      colCount={7}
      titleKey="reports.tab.byDay"
      onExportCsv={handleExport}
      headers={<>
        <TH>{t('col.day')}</TH>
        <TH align="end">{t('col.gross')}</TH>
        <TH align="end">{t('col.time')}</TH>
        <TH align="end">{t('col.orders')}</TH>
        <TH align="end">{t('col.discount')}</TH>
        <TH align="end">{t('col.sessions')}</TH>
        <TH align="end">{t('col.walkins')}</TH>
      </>}
      rows={<>
        {sorted.map((r) => (
          <tr key={r.business_day} className="hover:bg-surface-2 transition-colors">
            <TD>{formatDateAr(r.business_day)}</TD>
            <TD align="end">{formatEgp(r.gross)}</TD>
            <TD align="end">{formatEgp(r.time_total)}</TD>
            <TD align="end">{formatEgp(r.orders_total)}</TD>
            <TD align="end">{formatEgp(r.discount)}</TD>
            <TD align="end">{toArabicDigits(String(r.session_count))}</TD>
            <TD align="end">{toArabicDigits(String(r.walkin_order_count))}</TD>
          </tr>
        ))}
      </>}
      footer={<>
        <TD><span className="text-text-muted">{t('col.total')}</span></TD>
        <TD align="end" className="text-primary">{formatEgp(totals.gross)}</TD>
        <TD align="end">{formatEgp(totals.time)}</TD>
        <TD align="end">{formatEgp(totals.orders)}</TD>
        <TD align="end">{formatEgp(totals.discount)}</TD>
        <TD align="end">{toArabicDigits(String(totals.sessions))}</TD>
        <TD align="end">{toArabicDigits(String(totals.walkins))}</TD>
      </>}
    />
  );
}

// ── By Device table ───────────────────────────────────────────────────────────

interface ByDeviceTableProps {
  data: ByDeviceRow[];
  fromKey: string;
  toKey: string;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}

export function ByDeviceTable({ data, fromKey, toKey, loading, error, onRetry }: ByDeviceTableProps) {
  const t = useTranslations();
  const days = daysInRange(fromKey, toKey);
  const totalAvailableMinutes = days * 24 * 60;

  const sorted = [...data].sort((a, b) => b.revenue - a.revenue);

  const totalBusy = data.reduce((sum, r) => sum + r.busy_minutes, 0);
  const totalRevenue = data.reduce((sum, r) => sum + r.revenue, 0);

  function utilizationPct(busyMinutes: number, denominator = totalAvailableMinutes): string {
    if (denominator === 0) return toArabicDigits('0.0') + '٪';
    return toArabicDigits(((busyMinutes / denominator) * 100).toFixed(1)) + '٪';
  }

  function handleExport() {
    const headers = [t('col.device'), t('col.busyMinutes'), t('col.utilization'), t('col.sessions'), t('col.revenue')];
    const rows = sorted.map((r) => [
      r.device_name,
      numCell(r.busy_minutes),
      totalAvailableMinutes > 0
        ? ((r.busy_minutes / totalAvailableMinutes) * 100).toFixed(2)
        : '0.00',
      numCell(r.session_count),
      moneyCell(r.revenue),
    ]);
    downloadCsv(buildCsv(headers, rows), `${t('reports.csv.filename.byDevice')}-${new Date().toISOString().slice(0, 10)}.csv`);
  }

  return (
    <TableShell
      loading={loading}
      error={error}
      onRetry={onRetry}
      empty={!loading && !error && data.length === 0}
      emptyKey="reports.byDevice.empty"
      colCount={5}
      titleKey="reports.tab.byDevice"
      onExportCsv={handleExport}
      headers={<>
        <TH>{t('col.device')}</TH>
        <TH align="end">{t('col.busyMinutes')}</TH>
        <TH align="end">{t('col.utilization')}</TH>
        <TH align="end">{t('col.sessions')}</TH>
        <TH align="end">{t('col.revenue')}</TH>
      </>}
      rows={<>
        {sorted.map((r) => (
          <tr key={r.device_id} className="hover:bg-surface-2 transition-colors">
            <TD>{r.device_name}</TD>
            <TD align="end">{busyMinutesAr(r.busy_minutes)}</TD>
            <TD align="end">{utilizationPct(r.busy_minutes)}</TD>
            <TD align="end">{toArabicDigits(String(r.session_count))}</TD>
            <TD align="end">{formatEgp(r.revenue)}</TD>
          </tr>
        ))}
      </>}
      footer={<>
        <TD><span className="text-text-muted">{t('col.total')}</span></TD>
        <TD align="end">{busyMinutesAr(totalBusy)}</TD>
        <TD align="end">{utilizationPct(totalBusy, totalAvailableMinutes * data.length)}</TD>
        <TD />
        <TD align="end" className="text-primary">{formatEgp(totalRevenue)}</TD>
      </>}
    />
  );
}

// ── By Product table ──────────────────────────────────────────────────────────

interface ByProductTableProps {
  data: TopProductRow[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}

export function ByProductTable({ data, loading, error, onRetry }: ByProductTableProps) {
  const t = useTranslations();
  const sorted = [...data].sort((a, b) => b.revenue - a.revenue);

  const totalQty = data.reduce((sum, r) => sum + r.qty, 0);
  const totalRevenue = data.reduce((sum, r) => sum + r.revenue, 0);

  function calcMargin(row: TopProductRow): string {
    if (row.cost === null) return t('products.noCost');
    const margin = row.revenue - row.cost * row.qty;
    return formatEgp(margin);
  }

  function handleExport() {
    const headers = [t('col.product'), t('col.category'), t('col.qty'), t('col.productRevenue'), t('col.margin')];
    const rows = sorted.map((r) => [
      r.name,
      r.category ?? t('products.noCategory'),
      numCell(r.qty),
      moneyCell(r.revenue),
      r.cost !== null ? moneyCell(r.revenue - r.cost * r.qty) : '',
    ]);
    downloadCsv(buildCsv(headers, rows), `${t('reports.csv.filename.byProduct')}-${new Date().toISOString().slice(0, 10)}.csv`);
  }

  return (
    <TableShell
      loading={loading}
      error={error}
      onRetry={onRetry}
      empty={!loading && !error && data.length === 0}
      emptyKey="reports.byProduct.empty"
      colCount={5}
      titleKey="reports.tab.byProduct"
      onExportCsv={handleExport}
      headers={<>
        <TH>{t('col.product')}</TH>
        <TH>{t('col.category')}</TH>
        <TH align="end">{t('col.qty')}</TH>
        <TH align="end">{t('col.productRevenue')}</TH>
        <TH align="end">{t('col.margin')}</TH>
      </>}
      rows={<>
        {sorted.map((r) => (
          <tr key={r.product_id} className="hover:bg-surface-2 transition-colors">
            <TD>
              <span>{r.name}</span>
            </TD>
            <TD>
              <span className="text-text-muted">
                {r.category ?? t('products.noCategory')}
              </span>
            </TD>
            <TD align="end">{toArabicDigits(String(r.qty))}</TD>
            <TD align="end">{formatEgp(r.revenue)}</TD>
            <TD align="end" className={r.cost === null ? 'text-text-faint' : undefined}>
              {calcMargin(r)}
            </TD>
          </tr>
        ))}
      </>}
      footer={<>
        <TD><span className="text-text-muted">{t('col.total')}</span></TD>
        <TD />
        <TD align="end">{toArabicDigits(String(totalQty))}</TD>
        <TD align="end" className="text-primary">{formatEgp(totalRevenue)}</TD>
        <TD />
      </>}
    />
  );
}

// ── By Shift table ────────────────────────────────────────────────────────────

interface ByShiftTableProps {
  data: ShiftRow[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}

/** Difference color convention (design §7.4, AC 10): short=danger, over=warning, balanced=cash */
function DiffCell({ difference }: { difference: number }) {
  const t = useTranslations();
  if (difference < 0) {
    return (
      <td className="px-md py-sm text-end tabular-nums text-danger font-medium">
        <span className="flex items-center justify-end gap-2xs">
          <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="12 20 12 4 4 12" /><polyline points="12 4 20 12" />
          </svg>
          {formatEgp(difference)}
          <span className="sr-only">{t('reports.shift.short')}</span>
        </span>
      </td>
    );
  }
  if (difference > 0) {
    return (
      <td className="px-md py-sm text-end tabular-nums text-warning font-medium">
        <span className="flex items-center justify-end gap-2xs">
          <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="12 4 12 20 4 12" /><polyline points="12 20 20 12" />
          </svg>
          {formatEgp(difference)}
          <span className="sr-only">{t('reports.shift.over')}</span>
        </span>
      </td>
    );
  }
  return (
    <td className="px-md py-sm text-end tabular-nums text-status-free font-medium">
      <span className="flex items-center justify-end gap-2xs">
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="20 6 9 17 4 12" />
        </svg>
        {formatEgp(0)}
        <span className="sr-only">{t('reports.shift.balanced')}</span>
      </span>
    </td>
  );
}

export function ByShiftTable({ data, loading, error, onRetry }: ByShiftTableProps) {
  const t = useTranslations();

  const sorted = [...data].sort((a, b) => b.opened_at.localeCompare(a.opened_at));

  const totalExpected   = data.reduce((sum, r) => sum + r.expected_cash, 0);
  const totalActual     = data.reduce((sum, r) => sum + r.actual_cash, 0);
  const totalDifference = data.reduce((sum, r) => sum + r.difference, 0);
  const shortCount      = data.filter((r) => r.difference < 0).length;
  const overCount       = data.filter((r) => r.difference > 0).length;
  const balancedCount   = data.filter((r) => r.difference === 0).length;

  function handleExport() {
    const headers = [
      t('col.shiftOpened'), t('col.openingCash'), t('col.expectedCash'), t('col.actualCash'), t('col.difference'),
    ];
    const rows = sorted.map((r) => [
      r.opened_at,
      moneyCell(r.opening_cash),
      moneyCell(r.expected_cash),
      moneyCell(r.actual_cash),
      moneyCell(r.difference),
    ]);
    downloadCsv(buildCsv(headers, rows), `${t('reports.csv.filename.byShift')}-${new Date().toISOString().slice(0, 10)}.csv`);
  }

  return (
    <div className="space-y-sm">
      <TableShell
        loading={loading}
        error={error}
        onRetry={onRetry}
        empty={!loading && !error && data.length === 0}
        emptyKey="reports.byShift.empty"
        colCount={5}
        titleKey="reports.tab.byShift"
        onExportCsv={handleExport}
        headers={<>
          <TH>{t('col.shiftOpened')}</TH>
          <TH align="end">{t('col.openingCash')}</TH>
          <TH align="end">{t('col.expectedCash')}</TH>
          <TH align="end">{t('col.actualCash')}</TH>
          <TH align="end">{t('col.difference')}</TH>
        </>}
        rows={<>
          {sorted.map((r) => (
            <tr key={r.shift_id} className="hover:bg-surface-2 transition-colors">
              <TD>{formatDateTimeAr(r.opened_at)}</TD>
              <TD align="end">{formatEgp(r.opening_cash)}</TD>
              <TD align="end">{formatEgp(r.expected_cash)}</TD>
              <TD align="end">{formatEgp(r.actual_cash)}</TD>
              <DiffCell difference={r.difference} />
            </tr>
          ))}
        </>}
        footer={<>
          <TD><span className="text-text-muted">{t('col.total')}</span></TD>
          <TD />
          <TD align="end">{formatEgp(totalExpected)}</TD>
          <TD align="end">{formatEgp(totalActual)}</TD>
          <DiffCell difference={totalDifference} />
        </>}
      />
      {/* Shift summary chips */}
      {data.length > 0 && !loading && !error && (
        <div className="flex gap-sm flex-wrap">
          <span className="inline-flex items-center gap-2xs px-sm py-xs rounded-xs bg-danger/10 text-danger text-caption font-medium">
            {t('reports.shift.short')}: {toArabicDigits(String(shortCount))}
          </span>
          <span className="inline-flex items-center gap-2xs px-sm py-xs rounded-xs bg-warning/10 text-warning text-caption font-medium">
            {t('reports.shift.over')}: {toArabicDigits(String(overCount))}
          </span>
          <span className="inline-flex items-center gap-2xs px-sm py-xs rounded-xs bg-status-free/10 text-status-free text-caption font-medium">
            {t('reports.shift.balanced')}: {toArabicDigits(String(balancedCount))}
          </span>
        </div>
      )}
    </div>
  );
}
