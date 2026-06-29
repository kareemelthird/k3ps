/**
 * Devices API — queries and mutations for the device grid.
 * All queries are tenant + branch scoped (RLS-enforced, and explicit filter to
 * never accidentally read outside the active tenant/branch).
 * Mutations use client-generated UUIDs + upsert (idempotent).
 *
 * Phase 4: useStartSession extended for all billing modes (open/prepaid/fixed_match).
 *
 * BLOCKER (Phase 3): offline outbox is deferred to Phase 8. All writes are
 * direct (idempotent upsert with onConflict:'id').
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { nowIso, PS_UUID_NS, uuidv4, uuidv5 } from '@ps/core';
import type { BillingMode, Device, PlayMode, Session } from '@ps/core';

import { persistRow } from '../../lib/outbox';
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
  billingMode: BillingMode;
  tenantId: string;
  branchId: string;
  managerId: string;
  /** Snapshot rate in piastres (from matched rate rule or 0 for no-rule). */
  pricePerHourSnapshot: number;
  /** Rate rule id if resolved; null if no matching rule. */
  rateRuleId: string | null;
  /**
   * For prepaid: the locked total in piastres (captured at purchase, never
   * re-computed from rules — ADR-0005 Decision 6, AC 14–16).
   */
  prepaidTotal?: number | null;
  /** For prepaid: advisory display minutes (does not affect billing). */
  prepaidMinutes?: number | null;
  /** For fixed_match: initial match count (normally 0). */
  matchCount?: number;
  /**
   * Phase 5: The open shift id to stamp on the session. null if no shift open.
   * Allows the close-shift path to attribute this session's grand_total to the
   * correct drawer (Decision 3 / ADR-0006).
   */
  shiftId?: string | null;
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
        billing_mode: input.billingMode,
        status: 'active',
        started_at: startedAt,
        // For prepaid: lock prepaid_total at purchase (AC 34 / Decision 6).
        prepaid_total: input.billingMode === 'prepaid'
          ? (input.prepaidTotal ?? null)
          : null,
        prepaid_minutes: input.billingMode === 'prepaid'
          ? (input.prepaidMinutes ?? null)
          : null,
        // For fixed_match: track match_count on the session row.
        match_count: input.billingMode === 'fixed_match'
          ? (input.matchCount ?? 0)
          : null,
        // Phase 5: stamp the current open shift_id so the close-shift path can
        // attribute this session's cash sales to the drawer.
        shift_id: input.shiftId ?? null,
        time_total: 0,
        orders_total: 0,
        grand_total: 0,
        discount: 0,
        updated_at: nowIso(),
      };

      // First session_segments row: snapshots the resolved rule at start.
      // For fixed_match: price_per_hour_snapshot re-purposed as the locked
      // per-match price (ADR-0005 Decision 7).
      const segment: AnyRow = {
        id: segmentId,
        tenant_id: input.tenantId,
        session_id: sessionId,
        play_mode: input.playMode,
        rate_rule_id: input.rateRuleId,
        price_per_hour_snapshot: input.pricePerHourSnapshot,
        started_at: startedAt,
        // For prepaid and fixed_match the segment has no open end (they don't
        // have time-based open segments). For open-meter, ended_at stays null.
        ended_at: input.billingMode === 'open' ? null : startedAt,
        updated_at: nowIso(),
      };

      // Phase 8: enqueue via durable outbox (AC 11 — reroute all mutations).
      // Session first (no dependsOn); segment dependsOn session so it never
      // orphan-applies (AC 12); device update dependsOn session too.
      const deviceLocalId = uuidv5(`device-busy:${input.deviceId}:${startedAt}`, PS_UUID_NS);

      await persistRow({
        localId: sessionId,
        tenantId: input.tenantId,
        branchId: input.branchId,
        table: 'sessions',
        op: 'upsert',
        payload: session as Record<string, unknown>,
        conflict: 'merge',
      });

      await persistRow({
        localId: segmentId,
        tenantId: input.tenantId,
        branchId: input.branchId,
        table: 'session_segments',
        op: 'upsert',
        payload: segment as Record<string, unknown>,
        conflict: 'merge',
        dependsOn: [sessionId],
      });

      await persistRow({
        localId: deviceLocalId,
        tenantId: input.tenantId,
        branchId: input.branchId,
        table: 'devices',
        op: 'update',
        payload: { id: input.deviceId, status: 'busy', updated_at: nowIso(), tenant_id: input.tenantId },
        conflict: 'merge',
        dependsOn: [sessionId],
      });

      return { sessionId, segmentId };
    },

    onSettled: () => {
      if (!claim) return;
      void qc.invalidateQueries({ queryKey: ['devices', claim.tenant_id] });
      void qc.invalidateQueries({ queryKey: ['active_sessions', claim.tenant_id] });
    },
  });
}

