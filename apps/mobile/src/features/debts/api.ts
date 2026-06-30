/**
 * Debts API — Slice 3 (ADR-0012).
 *
 * Covers:
 *   - useCustomers: query tenant customers, optionally filtered by name/phone.
 *   - useCreateCustomer: insert a customer via the offline outbox.
 *   - useOpenDebts: select non-settled debts for the tenant.
 *   - useRecordDebtPayment: insert a debt_payments row + audit_log via outbox.
 *     An AFTER-INSERT DB trigger recomputes the parent debt's paid_total and status,
 *     so after settle we only need to invalidate the debts query.
 *
 * HARD RULES (CLAUDE.md §2):
 *   - All money is integer piastres — never floats.
 *   - Writes go through persistRow (offline outbox) — never direct Supabase calls.
 *   - Client-generated UUIDs (uuidv4); idempotent upsert with conflict:'ignore'
 *     for ledger rows so replays after a crash never double-count.
 *   - Deterministic audit id: uuidv5('debt-payment:{paymentId}', PS_UUID_NS).
 *   - Tenant isolation: every query/write carries tenant_id from the JWT claim.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  nowIso,
  PS_UUID_NS,
  uuidv4,
  uuidv5,
  type Piastres,
} from '@ps/core';

import { supabase } from '../../lib/supabase';
import { persistRow } from '../../lib/outbox';
import { useAuth } from '../../stores/useAuth';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CustomerRow {
  id: string;
  tenant_id: string;
  name: string;
  phone: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export type DebtStatus = 'open' | 'partially_paid' | 'settled';

export interface DebtRow {
  id: string;
  tenant_id: string;
  customer_id: string | null;
  customer_name: string;
  /** Amount owed (piastres) — locked at session close. */
  amount: Piastres;
  /** Cumulative paid (piastres) — maintained by the DB AFTER-INSERT trigger. */
  paid_total: Piastres;
  /** Derived: amount − paid_total. Never stored. */
  remaining: Piastres;
  session_id: string | null;
  manager_id: string;
  shift_id: string | null;
  note: string | null;
  status: DebtStatus;
  created_at: string;
  updated_at: string;
}

// ─── Query key factory ────────────────────────────────────────────────────────

export const debtKeys = {
  customers: (tenantId: string, search: string) =>
    ['customers', tenantId, search] as const,
  openDebts: (tenantId: string) => ['debts_open', tenantId] as const,
};

// ─── Queries ──────────────────────────────────────────────────────────────────

/**
 * Query tenant customers, optionally filtered by name (case-insensitive ilike).
 * Pass `enabled: false` to suppress the fetch (e.g., when the debt payment method
 * is not selected in the close sheet).
 */
export function useCustomers(
  search?: string,
  options?: { enabled?: boolean },
) {
  const { claim } = useAuth();
  const tenantId = claim?.tenant_id ?? null;
  const searchTerm = search?.trim() ?? '';

  return useQuery({
    queryKey: debtKeys.customers(tenantId ?? '', searchTerm),
    enabled: (options?.enabled ?? true) && Boolean(tenantId),
    staleTime: 30_000,
    queryFn: async (): Promise<CustomerRow[]> => {
      let q = supabase
        .from('customers')
        .select('*')
        .eq('tenant_id', tenantId!)
        .order('name', { ascending: true })
        .limit(50);

      if (searchTerm) {
        q = q.ilike('name', `%${searchTerm}%`);
      }

      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as CustomerRow[];
    },
  });
}

/**
 * Query all non-settled debts for the tenant, newest first.
 * Derives `remaining = amount − paid_total` on each row.
 */
