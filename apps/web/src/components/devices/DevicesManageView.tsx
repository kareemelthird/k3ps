'use client';

/**
 * DevicesManageView — owner device fleet management (owner-only write).
 *
 * Owners can create, edit, toggle maintenance, and deactivate/reactivate devices
 * for the active branch. All writes via the Supabase browser client; RLS enforces
 * tenant scope via the signed JWT claim — the client sends its own tenant_id and
 * the WITH CHECK policy validates it server-side (ADR-0003, CLAUDE.md §5).
 *
 * HARD RULES:
 *  - All strings from i18n — no hardcoded user-facing text.
 *  - RTL: logical spacing only (start/end, ms/me/ps/pe).
 *  - Tenant isolation: tenant_id comes from JWT claim (never client-supplied trust).
 *  - Status guard: never allow the owner to force 'busy'; maintenance toggle is
 *    disabled when the device has an active session.
 *  - Soft-delete only (is_active=false) — never hard-delete.
 *  - Devices are branch-scoped; branch selected within this view.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toArabicDigits } from '@ps/core';
import type { Branch, Device } from '@ps/core';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { StatusPill } from '@/components/ui/StatusPill';
import { DeviceForm } from './DeviceForm';
import { getBrowserClient } from '@/lib/supabase/client';
import { useAuth } from '@/lib/auth/AuthContext';

// ─── Types ────────────────────────────────────────────────────────────────────

type Modal =
  | { type: 'create' }
  | { type: 'edit'; device: Device }
  | { type: 'deactivate'; device: Device }
  | { type: 'reactivate'; device: Device }
  | { type: 'maintenance'; device: Device }
  | { type: 'releaseMaintenance'; device: Device }
  | null;

type TypeFilter = string; // '' = all
type StatusFilter = 'all' | 'active' | 'inactive';

// ─── Confirm dialog ───────────────────────────────────────────────────────────

interface ConfirmDialogProps {
  message: string;
  confirmLabel: string;
  confirmVariant: 'primary' | 'danger' | 'secondary';
  loading: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmDialog({
  message,
  confirmLabel,
  confirmVariant,
  loading,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const t = useTranslations();
  return (
    <div className="space-y-lg">
      <p className="text-body text-text">{message}</p>
      <div className="flex gap-md justify-end">
        <Button variant="secondary" onClick={onCancel} disabled={loading}>
          {t('devices.action.cancel')}
        </Button>
        <Button variant={confirmVariant} onClick={onConfirm} loading={loading}>
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}

// ─── Device card ──────────────────────────────────────────────────────────────

interface DeviceCardProps {
  device: Device;
  hasActiveSession: boolean;
  pending: boolean;
  onEdit: () => void;
  onDeactivate: () => void;
  onReactivate: () => void;
  onMaintenance: () => void;
  onReleaseMaintenance: () => void;
  t: ReturnType<typeof useTranslations>;
}

function DeviceManageCard({
  device,
  hasActiveSession,
  pending,
  onEdit,
  onDeactivate,
  onReactivate,
  onMaintenance,
  onReleaseMaintenance,
  t,
}: DeviceCardProps) {
  const isInactive = !device.is_active;

  // Maintenance toggle is locked when device has an active session (guard requirement)
  const maintenanceLocked = hasActiveSession && device.status !== 'maintenance';

  return (
    <article
      aria-label={`${device.name} — ${device.device_type}`}
      className={`rounded-md bg-surface border p-md flex flex-col gap-sm transition-opacity
        ${isInactive ? 'opacity-50 border-border' : 'border-border hover:border-border-strong'}`}
    >
      {/* Header row: name + type + status */}
      <div className="flex items-start gap-sm">
        {/* Status indicator dot */}
        <span
          className={`w-2 h-2 rounded-full flex-shrink-0 mt-1.5
            ${device.status === 'free' ? 'bg-status-free'
              : device.status === 'busy' ? 'bg-status-busy'
              : 'bg-status-maint'}`}
          aria-hidden="true"
        />
        <div className="flex-1 min-w-0">
          <h3 className="text-body font-medium text-text">{device.name}</h3>
          <div className="flex flex-wrap items-center gap-xs mt-xs">
            {/* Device type badge */}
            <span className="text-micro font-medium bg-surface-3 text-text-muted px-xs py-1 rounded-xs uppercase tracking-wider">
              {device.device_type}
            </span>
            {/* Status pill */}
            <StatusPill status={device.status} />
            {/* Inactive badge */}
            {isInactive && (
              <span className="text-micro font-medium text-text-faint">
                {t('devices.filter.inactive')}
              </span>
            )}
          </div>
        </div>

        {/* Sort order */}
        <span className="text-caption text-text-faint tabular-nums flex-shrink-0">
          #{toArabicDigits(String(device.sort_order))}
        </span>
      </div>

      {/* Active session guard notice */}
      {hasActiveSession && (
        <p className="text-caption text-warning text-start ps-sm">
          {t('devices.guard.hasBusySession')}
        </p>
      )}

      {/* Owner action buttons */}
      <div className="flex flex-wrap items-center gap-xs pt-xs border-t border-border mt-auto">
        {/* Edit */}
        <Button
          variant="ghost"
          size="md"
          onClick={onEdit}
          aria-label={`${t('devices.edit')} ${device.name}`}
          className="h-9 px-sm text-text-muted"
          disabled={pending}
        >
          <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
          </svg>
          {t('devices.edit')}
        </Button>

        {/* Maintenance toggle — disabled when device is busy with an active session */}
        {device.status === 'maintenance' ? (
          <Button
            variant="secondary"
            size="md"
            onClick={onReleaseMaintenance}
            aria-label={`${t('devices.action.releaseMaintenance')} ${device.name}`}
            className="h-9 px-sm"
            loading={pending}
            disabled={maintenanceLocked}
          >
            {t('devices.action.releaseMaintenance')}
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="md"
            onClick={onMaintenance}
            aria-label={`${t('devices.action.maintenance')} ${device.name}`}
            className="h-9 px-sm"
            loading={pending}
            disabled={maintenanceLocked || device.status === 'busy'}
          >
            {t('devices.action.maintenance')}
          </Button>
        )}

        {/* Deactivate / Reactivate — spatially separated */}
        {isInactive ? (
          <Button
            variant="secondary"
            size="md"
            onClick={onReactivate}
            aria-label={`${t('devices.action.reactivate')} ${device.name}`}
            className="h-9 px-sm"
            loading={pending}
          >
            {t('devices.action.reactivate')}
          </Button>
        ) : (
          <Button
            variant="danger"
            size="md"
            onClick={onDeactivate}
            aria-label={`${t('devices.action.deactivate')} ${device.name}`}
            className="h-9 px-sm"
            loading={pending}
            disabled={hasActiveSession}
          >
            {t('devices.action.deactivate')}
          </Button>
        )}
      </div>
    </article>
  );
}

