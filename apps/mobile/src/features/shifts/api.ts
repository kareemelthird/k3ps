/**
 * Shifts API — Phase 5 (ADR-0006 Decisions 1, 3, 6, 7).
 *
 * Covers:
 *   - Fetching the currently open shift for the active branch.
 *   - Opening a shift (opening_cash, stamped shift_id on sessions/orders).
 *   - Closing a shift: compute cash_sales from cash-settled sessions/orders
 *     stamped with this shift_id, then computeShiftReconciliation, persist
 *     expected/actual/difference, write shift.close audit.
 *
 * HARD RULES (CLAUDE.md §2 / ADR-0006):
 *   - Integer piastres only. computeShiftReconciliation from @ps/core.
 *   - difference must NOT be clamped — short drawer is negative.
 *   - Business-day attribution via businessDayKey(opened_at, cutoverHour).
 *   - Idempotent: client uuidv4() + upsert onConflict:'id'.
 *   - Deterministic audit ids: uuidv5(key, PS_UUID_NS).
 *   - One open shift per branch enforced by DB partial-unique index
 *     (shifts_one_open_per_branch) — UI surfaces a graceful Arabic error.
 *   - No service-role key.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  businessDayKey,
  computeShiftReconciliation,
  nowIso,
  PS_UUID_NS,
  uuidv4,
  uuidv5,
  type Piastres,
} from '@ps/core';

import { supabase } from '../../lib/supabase';
import { persistRow } from '../../lib/outbox';
import { useAuth } from '../../stores/useAuth';
import { sessionKeys } from '../session/api';
import { orderKeys } from '../orders/api';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ShiftRow {
  id: string;
  tenant_id: string;
  branch_id: string;
  manager_id: string;
  opened_at: string;
  closed_at: string | null;
  opening_cash: Piastres;
  expected_cash: Piastres | null;
  actual_cash: Piastres | null;
  difference: Piastres | null;
  notes: string | null;
  status: 'open' | 'closed';
}

// ─── Query key factory ────────────────────────────────────────────────────────

export const shiftKeys = {
  openShift: (tenantId: string, branchId: string) =>
    ['open_shift', tenantId, branchId] as const,
  shiftList: (tenantId: string, branchId: string) =>
    ['shifts', tenantId, branchId] as const,
};

// ─── Open shift query ─────────────────────────────────────────────────────────

/**
 * Returns the currently open shift for the branch (null if none).
 * Refetched every 30s. The DB partial-unique index guarantees at most one.
 */
export function useOpenShift(
  tenantId: string | null,
  branchId: string | null,
) {
  return useQuery({
    queryKey: shiftKeys.openShift(tenantId ?? '', branchId ?? ''),
    enabled: Boolean(tenantId && branchId),
    staleTime: 30_000,
    queryFn: async (): Promise<ShiftRow | null> => {
      const { data, error } = await supabase
        .from('shifts')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('branch_id', branchId)
        .eq('status', 'open')
        .maybeSingle();

      if (error) throw error;
      return (data ?? null) as ShiftRow | null;
    },
  });
}

// ─── Mutation: open shift ─────────────────────────────────────────────────────

export interface OpenShiftInput {
  tenantId: string;
  branchId: string;
  managerId: string;
  openingCash: Piastres; // integer piastres
  cutoverHour?: number;
}

/**
 * Opens a new shift. The DB partial-unique index (shifts_one_open_per_branch)
 * will raise a unique constraint error if a shift is already open — the caller
 * surfaces an Arabic message.
 *
 * Writes shift.open audit (amount=opening_cash).
 */
