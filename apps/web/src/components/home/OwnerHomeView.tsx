'use client';

/**
 * OwnerHomeView — owner dashboard home page (design-uplift, ADR-0012).
 *
 * Visual: gradient hero for revenue today, e1 elevation on KPI cards,
 * occupancy progress track, floor summary strip above the device grid.
 *
 * Layout:
 *   1. Page header
 *   2. KPI tile row (gradient hero revenue + 3 elevated tiles)
 *   3. Floor summary strip (متاح / مشغول / صيانة + revenue)
 *   4. Branch selector (hidden when single branch)
 *   5. Live device grid (OwnerDevicesView)
 *
 * Data: same RPCs + device status count for the floor strip.
 * Money/time: @ps/core only. RTL logical props. All strings via i18n.
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
  activeDevices: number;       // sessions with status='active' (busy)
  totalDevices: number;        // all active devices in branch
  maintenanceDevices: number;  // devices with status='maintenance'
}

// ── Gradient hero tile — "إيراد اليوم" (EXACTLY ONE on screen) ──────────────

interface HeroRevenueTileProps {
  label: string;
  hero: string;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
}

function HeroRevenueTile({
  label,
  hero,
  loading = false,
  error = false,
  onRetry,
}: HeroRevenueTileProps) {
  const t = useTranslations();

  if (loading) {
    return (
      <div
        className="rounded-md shadow-e1 p-md flex flex-col gap-xs min-h-[120px]"
        style={{ background: 'linear-gradient(135deg, #14B8A6 0%, #0F766E 100%)' }}
      >
        <Skeleton className="h-4 w-24" style={{ backgroundColor: 'rgba(255,255,255,0.2)' }} />
        <Skeleton className="h-10 w-28 mt-xs" style={{ backgroundColor: 'rgba(255,255,255,0.2)' }} />
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="alert"
        className="rounded-md shadow-e1 p-md flex flex-col gap-xs min-h-[120px] justify-center"
        style={{ background: 'linear-gradient(135deg, #14B8A6 0%, #0F766E 100%)' }}
      >
        <p className="text-caption font-medium" style={{ color: 'rgba(255,255,255,0.8)' }}>{label}</p>
        <p className="text-caption" style={{ color: '#FCA5A5' }}>{t('state.error.generic')}</p>
        {onRetry && (
          <button
            onClick={onRetry}
            className="text-caption hover:underline text-start"
            style={{ color: 'rgba(255,255,255,0.9)' }}
          >
            {t('action.retry')}
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      className="rounded-md shadow-e1 p-md flex flex-col gap-xs min-h-[120px]"
      style={{ background: 'linear-gradient(135deg, #14B8A6 0%, #0F766E 100%)' }}
      aria-label={`${label}: ${hero}`}
    >
      <p
        className="text-caption font-medium"
        style={{ color: 'rgba(255,255,255,0.85)' }}
      >
        {label}
      </p>
      {/* Display-size tabular money — larger than the other tiles */}
      <p
        className="text-display font-bold tabular-nums leading-none"
        dir="ltr"
        style={{ color: '#ffffff' }}
      >
        {hero}
      </p>
    </div>
  );
}

// ── StatTile — elevated KPI card with optional occupancy progress track ────────

interface StatTileProps {
  label: string;
  hero: string;
  sub?: string;
  accentColor?: string;
  /** 0–100; when provided, renders a thin progress bar under the number */
  progressPct?: number;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
}

