/**
 * Devices API — queries and mutations for the device grid.
 * All queries are tenant + branch scoped (RLS-enforced, and explicit filter to
 * never accidentally read outside the active tenant/branch).
 * Mutations use client-generated UUIDs + upsert (idempotent).
 *
 * BLOCKER (Phase 3): offline outbox is deferred to Phase 8. Enqueue calls are
 * removed; all writes are direct (idempotent upsert with onConflict:'id').
 * outbox.ts stays in place (reserved for Phase 8) but nothing calls enqueue here.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { nowIso, uuidv4 } from '@ps/core';
import type { Device, PlayMode, Session } from '@ps/core';

import { supabase } from '../../lib/supabase';
import { useAuth } from '../../stores/useAuth';

// Shorthand for untyped supabase data rows
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRow = any;

// ─── Query keys ───────────────────────────────────────────────────────────────
export const deviceKeys = {
  all: (tenantId: string, branchId: string) =>
    ['devices', tenantId, branchId] as const,
  active_sessions: (tenantId: string, branchId: string) =>
    ['active_sessions', tenantId, branchId] as const,
};

// ─── Queries ──────────────────────────────────────────────────────────────────

export function useDevices(tenantId: string | null, branchId: string | null) {
  return useQuery({
    queryKey: deviceKeys.all(tenantId ?? '', branchId ?? ''),
    enabled: Boolean(tenantId && branchId),
    queryFn: async (): Promise<Device[]> => {
      const { data, error } = await supabase
        .from('devices')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('branch_id', branchId)
        .eq('is_active', true)
        .order('sort_order', { ascending: true });

      if (error) throw error;
      return (data ?? []) as Device[];
    },
    refetchInterval: 20_000,
  });
}

export function useActiveSessions(
  tenantId: string | null,
  branchId: string | null,
) {
  return useQuery({
    queryKey: deviceKeys.active_sessions(tenantId ?? '', branchId ?? ''),
    enabled: Boolean(tenantId && branchId),
    queryFn: async (): Promise<Session[]> => {
      const { data, error } = await supabase
        .from('sessions')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('branch_id', branchId)
        .eq('status', 'active');

      if (error) throw error;
      return (data ?? []) as Session[];
    },
    refetchInterval: 20_000,
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export interface StartSessionInput {
  deviceId: string;
  playMode: PlayMode;
  tenantId: string;
  branchId: string;
  managerId: string;
  /** Snapshot rate in piastres (from matched rate rule or 0 for skeleton). */
  pricePerHourSnapshot: number;
  /** Rate rule id if resolved; null for skeleton. */
  rateRuleId: string | null;
}

export function useStartSession() {
  const qc = useQueryClient();
  const { claim } = useAuth();

  return useMutation({
    mutationFn: async (input: StartSessionInput) => {
      const sessionId = uuidv4();
      const segmentId = uuidv4();
      const startedAt = nowIso();

      const session: AnyRow = {
        id: sessionId,
        tenant_id: input.tenantId,
        branch_id: input.branchId,
        device_id: input.deviceId,
        manager_id: input.managerId,
        billing_mode: 'open',
        status: 'active',
        started_at: startedAt,
        time_total: 0,
        orders_total: 0,
        grand_total: 0,
        discount: 0,
        updated_at: nowIso(),
      };

      const segment: AnyRow = {
        id: segmentId,
        tenant_id: input.tenantId,
        session_id: sessionId,
        play_mode: input.playMode,
        rate_rule_id: input.rateRuleId,
        price_per_hour_snapshot: input.pricePerHourSnapshot,
        started_at: startedAt,
        updated_at: nowIso(),
      };

      // Direct idempotent writes (Phase 3). Outbox deferred to Phase 8.
      const { error: sessionErr } = await supabase
        .from('sessions')
        .upsert(session, { onConflict: 'id' });
      if (sessionErr) throw sessionErr;

      await supabase
        .from('session_segments')
        .upsert(segment, { onConflict: 'id' });

      await supabase
        .from('devices')
        .update({ status: 'busy', updated_at: nowIso() })
        .eq('id', input.deviceId)
        .eq('tenant_id', input.tenantId);

      return { sessionId, segmentId };
    },

    onSettled: () => {
      if (!claim) return;
      void qc.invalidateQueries({ queryKey: ['devices', claim.tenant_id] });
      void qc.invalidateQueries({ queryKey: ['active_sessions', claim.tenant_id] });
    },
  });
}

export interface CloseSessionInput {
  sessionId: string;
  deviceId: string;
  tenantId: string;
  branchId: string;
  managerId: string;
  timeTotalPiastres: number;
  endedAt: string;
}

export function useCloseSession() {
  const qc = useQueryClient();
  const { claim } = useAuth();

  return useMutation({
    mutationFn: async (input: CloseSessionInput) => {
      const grandTotal = Math.max(0, input.timeTotalPiastres);
      const now = nowIso();

      const auditRow: AnyRow = {
        id: uuidv4(),
        tenant_id: input.tenantId,
        branch_id: input.branchId,
        actor_id: input.managerId,
        action: 'session.close',
        entity: 'sessions',
        entity_id: input.sessionId,
        amount: grandTotal,
        meta: { device_id: input.deviceId },
        created_at: now,
      };

      // Direct idempotent writes (Phase 3). Outbox deferred to Phase 8.
      const { error: closeErr } = await supabase
        .from('sessions')
        .update({
          status: 'closed',
          ended_at: input.endedAt,
          time_total: grandTotal,
          grand_total: grandTotal,
          updated_at: now,
        })
        .eq('id', input.sessionId)
        .eq('tenant_id', input.tenantId);
      if (closeErr) throw closeErr;

      // SHOULD-FIX: upsert (not insert) — idempotent on replay (onConflict:'id')
      await supabase
        .from('audit_log')
        .upsert(auditRow, { onConflict: 'id' });

      await supabase
        .from('devices')
        .update({ status: 'free', updated_at: now })
        .eq('id', input.deviceId)
        .eq('tenant_id', input.tenantId);

      return { grandTotal };
    },

    onSettled: () => {
      if (!claim) return;
      void qc.invalidateQueries({ queryKey: ['devices', claim.tenant_id] });
      void qc.invalidateQueries({ queryKey: ['active_sessions', claim.tenant_id] });
    },
  });
}