export function useOpenShift_mutation() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: OpenShiftInput) => {
      const now = nowIso();
      const shiftId = uuidv4();
      const businessDay = businessDayKey(now, input.cutoverHour ?? 6);

      // Enqueue shift upsert.
      await persistRow({
        localId: shiftId,
        tenantId: input.tenantId,
        branchId: input.branchId,
        table: 'shifts',
        op: 'upsert',
        payload: {
          id: shiftId,
          tenant_id: input.tenantId,
          branch_id: input.branchId,
          manager_id: input.managerId,
          opened_at: now,
          closed_at: null,
          opening_cash: input.openingCash,
          expected_cash: 0, // NOT NULL in DB (default 0); unknown until close
          actual_cash: null,
          difference: null,
          notes: null,
          status: 'open',
          created_at: now,
          updated_at: now,
        },
        conflict: 'merge',
      });

      // Enqueue audit (dependsOn shift — never orphan-applies).
      const auditId = uuidv5(`shift-open:${shiftId}`, PS_UUID_NS);
      await persistRow({
        localId: auditId,
        tenantId: input.tenantId,
        branchId: input.branchId,
        table: 'audit_log',
        op: 'upsert',
        payload: {
          id: auditId,
          tenant_id: input.tenantId,
          branch_id: input.branchId,
          actor_id: input.managerId,
          action: 'shift.open',
          entity: 'shift',
          entity_id: shiftId,
          amount: input.openingCash,
          meta: { branch_id: input.branchId, business_day: businessDay },
          created_at: now,
        },
        conflict: 'ignore',
        dependsOn: [shiftId],
      });

      return { shiftId };
    },

    onSettled: (_data, _err, input) => {
      void qc.invalidateQueries({
        queryKey: shiftKeys.openShift(input.tenantId, input.branchId),
      });
    },
  });
}

// ─── Mutation: close shift ────────────────────────────────────────────────────

export interface CloseShiftInput {
  shiftId: string;
  tenantId: string;
  branchId: string;
  managerId: string;
  openingCash: Piastres;
  countedCash: Piastres; // what the operator counted (= actual_cash)
  payouts?: Piastres; // default 0
  notes?: string;
  cutoverHour?: number;
  /** The opened_at ISO string — for businessDayKey attribution. */
  openedAt: string;
}

/**
 * Closes a shift:
 *   1. Fetches all CASH-settled sessions + walk-in orders stamped with this shift_id.
 *   2. Computes cash_sales = Σ grand_totals (sessions) + Σ totals (walk-in orders).
 *   3. computeShiftReconciliation → expected_cash / difference.
 *   4. Persists shifts row (status='closed', reconciliation fields, closed_at).
 *   5. Writes shift.close audit (amount=difference; may be negative).
 *
 * Idempotent: close upserts with onConflict:'id'; audit id = uuidv5.
 */
