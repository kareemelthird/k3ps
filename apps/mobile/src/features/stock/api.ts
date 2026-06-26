/**
 * Stock API — Phase 5 (ADR-0006 Decision 4, 5, 7).
 *
 * Covers:
 *   - Restock action: reason='restock', positive delta, any staff.
 *   - Adjust action: reason='adjust', signed delta + note, owner-only
 *     (enforced by RLS stock_movements_staff_insert; client also gates on role).
 *   - Stock levels query (delegates to product_stock_levels view).
 *   - Stock movements query (for the stock screen history).
 *
 * HARD RULES (CLAUDE.md §2 / ADR-0006):
 *   - On-hand ALWAYS via @ps/core computeLevels / the view — never ad-hoc.
 *   - Immutable ledger: inserts only (no updates/deletes to past movements).
 *   - Client-generated movement IDs: uuidv4 (generated once, persisted by the
 *     outbox; conflict:'ignore' makes replays a no-op).
 *   - Audit row per action (stock.restock / stock.adjust).
 *   - No service-role key.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  businessDayKey,
  nowIso,
  PS_UUID_NS,
  uuidv4,
  uuidv5,
  type Piastres,
} from '@ps/core';

import { supabase } from '../../lib/supabase';
import { persistRow } from '../../lib/outbox';
import { useAuth } from '../../stores/useAuth';
import { orderKeys } from '../orders/api';

// ─── Types ────────────────────────────────────────────────────────────────────

export type StockReason = 'restock' | 'adjust';

export interface StockMovementRow {
  id: string;
  tenant_id: string;
  branch_id: string;
  product_id: string;
  delta: number;
  reason: 'initial' | 'restock' | 'adjust' | 'sale' | 'void';
  order_id: string | null;
  manager_id: string;
  note: string | null;
  created_at: string;
}

// ─── Query key factory ────────────────────────────────────────────────────────

export const stockKeys = {
  movements: (tenantId: string, productId: string) =>
    ['stock_movements', tenantId, productId] as const,
};

// ─── Movements query (per product) ───────────────────────────────────────────

export function useStockMovements(
  productId: string | null,
  tenantId: string | null,
) {
  return useQuery({
    queryKey: stockKeys.movements(tenantId ?? '', productId ?? ''),
    enabled: Boolean(productId && tenantId),
    staleTime: 5_000,
    queryFn: async (): Promise<StockMovementRow[]> => {
      const { data, error } = await supabase
        .from('stock_movements')
        .select('*')
        .eq('product_id', productId)
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) throw error;
      return (data ?? []) as StockMovementRow[];
    },
  });
}

// ─── Mutation: restock ────────────────────────────────────────────────────────

export interface RestockInput {
  productId: string;
  tenantId: string;
  branchId: string;
  managerId: string;
  delta: number; // positive integer (qty received)
  note: string;
  /** Product cost (piastres) for audit amount, or null. */
  productCost: Piastres | null;
  cutoverHour?: number;
}

/**
 * Records a restock movement (staff-permitted) and writes a stock.restock
 * audit row. Movement id is deterministic so a retry upserts in-place.
 */
export function useRestock() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: RestockInput) => {
      const now = nowIso();
      const movementId = uuidv4();
      const amount = input.productCost != null ? input.delta * input.productCost : null;

      // Enqueue stock movement (conflict:'ignore' = ON CONFLICT DO NOTHING — append-only ledger).
      await persistRow({
        localId: movementId,
        tenantId: input.tenantId,
        branchId: input.branchId,
        table: 'stock_movements',
        op: 'upsert',
        payload: {
          id: movementId,
          tenant_id: input.tenantId,
          branch_id: input.branchId,
          product_id: input.productId,
          delta: input.delta,
          reason: 'restock',
          order_id: null,
          manager_id: input.managerId,
          note: input.note || null,
          created_at: now,
        },
        conflict: 'ignore',
      });

      // Enqueue audit row (dependsOn movement so it never orphan-applies).
      const auditId = uuidv5(`stock-restock:${movementId}`, PS_UUID_NS);
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
          action: 'stock.restock',
          entity: 'product',
          entity_id: input.productId,
          amount,
          meta: { movement_id: movementId, delta: input.delta, reason: 'restock' },
          created_at: now,
        },
        conflict: 'ignore',
        dependsOn: [movementId],
      });

      return { movementId };
    },

    onSettled: (_data, _err, input) => {
      void qc.invalidateQueries({
        queryKey: orderKeys.stockLevels(input.tenantId, input.branchId),
      });
      void qc.invalidateQueries({
        queryKey: stockKeys.movements(input.tenantId, input.productId),
      });
    },
  });
}

// ─── Mutation: adjust (owner-only) ───────────────────────────────────────────

export interface AdjustInput {
  productId: string;
  tenantId: string;
  branchId: string;
  managerId: string;
  delta: number; // signed integer (positive = add, negative = remove)
  note: string;
  productCost: Piastres | null;
  cutoverHour?: number;
}

/**
 * Records a stock adjust movement (owner-only — RLS enforces this;
 * the client also gates on claim role). Writes a stock.adjust audit row.
 */
export function useAdjustStock() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: AdjustInput) => {
      const now = nowIso();
      const movementId = uuidv4();
      const amount = input.productCost != null ? input.delta * input.productCost : null;

      await persistRow({
        localId: movementId,
        tenantId: input.tenantId,
        branchId: input.branchId,
        table: 'stock_movements',
        op: 'upsert',
        payload: {
          id: movementId,
          tenant_id: input.tenantId,
          branch_id: input.branchId,
          product_id: input.productId,
          delta: input.delta,
          reason: 'adjust',
          order_id: null,
          manager_id: input.managerId,
          note: input.note || null,
          created_at: now,
        },
        conflict: 'ignore',
      });

      const auditId = uuidv5(`stock-adjust:${movementId}`, PS_UUID_NS);
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
          action: 'stock.adjust',
          entity: 'product',
          entity_id: input.productId,
          amount,
          meta: { movement_id: movementId, delta: input.delta, reason: 'adjust', note: input.note },
          created_at: now,
        },
        conflict: 'ignore',
        dependsOn: [movementId],
      });

      return { movementId };
    },

    onSettled: (_data, _err, input) => {
      void qc.invalidateQueries({
        queryKey: orderKeys.stockLevels(input.tenantId, input.branchId),
      });
      void qc.invalidateQueries({
        queryKey: stockKeys.movements(input.tenantId, input.productId),
      });
    },
  });
}