function StatTile({
  label,
  hero,
  sub,
  accentColor = '#14B8A6',
  progressPct,
  loading = false,
  error = false,
  onRetry,
}: StatTileProps) {
  const t = useTranslations();

  if (loading) {
    return (
      <div className="rounded-md bg-surface border border-border shadow-e1 p-md flex flex-col gap-xs">
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
        className="rounded-md bg-surface border border-border shadow-e1 p-md flex flex-col gap-xs min-h-[100px] justify-center"
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
      className="rounded-md bg-surface border border-border shadow-e1 p-md flex flex-col gap-xs"
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

      {/* Thin occupancy / progress track (design §1: "calm" delta chip) */}
      {progressPct !== undefined && (
        <div
          className="mt-xs h-1 w-full rounded-pill overflow-hidden"
          style={{ backgroundColor: 'rgba(148,163,184,0.15)' }}
          aria-hidden="true"
        >
          <div
            className="h-full rounded-pill transition-all duration-slow"
            style={{
              width: `${Math.min(100, Math.max(0, progressPct))}%`,
              backgroundColor: accentColor,
            }}
          />
        </div>
      )}
    </div>
  );
}

// ── FloorSummaryStrip ─────────────────────────────────────────────────────────

interface FloorSummaryStripProps {
  freeCount: number;
  busyCount: number;
  maintenanceCount: number;
  revenuePiastres: number;
  loading?: boolean;
}

function FloorSummaryStrip({
  freeCount,
  busyCount,
  maintenanceCount,
  revenuePiastres,
  loading = false,
}: FloorSummaryStripProps) {
  const t = useTranslations();

  if (loading) {
    return (
      <div className="rounded-md bg-surface border border-border px-md py-sm flex items-center gap-md flex-wrap">
        <Skeleton className="h-5 w-16" />
        <Skeleton className="h-5 w-16" />
        <Skeleton className="h-5 w-16" />
        <div className="ms-auto">
          <Skeleton className="h-5 w-24" />
        </div>
      </div>
    );
  }

  return (
    <div
      className="rounded-md bg-surface border border-border px-md py-sm flex items-center gap-md flex-wrap"
      role="region"
      aria-label={t('home.floor.label')}
    >
      {/* متاح (free) */}
      <div className="flex items-center gap-xs">
        <span
          className="w-2 h-2 rounded-pill flex-shrink-0 bg-status-free"
          aria-hidden="true"
        />
        <span className="text-caption text-text-muted">{t('device.status.free')}</span>
        <span
          className="text-caption font-bold tabular-nums"
          style={{ color: '#10B981' }}
        >
          {toArabicDigits(String(freeCount))}
        </span>
      </div>

      {/* Divider */}
      <span className="text-text-faint" aria-hidden="true">·</span>

      {/* مشغول (busy) */}
      <div className="flex items-center gap-xs">
        <span
          className="w-2 h-2 rounded-pill flex-shrink-0 bg-status-busy"
          aria-hidden="true"
        />
        <span className="text-caption text-text-muted">{t('device.status.busy')}</span>
        <span
          className="text-caption font-bold tabular-nums"
          style={{ color: '#3B82F6' }}
        >
          {toArabicDigits(String(busyCount))}
        </span>
      </div>

      {/* Divider */}
      <span className="text-text-faint" aria-hidden="true">·</span>

      {/* صيانة (maintenance) */}
      <div className="flex items-center gap-xs">
        <span
          className="w-2 h-2 rounded-pill flex-shrink-0 bg-status-maint"
          aria-hidden="true"
        />
        <span className="text-caption text-text-muted">{t('device.status.maintenance')}</span>
        <span className="text-caption font-bold text-text-muted tabular-nums">
          {toArabicDigits(String(maintenanceCount))}
        </span>
      </div>

      {/* Revenue pushed to the end */}
      <div className="ms-auto flex items-center gap-xs">
        <span className="text-caption text-text-muted">{t('home.kpi.revenueToday')}</span>
        <span
          className="text-label font-bold tabular-nums"
          style={{ color: '#14B8A6' }}
          dir="ltr"
        >
          {formatEgp(revenuePiastres)}
        </span>
      </div>
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

      const sv = settingsResult.data?.value as { cutover_hour?: number } | null;
      const fetchedCutover = sv?.cutover_hour ?? DEFAULT_CUTOVER_HOUR;
      setCutoverHour(fetchedCutover);

      const rows = (branchesResult.data as Branch[]) ?? [];
      setBranches(rows);

      const stored = localStorage.getItem(BRANCH_STORAGE_KEY);
      const storedValid = stored && rows.some((b) => b.id === stored);
      if (storedValid && stored) {
        setActiveBranchId(stored);
      } else if (rows.length > 0 && rows[0]) {
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

  // ── Fetch today's KPIs + device status counts ─────────────────────────────
  const fetchKpi = useCallback(async () => {
    if (!claim || !activeBranchId) return;
    setKpiLoading(true);
    setKpiError(null);
    try {
      const supabase = getBrowserClient();

      const todayKey = businessDayKey(nowIso(), cutoverHour, CAFE_TZ);
      const { fromIso, toIso } = businessDayRange(todayKey, todayKey, cutoverHour, CAFE_TZ);

      const [revenueResult, devicesResult, activeSessionsResult, maintenanceResult] =
        await Promise.all([
          supabase.rpc('report_revenue_by_day', {
            p_from:    fromIso,
            p_to:      toIso,
            p_branch:  activeBranchId,
            p_cutover: cutoverHour,
          }),
          // Total active devices (denominator for occupancy)
          supabase
            .from('devices')
            .select('id', { count: 'exact', head: true })
            .eq('branch_id', activeBranchId)
            .eq('is_active', true),
          // Active sessions (= busy devices; numerator for occupancy)
          supabase
            .from('sessions')
            .select('id', { count: 'exact', head: true })
            .eq('branch_id', activeBranchId)
            .eq('status', 'active'),
          // Maintenance devices (for the floor summary strip)
          supabase
            .from('devices')
            .select('id', { count: 'exact', head: true })
            .eq('branch_id', activeBranchId)
            .eq('is_active', true)
            .eq('status', 'maintenance'),
        ]);

      if (revenueResult.error) throw revenueResult.error;
      if (devicesResult.error)  throw devicesResult.error;
      if (activeSessionsResult.error) throw activeSessionsResult.error;
      // maintenanceResult error is non-critical; default to 0

      const rows = (revenueResult.data as RevenueByDayRow[]) ?? [];
      const gross = rows.reduce((sum, r) => sum + (r.gross ?? 0), 0);
      const sessionCount = rows.reduce((sum, r) => sum + (r.session_count ?? 0), 0);

      setKpi({
        revenuePiastres:    gross,
        sessionsToday:      sessionCount,
        totalDevices:       devicesResult.count ?? 0,
        activeDevices:      activeSessionsResult.count ?? 0,
        maintenanceDevices: maintenanceResult.count ?? 0,
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

  // ── Derived floor-strip counts ────────────────────────────────────────────
  const freeDevices = kpi
    ? Math.max(0, kpi.totalDevices - kpi.activeDevices - kpi.maintenanceDevices)
    : 0;

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

      {/* KPI tile row — 2 cols mobile, 4 cols md+ */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-card">
        {/* Revenue today — GRADIENT HERO (exactly one gradient card) */}
        <HeroRevenueTile
          label={t('home.kpi.revenueToday')}
          hero={kpi ? formatEgp(kpi.revenuePiastres) : formatEgp(0)}
          loading={kpiLoading}
          error={!!kpiError && !kpiLoading}
          onRetry={fetchKpi}
        />

        {/* Sessions today */}
        <StatTile
          label={t('home.kpi.sessionsToday')}
          hero={kpi ? toArabicDigits(String(kpi.sessionsToday)) : toArabicDigits('0')}
          sub={
            kpi
              ? t('home.kpi.sessionsSub', { n: toArabicDigits(String(kpi.sessionsToday)) })
              : undefined
          }
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
          sub={
            kpi
              ? t('home.kpi.of', { total: toArabicDigits(String(kpi.totalDevices)) })
              : undefined
          }
          accentColor="#F59E0B"
          loading={kpiLoading}
          error={!!kpiError && !kpiLoading}
          onRetry={fetchKpi}
        />

        {/* Occupancy — with thin progress track */}
        <StatTile
          label={t('home.kpi.occupancy')}
          hero={
            kpi
              ? t('home.kpi.pct', { pct: toArabicDigits(String(occupancyPct)) })
              : `${toArabicDigits('0')}٪`
          }
          progressPct={occupancyPct}
          accentColor="#14B8A6"
          loading={kpiLoading}
          error={!!kpiError && !kpiLoading}
          onRetry={fetchKpi}
        />
      </div>

      {/* Floor summary strip — highest-leverage single element (design brief §3) */}
      <FloorSummaryStrip
        freeCount={freeDevices}
        busyCount={kpi?.activeDevices ?? 0}
        maintenanceCount={kpi?.maintenanceDevices ?? 0}
        revenuePiastres={kpi?.revenuePiastres ?? 0}
        loading={kpiLoading}
      />

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