export function useOpenDebts() {
  const { claim } = useAuth();
  const tenantId = claim?.tenant_id ?? null;

  return useQuery({
    queryKey: debtKeys.openDebts(tenantId ?? ''),
    enabled: Boolean(tenantId),
    staleTime: 30_000,
    refetchInterval: 60_000,
    queryFn: async (): Promise<DebtRow[]> => {
      const { data, error } = await supabase
        .from('debts')
        .select('*')
        .eq('tenant_id', tenantId!)
        .neq('status', 'settled')
        .order('created_at', { ascending: false });

      if (error) throw error;

      return ((data ?? []) as Omit<DebtRow, 'remaining'>[]).map((row) => ({
        ...row,
        remaining: (row.amount - row.paid_total) as Piastres,
      }));
    },
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export interface CreateCustomerInput {
  name: string;
  phone?: string | null;
  note?: string | null;
}

/**
 * Insert a new customer via the offline outbox.
 * Returns the client-generated `customerId` so the caller can link it
 * to a debt close (e.g., pass as customer_id in DebtClosePayload).
 *
 * conflict:'ignore' → idempotent: a replayed write is a no-op.
 */
export function useCreateCustomer() {
  const qc = useQueryClient();
  const { claim } = useAuth();

  return useMutation({
    mutationFn: async (input: CreateCustomerInput) => {
      const tenantId = claim?.tenant_id;
      if (!tenantId) throw new Error('No tenant');

      const now = nowIso();
      const customerId = uuidv4();

      await persistRow({
        localId: customerId,
        tenantId,
        branchId: null,
        table: 'customers',
        op: 'upsert',
        payload: {
          id: customerId,
          tenant_id: tenantId,
          name: input.name,
          phone: input.phone ?? null,
          note: input.note ?? null,
          created_at: now,
          updated_at: now,
        },
        conflict: 'ignore',
      });

      return { customerId };
    },

    onSettled: () => {
      const tenantId = claim?.tenant_id;
      if (!tenantId) return;
      void qc.invalidateQueries({ queryKey: ['customers', tenantId] });
    },
  });
}

export interface RecordDebtPaymentInput {
  /** The debt being paid. */
  debtId: string;
  /** Amount paid (integer piastres). Must be > 0. */
  amount: Piastres;
}

/**
 * Record a payment against an open or partially-paid debt.
 *
 * Two outbox rows:
 *   1. debt_payments (conflict:'ignore' — append-only ledger, idempotent replay).
 *   2. audit_log (conflict:'ignore', dependsOn the payment row — never orphaned).
 *
 * The AFTER-INSERT DB trigger on debt_payments automatically recomputes
 * `debts.paid_total` and `debts.status`. The caller only needs to invalidate
 * the debts query after settle.
 *
 * RLS (`debt_payments_insert`) enforces:
 *   tenant match AND (debt.manager_id = auth.uid() OR is_tenant_owner())
 *   AND has_permission('can_manage_debts').
 * A rejected write enters the dead-letter queue; the Sync screen surfaces it.
 */
export function useRecordDebtPayment() {
  const qc = useQueryClient();
  const { claim, user, activeBranchId } = useAuth();

  return useMutation({
    mutationFn: async (input: RecordDebtPaymentInput) => {
      const tenantId = claim?.tenant_id;
      const managerId = user?.id;
      if (!tenantId || !managerId) throw new Error('Not authenticated');

      const now = nowIso();
      const paymentId = uuidv4();
      const branchId = activeBranchId ?? null;

      // 1. Debt payment row (append-only ledger).
      await persistRow({
        localId: paymentId,
        tenantId,
        branchId,
        table: 'debt_payments',
        op: 'upsert',
        payload: {
          id: paymentId,
          tenant_id: tenantId,
          debt_id: input.debtId,
          amount: input.amount,
          manager_id: managerId,
          shift_id: null,
          created_at: now,
          updated_at: now,
        },
        conflict: 'ignore',
      });

      // 2. Audit row (deterministic id — replay is a no-op).
      const auditId = uuidv5(`debt-payment:${paymentId}`, PS_UUID_NS);
      await persistRow({
        localId: auditId,
        tenantId,
        branchId,
        table: 'audit_log',
        op: 'upsert',
        payload: {
          id: auditId,
          tenant_id: tenantId,
          branch_id: branchId,
          actor_id: managerId,
          action: 'debt.payment',
          entity: 'debts',
          entity_id: input.debtId,
          amount: input.amount,
          meta: { payment_id: paymentId, debt_id: input.debtId },
          created_at: now,
        },
        conflict: 'ignore',
        dependsOn: [paymentId],
      });

      return { paymentId };
    },

    onSettled: () => {
      const tenantId = claim?.tenant_id;
      if (!tenantId) return;
      void qc.invalidateQueries({ queryKey: debtKeys.openDebts(tenantId) });
    },
  });
}
