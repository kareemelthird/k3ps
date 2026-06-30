'use client';

/**
 * OwnerHomeView — owner dashboard home page (Bug 3 rebuild, ADR-0012).
 *
 * Rendered inside DashboardPageShell so it gets the standard nav, tenant name,
 * and subscription banner — matching the products / devices / staff / reports pages.
 *
 * Layout:
 *   1. Page header (title + subtitle)
 *   2. Four KPI stat tiles: today's revenue, sessions today, active devices, occupancy %
 *   3. Branch selector (hidden when only one branch — auto-selected)
 *   4. Live device grid + recent sessions (OwnerDevicesView, refreshes every 20 s)
 *
 * Data contracts:
 *   - report_revenue_by_day RPC for today's business-day gross + session_count.
 *     Uses @ps/core businessDayKey/businessDayRange to compute the exact UTC window.
 *   - devices table (total active count for occupancy denominator).
 *   - sessions table (active count for occupancy numerator).
 *   - All queries are RLS-scoped via the signed JWT claim (tenant_id never sent
 *     from the client as a trust source — RLS enforces it server-side).
 *
 * Money: gross in integer piastres via formatEgp. No float math on the client.
 * RTL: all spacing uses Tailwind logical props (px-xl, gap-md, etc.).
 * i18n: all strings via next-intl t(), keys in ar.json §home.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  businessDayKey,
  businessDayRange,
  nowIso,
  DEFAULT_CUTOVER_HOUR,
  CAFE_TZ,
  formatEgp,
  toArabicDigits,
} from '@ps/core';
import { getBrowserClient } from '@/lib/supabase/client';
import { useAuth } from '@/lib/auth/AuthContext';
import { BranchSelect } from '@/components/devices/BranchSelect';
import { OwnerDevicesView } from '@/components/devices/OwnerDevicesView';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Skeleton } from '@/components/ui/Skeleton';
import type { Branch } from '@ps/core';
import type { RevenueByDayRow } from '@/components/reports/types';

// ── Constants ──────────────────────────────────────────────────────────────────

const BRANCH_STORAGE_KEY = 'ps_active_branch_id';

// ── Types ──────────────────────────────────────────────────────────────────────

interface HomeKpi {
  revenuePiastres: number;
  sessionsToday: number;
  activeDevices: number;
  totalDevices: number;
}

// ── StatTile — simple stat card for both money and count metrics ───────────────

interface StatTileProps {
  label: string;
  hero: string;
  sub?: string;
  accentColor?: string;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
}

function StatTile({
  label,
  hero,
  sub,
  accentColor = '#14B8A6',
  loading = false,
  error = false,
  onRetry,
}: StatTileProps) {
  const t = useTranslations();

  if (loading) {
    return (
      <div className="rounded-md bg-surface border border-border shadow-e0 p-md flex flex-col gap-xs">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-8 w-20 mt-xs" />
        <Skeleton className="h-3 w-28" />
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="alert"
        className="rounded-md bg-surface border border-border shadow-e0 p-md flex flex-col gap-xs min-h-[96px] justify-center"
      >
        <p className="text-caption text-text-muted">{label}</p>
        <p className="text-caption text-danger">{t('state.error.generic')}</p>
        {onRetry && (
          <button
            onClick={onRetry}
            className="text-caption text-primary hover:underline text-start"
          >
            {t('action.retry')}
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      className="rounded-md bg-surface border border-border shadow-e0 p-md flex flex-col gap-xs"
      aria-label={`${label}: ${hero}`}
    >
      {/* Accent dot + label */}
      <div className="flex items-center gap-xs">
        <span
          aria-hidden="true"
          className="w-2 h-2 rounded-pill flex-shrink-0"
          style={{ backgroundColor: accentColor }}
        />
        <p className="text-caption text-text-muted">{label}</p>
      </div>
      {/* Hero value — tabular numerals */}
      <p className="text-display text-text font-bold tabular-nums leading-none">{hero}</p>
      {/* Sub-line */}
      {sub && <p className="text-caption text-text-faint">{sub}</p>}
    </div>
  );
}

// ── OwnerHomeView ──────────────────────────────────────────────────────────────