export function useCloseShift() {
  const qc = useQueryClient();
  const { claim } = useAuth();

  return useMutation({
    mutationFn: async (input: CloseShiftInput) => {
      const now = nowIso();
      const businessDay = businessDayKey(input.openedAt, input.cutoverHour ?? 6);

      // 1. Fetch cash-settled sessions stamped with this shift.
      const { data: sessions, error: sessionsErr } = await supabase
        .from('sessions')
        .select('grand_total, payment_method')
        .eq('tenant_id', input.tenantId)
        .eq('branch_id', input.branchId)
        .eq('shift_id', input.shiftId)
        .eq('status', 'closed')
        .eq('payment_method', 'cash');
      if (sessionsErr) throw sessionsErr;

      // 2. Fetch cash-settled walk-in orders stamped with this shift.
      const { data: walkInOrders, error: ordersErr } = await supabase
        .from('orders')
        .select('total, payment_method')
        .eq('tenant_id', input.tenantId)
        .eq('branch_id', input.branchId)
        .eq('shift_id', input.shiftId)
        .eq('status', 'paid')
        .eq('payment_method', 'cash')
        .is('session_id', null);
      if (ordersErr) throw ordersErr;

      // 3. Sum cash sales (integer piastres, exact).
      let cashSales: Piastres = 0;
      for (const s of sessions ?? []) {
        cashSales += s.grand_total ?? 0;
      }
      for (const o of walkInOrders ?? []) {
        cashSales += o.total ?? 0;
      }

      // 4. Compute reconciliation via @ps/core (pure — Decision 3 math).
      const { expected_cash, difference } = computeShiftReconciliation({
        opening_cash: input.openingCash,
        cash_sales: cashSales,
        payouts: input.payouts ?? 0,
        counted_cash: input.countedCash,
      });

      // Phase 8: enqueue the shift update and audit through the outbox.
      const closeLocalId = uuidv5(`shift-close-update:${input.shiftId}`, PS_UUID_NS);
      await persistRow({
        localId: closeLocalId,
        tenantId: input.tenantId,
        branchId: input.branchId,
        table: 'shifts',
        op: 'update',
        payload: {
          id: input.shiftId,
          tenant_id: input.tenantId,
          status: 'closed',
          closed_at: now,
          expected_cash,
          actual_cash: input.countedCash,
          difference,
          notes: input.notes ?? null,
          updated_at: now,
        },
        conflict: 'merge',
      });

      const auditId = uuidv5(`shift-close:${input.shiftId}`, PS_UUID_NS);
      await persistRow({
        localId: auditId,
        tenantId: input.tenantId,
        branchId: input.branchId,
        table: 'audit_log',
        op: 'upsert',
        payload: {
          id: auditId,
          tenant_id: input.tenantId,
          branch_id: input.branchId,
          actor_id: input.managerId,
          action: 'shift.close',
          entity: 'shift',
          entity_id: input.shiftId,
          amount: difference,
          meta: {
            opening_cash: input.openingCash,
            expected_cash,
            actual_cash: input.countedCash,
            business_day: businessDay,
          },
          created_at: now,
        },
        conflict: 'ignore',
        dependsOn: [closeLocalId],
      });

      return { expected_cash, difference, closedAt: now };
    },

    onSettled: (_data, _err, input) => {
      void qc.invalidateQueries({
        queryKey: shiftKeys.openShift(input.tenantId, input.branchId),
      });
      void qc.invalidateQueries({
        queryKey: shiftKeys.shiftList(input.tenantId, input.branchId),
      });
      if (claim) {
        void qc.invalidateQueries({
          queryKey: sessionKeys.rateRules(input.tenantId),
        });
      }
    },
  });
}

// ─── Query: cash sales for an open shift (for pre-close expected_cash display) ──

/**
 * Fetches the cash_sales total for a given shift ID — same query used inside
 * useCloseShift but surfaced as a live query so CloseShiftForm can show the
 * expected_cash (= opening_cash + cash_sales) BEFORE the operator submits.
 *
 * Spec AC 26: show expected so the operator can count against a known target.
 * Polled every 30 s; exact match to the close math (same filter as useCloseShift).
 */
export function useShiftCashSales(
  shiftId: string | null | undefined,
  tenantId: string | null,
  branchId: string | null,
): { cashSales: Piastres; isLoading: boolean } {
  const result = useQuery({
    queryKey: ['shift_cash_sales', shiftId ?? '', tenantId ?? '', branchId ?? ''],
    enabled: Boolean(shiftId && tenantId && branchId),
    staleTime: 30_000,
    queryFn: async (): Promise<Piastres> => {
      const [{ data: sessions, error: sessErr }, { data: orders, error: ordErr }] =
        await Promise.all([
          supabase
            .from('sessions')
            .select('grand_total')
            .eq('tenant_id', tenantId)
            .eq('branch_id', branchId)
            .eq('shift_id', shiftId)
            .eq('status', 'closed')
            .eq('payment_method', 'cash'),
          supabase
            .from('orders')
            .select('total')
            .eq('tenant_id', tenantId)
            .eq('branch_id', branchId)
            .eq('shift_id', shiftId)
            .eq('status', 'paid')
            .eq('payment_method', 'cash')
            .is('session_id', null),
        ]);
      if (sessErr) throw sessErr;
      if (ordErr) throw ordErr;

      let cashSales: Piastres = 0;
      for (const s of sessions ?? []) cashSales += s.grand_total ?? 0;
      for (const o of orders ?? []) cashSales += o.total ?? 0;
      return cashSales;
    },
  });
  return { cashSales: result.data ?? 0, isLoading: result.isLoading };
}
