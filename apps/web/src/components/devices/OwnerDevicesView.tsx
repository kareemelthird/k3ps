'use client';

/**
 * OwnerDevicesView — W2 read-only owner view (design spec §W2)
 *
 * Composes the device grid + sessions table. Read-only: no mutations.
 * All data is RLS-scoped to the active tenant (from JWT claim).
 * Four states handled in each sub-section independently.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { Device, Session } from '@ps/core';
import { DeviceCard } from './DeviceCard';
import { SessionsTable } from './SessionsTable';
import { DeviceCardSkeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { getBrowserClient } from '@/lib/supabase/client';

interface OwnerDevicesViewProps {
  branchId: string;
  tenantId: string;
}

interface SessionWithDevice extends Session {
  device_name?: string;
}

export function OwnerDevicesView({ branchId, tenantId }: OwnerDevicesViewProps) {
  const t = useTranslations();

  const [devices, setDevices] = useState<Device[]>([]);
  const [sessions, setSessions] = useState<SessionWithDevice[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);

  const fetchDevices = useCallback(async () => {
    setDevicesLoading(true);
    setDevicesError(null);
    try {
      const supabase = getBrowserClient();
      // RLS-scoped: Supabase adds tenant_id filter via RLS policies.
      // We additionally filter by branch_id for this view.
      const { data, error } = await supabase
        .from('devices')
        .select('*')
        .eq('branch_id', branchId)
        .eq('is_active', true)
        .order('sort_order', { ascending: true });

      if (error) throw error;
      setDevices((data as Device[]) ?? []);
    } catch (err) {
      setDevicesError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setDevicesLoading(false);
    }
  }, [branchId]);

  const fetchSessions = useCallback(async () => {
    setSessionsLoading(true);
    setSessionsError(null);
    try {
      const supabase = getBrowserClient();
      // Fetch current (active) + recent (closed, last 50) sessions for this branch.
      // RLS ensures tenant isolation — the signed JWT claim gates which rows are visible.
      const { data, error } = await supabase
        .from('sessions')
        .select('*, devices(name)')
        .eq('branch_id', branchId)
        .in('status', ['active', 'closed'])
        .order('started_at', { ascending: false })
        .limit(50);

      if (error) throw error;

      const rows: SessionWithDevice[] = ((data as Array<Session & { devices?: { name: string } | null }>) ?? []).map(
        (row) => ({
          ...row,
          device_name: row.devices?.name,
        }),
      );
      setSessions(rows);
    } catch (err) {
      setSessionsError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setSessionsLoading(false);
    }
  }, [branchId]);

  useEffect(() => {
    void fetchDevices();
    void fetchSessions();

    // Auto-refresh every 20s (design spec: 15–30s)
    const timer = setInterval(() => {
      void fetchDevices();
      void fetchSessions();
    }, 20000);

    return () => clearInterval(timer);
  }, [fetchDevices, fetchSessions]);

  // Build a map of device_id -> active session for DeviceCard
  const activeSessionByDevice = new Map<string, SessionWithDevice>();
  sessions
    .filter((s) => s.status === 'active')
    .forEach((s) => activeSessionByDevice.set(s.device_id, s));

  return (
    <div className="space-y-2xl">
      {/* Devices section */}
      <section aria-label={t('devices.title')}>
        <h2 className="text-h2 text-text mb-md">{t('devices.title')}</h2>

        {devicesLoading && (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-card">
            {Array.from({ length: 4 }).map((_, i) => (
              <DeviceCardSkeleton key={i} />
            ))}
          </div>
        )}

        {!devicesLoading && devicesError && (
          <ErrorState message={devicesError} onRetry={fetchDevices} />
        )}

        {!devicesLoading && !devicesError && devices.length === 0 && (
          <EmptyState
            title={t('devices.empty.title')}
            body={t('devices.empty.body')}
          />
        )}

        {!devicesLoading && !devicesError && devices.length > 0 && (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-card">
            {devices.map((device) => (
              <DeviceCard
                key={device.id}
                device={device}
                session={activeSessionByDevice.get(device.id) ?? null}
              />
            ))}
          </div>
        )}
      </section>

      {/* Sessions table */}
      <SessionsTable
        sessions={sessions}
        loading={sessionsLoading}
        error={sessionsError}
        onRetry={fetchSessions}
      />
    </div>
  );
}