export function OwnerHomeView() {
  const t = useTranslations();
  const { claim } = useAuth();

  // ── Settings (cutover_hour) ────────────────────────────────────────────────
  const [cutoverHour, setCutoverHour] = useState<number>(DEFAULT_CUTOVER_HOUR);

  // ── Branch state ──────────────────────────────────────────────────────────
  const [branches, setBranches] = useState<Branch[]>([]);
  const [activeBranchId, setActiveBranchId] = useState<string | null>(null);
  const [branchesLoading, setBranchesLoading] = useState(true);
  const [branchesError, setBranchesError] = useState<string | null>(null);

  // ── KPI state ─────────────────────────────────────────────────────────────
  const [kpi, setKpi] = useState<HomeKpi | null>(null);
  const [kpiLoading, setKpiLoading] = useState(false);
  const [kpiError, setKpiError] = useState<string | null>(null);

  // ── Fetch settings + branches ─────────────────────────────────────────────
  const fetchMeta = useCallback(async () => {
    if (!claim) return;
    setBranchesLoading(true);
    setBranchesError(null);
    try {
      const supabase = getBrowserClient();

      const [settingsResult, branchesResult] = await Promise.all([
        // maybeSingle: avoids 406 when business_day row doesn't exist
        supabase
          .from('settings')
          .select('value')
          .eq('key', 'business_day')
          .maybeSingle(),
        supabase
          .from('branches')
          .select('*')
          .eq('tenant_id', claim.tenant_id)
          .eq('is_active', true)
          .order('name', { ascending: true }),
      ]);

      // Resolve cutover_hour (defaults to 6)
      const sv = settingsResult.data?.value as { cutover_hour?: number } | null;
      const fetchedCutover = sv?.cutover_hour ?? DEFAULT_CUTOVER_HOUR;
      setCutoverHour(fetchedCutover);

      const rows = (branchesResult.data as Branch[]) ?? [];
      setBranches(rows);

      // Restore or auto-select branch
      const stored = localStorage.getItem(BRANCH_STORAGE_KEY);
      const storedValid = stored && rows.some((b) => b.id === stored);
      if (storedValid && stored) {
        setActiveBranchId(stored);
      } else if (rows.length > 0 && rows[0]) {
        // Auto-select first branch
        setActiveBranchId(rows[0].id);
        localStorage.setItem(BRANCH_STORAGE_KEY, rows[0].id);
      }
    } catch (err) {
      setBranchesError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setBranchesLoading(false);
    }
  }, [claim]);

  useEffect(() => {
    void fetchMeta();
  }, [fetchMeta]);

  // ── Fetch today's KPIs ────────────────────────────────────────────────────
  const fetchKpi = useCallback(async () => {
    if (!claim || !activeBranchId) return;
    setKpiLoading(true);
    setKpiError(null);
    try {
      const supabase = getBrowserClient();

      // Today's business-day window (UTC half-open interval)
      const todayKey = businessDayKey(nowIso(), cutoverHour, CAFE_TZ);
      const { fromIso, toIso } = businessDayRange(todayKey, todayKey, cutoverHour, CAFE_TZ);

      const [revenueResult, devicesResult, activeSessionsResult] = await Promise.all([
        // Today's revenue + session count via reporting RPC (same source as reports page)
        supabase.rpc('report_revenue_by_day', {
          p_from:    fromIso,
          p_to:      toIso,
          p_branch:  activeBranchId,
          p_cutover: cutoverHour,
        }),
        // Total active devices in this branch (denominator for occupancy)
        supabase
          .from('devices')
          .select('id', { count: 'exact', head: true })
          .eq('branch_id', activeBranchId)
          .eq('is_active', true),
        // Currently active sessions in this branch (numerator for occupancy)
        supabase
          .from('sessions')
          .select('id', { count: 'exact', head: true })
          .eq('branch_id', activeBranchId)
          .eq('status', 'active'),
      ]);

      // Surface errors
      if (revenueResult.error) throw revenueResult.error;
      if (devicesResult.error) throw devicesResult.error;
      if (activeSessionsResult.error) throw activeSessionsResult.error;

      // Sum today's rows (report_revenue_by_day returns one row per business day)
      const rows = (revenueResult.data as RevenueByDayRow[]) ?? [];
      const gross = rows.reduce((sum, r) => sum + (r.gross ?? 0), 0);
      const sessionCount = rows.reduce((sum, r) => sum + (r.session_count ?? 0), 0);

      setKpi({
        revenuePiastres: gross,
        sessionsToday: sessionCount,
        totalDevices: devicesResult.count ?? 0,
        activeDevices: activeSessionsResult.count ?? 0,
      });
    } catch (err) {
      setKpiError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setKpiLoading(false);
    }
  }, [claim, activeBranchId, cutoverHour]);

  useEffect(() => {
    void fetchKpi();
  }, [fetchKpi]);

  // ── Branch selector handler ───────────────────────────────────────────────
  function handleBranchSelect(id: string | null) {
    if (!id) return;
    setActiveBranchId(id);
    localStorage.setItem(BRANCH_STORAGE_KEY, id);
  }

  // ── Derived KPI values ────────────────────────────────────────────────────
  const occupancyPct =
    kpi && kpi.totalDevices > 0
      ? Math.round((kpi.activeDevices / kpi.totalDevices) * 100)
      : 0;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-2xl">
      {/* Page header */}
      <div>
        <h1 className="text-h1 text-text font-bold">{t('home.title')}</h1>
        <p className="text-body text-text-muted mt-xs">{t('home.subtitle')}</p>
      </div>

      {/* KPI tile row — 2 cols on mobile, 4 on md+ */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-card">
        {/* Revenue today */}
        <StatTile
          label={t('home.kpi.revenueToday')}
          hero={kpi ? formatEgp(kpi.revenuePiastres) : formatEgp(0)}
          accentColor="#14B8A6"
          loading={kpiLoading}
          error={!!kpiError && !kpiLoading}
          onRetry={fetchKpi}
        />

        {/* Sessions today */}
        <StatTile
          label={t('home.kpi.sessionsToday')}
          hero={kpi ? toArabicDigits(String(kpi.sessionsToday)) : toArabicDigits('0')}
          sub={kpi ? t('home.kpi.sessionsSub', { n: toArabicDigits(String(kpi.sessionsToday)) }) : undefined}
          accentColor="#3B82F6"
          loading={kpiLoading}
          error={!!kpiError && !kpiLoading}
          onRetry={fetchKpi}
        />

        {/* Active devices */}
        <StatTile
          label={t('home.kpi.activeDevices')}
          hero={
            kpi
              ? `${toArabicDigits(String(kpi.activeDevices))} / ${toArabicDigits(String(kpi.totalDevices))}`
              : toArabicDigits('0 / 0')
          }
          sub={kpi ? t('home.kpi.of', { total: toArabicDigits(String(kpi.totalDevices)) }) : undefined}
          accentColor="#F59E0B"
          loading={kpiLoading}
          error={!!kpiError && !kpiLoading}
          onRetry={fetchKpi}
        />

        {/* Occupancy % */}
        <StatTile
          label={t('home.kpi.occupancy')}
          hero={kpi ? t('home.kpi.pct', { pct: toArabicDigits(String(occupancyPct)) }) : toArabicDigits('0') + '٪'}
          accentColor="#10B981"
          loading={kpiLoading}
          error={!!kpiError && !kpiLoading}
          onRetry={fetchKpi}
        />
      </div>

      {/* Branch selector (shown only when >1 branch) */}
      {branches.length > 1 && (
        <div className="flex items-center gap-md">
          <span className="text-label text-text-muted">{t('branch.label')}</span>
          <BranchSelect
            branches={branches}
            activeId={activeBranchId}
            onSelect={handleBranchSelect}
            loading={branchesLoading}
          />
        </div>
      )}

      {/* Device grid + sessions — guarded by branch selection */}
      {branchesError && (
        <ErrorState message={branchesError} onRetry={fetchMeta} />
      )}

      {!branchesError && !branchesLoading && branches.length === 0 && (
        <EmptyState
          title={t('branch.empty.title')}
          body={t('branch.empty.body')}
        />
      )}

      {!branchesError && activeBranchId && claim?.tenant_id && (
        <OwnerDevicesView
          key={activeBranchId}
          branchId={activeBranchId}
          tenantId={claim.tenant_id}
        />
      )}

      {!branchesError && !branchesLoading && branches.length > 0 && !activeBranchId && (
        <EmptyState
          title={t('branch.choose.title')}
          body={t('branch.label')}
        />
      )}
    </div>
  );
}