// ─── Main view ────────────────────────────────────────────────────────────────

export function DevicesManageView() {
  const t = useTranslations();
  const { claim } = useAuth();

  // Branch selection
  const [branches, setBranches] = useState<Branch[]>([]);
  const [activeBranchId, setActiveBranchId] = useState<string | null>(null);
  const [branchesLoading, setBranchesLoading] = useState(true);

  // Device list
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Active session guard: set of device IDs that have an active session
  const [busyDeviceIds, setBusyDeviceIds] = useState<Set<string>>(new Set());

  // Modal + pending
  const [modal, setModal] = useState<Modal>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  // Filters
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');
  const [searchQuery, setSearchQuery] = useState('');

  // ─── Fetch branches ────────────────────────────────────────────────────────

  const fetchBranches = useCallback(async () => {
    if (!claim) return;
    setBranchesLoading(true);
    try {
      const supabase = getBrowserClient();
      const { data } = await supabase
        .from('branches')
        .select('*')
        .eq('tenant_id', claim.tenant_id)
        .eq('is_active', true)
        .order('name', { ascending: true });
      const rows = (data as Branch[]) ?? [];
      setBranches(rows);
      // Auto-select if single branch
      if (!activeBranchId && rows.length === 1 && rows[0]) {
        setActiveBranchId(rows[0].id);
      }
    } catch {
      // Non-blocking
    } finally {
      setBranchesLoading(false);
    }
  }, [claim, activeBranchId]);

  useEffect(() => {
    void fetchBranches();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claim?.tenant_id]);

  // ─── Fetch devices ─────────────────────────────────────────────────────────

  const fetchDevices = useCallback(async () => {
    if (!activeBranchId) return;
    setLoading(true);
    setError(null);
    try {
      const supabase = getBrowserClient();
      // RLS ensures only this tenant's devices are returned.
      const { data, error: err } = await supabase
        .from('devices')
        .select('*')
        .eq('branch_id', activeBranchId)
        .order('sort_order', { ascending: true })
        .order('name', { ascending: true });
      if (err) throw err;
      setDevices((data as Device[]) ?? []);

      // Fetch active session device IDs for the guard
      const { data: sessions } = await supabase
        .from('sessions')
        .select('device_id')
        .eq('branch_id', activeBranchId)
        .eq('status', 'active');

      const ids = new Set<string>(
        ((sessions as Array<{ device_id: string }>) ?? []).map((s) => s.device_id),
      );
      setBusyDeviceIds(ids);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [activeBranchId]);

  useEffect(() => {
    void fetchDevices();
  }, [fetchDevices]);

  // ─── Derived: unique device types for filter ───────────────────────────────

  const deviceTypes = useMemo(() => {
    const types = new Set<string>();
    for (const d of devices) types.add(d.device_type);
    return [...types].sort();
  }, [devices]);

  // ─── Filtered list ─────────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return devices.filter((d) => {
      if (typeFilter && d.device_type !== typeFilter) return false;
      if (statusFilter === 'active' && !d.is_active) return false;
      if (statusFilter === 'inactive' && d.is_active) return false;
      if (q && !d.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [devices, typeFilter, statusFilter, searchQuery]);

  // ─── Handlers ─────────────────────────────────────────────────────────────

  function handleSaved(device: Device) {
    setDevices((prev) => {
      const idx = prev.findIndex((d) => d.id === device.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = device;
        return next;
      }
      return [...prev, device].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
    });
    setModal(null);
  }

  async function handleUpdateField(
    device: Device,
    patch: Partial<Pick<Device, 'is_active' | 'status'>>,
  ) {
    setPendingId(device.id);
    try {
      const supabase = getBrowserClient();
      const { error: err } = await supabase
        .from('devices')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', device.id);
      if (err) throw err;
      setDevices((prev) =>
        prev.map((d) => (d.id === device.id ? { ...d, ...patch } : d)),
      );
      setModal(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setPendingId(null);
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-2xl">
      {/* Page header */}
      <div className="flex items-center justify-between gap-md flex-wrap">
        <div>
          <h1 className="text-h1 text-text">{t('devices.manage.title')}</h1>
          <p className="text-label text-text-muted mt-xs">{t('devices.manage.subtitle')}</p>
        </div>
        {activeBranchId && (
          <Button
            variant="primary"
            onClick={() => setModal({ type: 'create' })}
            aria-label={t('devices.manage.create')}
          >
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            {t('devices.manage.create')}
          </Button>
        )}
      </div>

      {/* Branch selector */}
      {!branchesLoading && branches.length > 1 && (
        <div className="flex items-center gap-sm flex-wrap">
          <label htmlFor="branch-select" className="text-label text-text-muted">
            {t('branch.label')}
          </label>
          <select
            id="branch-select"
            value={activeBranchId ?? ''}
            onChange={(e) => {
              setActiveBranchId(e.target.value || null);
              setDevices([]);
            }}
            className="h-9 px-sm rounded-sm text-label text-text bg-surface-3 border border-border
              transition-colors duration-fast focus:outline-none focus:ring-2 focus:ring-primary"
            aria-label={t('branch.label')}
          >
            <option value="">{t('branch.all')}</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </div>
      )}

      {/* Prompt to select branch if multi-branch and nothing selected */}
      {!branchesLoading && branches.length > 1 && !activeBranchId && (
        <EmptyState
          title={t('branch.choose.title')}
          body={t('branch.label')}
        />
      )}

      {/* No branches at all */}
      {!branchesLoading && branches.length === 0 && (
        <EmptyState
          title={t('branch.empty.title')}
          body={t('branch.empty.body')}
        />
      )}

      {/* Content area — only when branch is selected */}
      {activeBranchId && (
        <>
          {/* Filter bar */}
          {!loading && !error && devices.length > 0 && (
            <div className="flex flex-wrap items-center gap-md">
              {/* Search */}
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('devices.filter.search')}
                aria-label={t('devices.filter.search')}
                className="h-9 px-sm rounded-sm text-label text-text bg-surface-3 border border-border
                  transition-colors duration-fast focus:outline-none focus:ring-2 focus:ring-primary
                  focus:border-border-strong min-w-[180px]"
              />

              {/* Type filter */}
              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
                aria-label={t('devices.filter.allTypes')}
                className="h-9 px-sm rounded-sm text-label text-text bg-surface-3 border border-border
                  transition-colors duration-fast focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="">{t('devices.filter.allTypes')}</option>
                {deviceTypes.map((dt) => (
                  <option key={dt} value={dt}>{dt}</option>
                ))}
              </select>

              {/* Status filter */}
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                aria-label={t('devices.filter.allStatuses')}
                className="h-9 px-sm rounded-sm text-label text-text bg-surface-3 border border-border
                  transition-colors duration-fast focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="all">{t('devices.filter.allStatuses')}</option>
                <option value="active">{t('devices.filter.active')}</option>
                <option value="inactive">{t('devices.filter.inactive')}</option>
              </select>
            </div>
          )}

          {/* Loading skeleton */}
          {loading && (
            <div
              className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-md"
              aria-busy="true"
              aria-label={t('state.loading')}
            >
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-40 rounded-md bg-surface-2 animate-pulse" />
              ))}
            </div>
          )}

          {/* Error */}
          {!loading && error && (
            <ErrorState message={error} onRetry={fetchDevices} />
          )}

          {/* Empty — no devices at all */}
          {!loading && !error && devices.length === 0 && (
            <EmptyState
              title={t('devices.empty.title')}
              body={t('devices.empty.body')}
              action={
                <Button variant="primary" onClick={() => setModal({ type: 'create' })}>
                  {t('devices.manage.create')}
                </Button>
              }
            />
          )}

          {/* Empty after filtering */}
          {!loading && !error && devices.length > 0 && filtered.length === 0 && (
            <EmptyState
              title={t('devices.empty.title')}
              body={t('devices.empty.body')}
            />
          )}

          {/* Device grid */}
          {!loading && !error && filtered.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-md">
              {filtered.map((device) => (
                <DeviceManageCard
                  key={device.id}
                  device={device}
                  hasActiveSession={busyDeviceIds.has(device.id)}
                  pending={pendingId === device.id}
                  onEdit={() => setModal({ type: 'edit', device })}
                  onDeactivate={() => setModal({ type: 'deactivate', device })}
                  onReactivate={() => setModal({ type: 'reactivate', device })}
                  onMaintenance={() => setModal({ type: 'maintenance', device })}
                  onReleaseMaintenance={() => setModal({ type: 'releaseMaintenance', device })}
                  t={t}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* ── Dialogs ── */}

      {/* Create */}
      {modal?.type === 'create' && activeBranchId && (
        <Dialog labelledBy="devices-dialog-title" onClose={() => setModal(null)}>
          <div className="space-y-lg">
            <h2 id="devices-dialog-title" className="text-h2 text-text">
              {t('devices.manage.create')}
            </h2>
            <DeviceForm
              branchId={activeBranchId}
              onSuccess={handleSaved}
              onCancel={() => setModal(null)}
            />
          </div>
        </Dialog>
      )}

      {/* Edit */}
      {modal?.type === 'edit' && activeBranchId && (
        <Dialog labelledBy="devices-dialog-title" onClose={() => setModal(null)}>
          <div className="space-y-lg">
            <h2 id="devices-dialog-title" className="text-h2 text-text">
              {t('devices.manage.edit')}
            </h2>
            <DeviceForm
              initial={modal.device}
              branchId={activeBranchId}
              onSuccess={handleSaved}
              onCancel={() => setModal(null)}
            />
          </div>
        </Dialog>
      )}

      {/* Deactivate confirm */}
      {modal?.type === 'deactivate' && (
        <Dialog ariaLabel={t('devices.action.deactivate')} onClose={() => setModal(null)}>
          <ConfirmDialog
            message={t('devices.action.deactivateConfirm')}
            confirmLabel={t('devices.action.deactivate')}
            confirmVariant="danger"
            loading={pendingId === modal.device.id}
            onConfirm={() =>
              void handleUpdateField(modal.device, { is_active: false })
            }
            onCancel={() => setModal(null)}
          />
        </Dialog>
      )}

      {/* Reactivate confirm */}
      {modal?.type === 'reactivate' && (
        <Dialog ariaLabel={t('devices.action.reactivate')} onClose={() => setModal(null)}>
          <ConfirmDialog
            message={t('devices.action.reactivateConfirm')}
            confirmLabel={t('devices.action.reactivate')}
            confirmVariant="primary"
            loading={pendingId === modal.device.id}
            onConfirm={() =>
              void handleUpdateField(modal.device, { is_active: true })
            }
            onCancel={() => setModal(null)}
          />
        </Dialog>
      )}

      {/* Maintenance confirm */}
      {modal?.type === 'maintenance' && (
        <Dialog ariaLabel={t('devices.action.maintenance')} onClose={() => setModal(null)}>
          <ConfirmDialog
            message={t('devices.action.maintenanceConfirm')}
            confirmLabel={t('devices.action.maintenance')}
            confirmVariant="secondary"
            loading={pendingId === modal.device.id}
            onConfirm={() =>
              void handleUpdateField(modal.device, { status: 'maintenance' })
            }
            onCancel={() => setModal(null)}
          />
        </Dialog>
      )}

      {/* Release maintenance confirm */}
      {modal?.type === 'releaseMaintenance' && (
        <Dialog ariaLabel={t('devices.action.releaseMaintenance')} onClose={() => setModal(null)}>
          <ConfirmDialog
            message={t('devices.action.releaseMaintenanceConfirm')}
            confirmLabel={t('devices.action.releaseMaintenance')}
            confirmVariant="primary"
            loading={pendingId === modal.device.id}
            onConfirm={() =>
              void handleUpdateField(modal.device, { status: 'free' })
            }
            onCancel={() => setModal(null)}
          />
        </Dialog>
      )}
    </div>
  );
}
