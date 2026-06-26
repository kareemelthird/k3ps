/**
 * Orders API — Phase 5 (ADR-0006 Decisions 2, 3, 4, 7, 8).
 *
 * Covers:
 *   - Fetching the product catalog (active only, for the order builder).
 *   - Adding an order + items to an active session OR as a walk-in.
 *   - Per-line void (sets is_void + voided_at; writes order_item.void audit).
 *   - Walk-in pay (status → paid; captures payment_method; writes stock movement
 *     for tracked products at paid-time per Decision 4; writes order.pay audit).
 *   - Session orders query (for the session fold-in into orders_total).
 *
 * HARD RULES (CLAUDE.md §2 / ADR-0006):
 *   - Integer piastres only. All totals via @ps/core computeOrderTotal /
 *     computeOrdersTotalForSession. No inline money math.
 *   - unit_price snapshot at add-time. Never re-read from catalog at close.
 *   - Stock movement only for tracked products (isTracked) at paid/close.
 *   - Warn-and-allow oversell (never block; stockStatus drives the badge).
 *   - Idempotent: client uuidv4() + upsert onConflict:'id'.
 *   - Deterministic audit IDs: uuidv5(key, PS_UUID_NS) so retries upsert
 *     in-place (no duplicate audit rows).
 *   - No service-role key in the app.
 *   - Every write carries tenant_id / branch_id from the signed JWT claim.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  businessDayKey,
  computeOrderTotal,
  computeOrdersTotalForSession,
  formatEgp,
  isTracked,
  nowIso,
  offsettingVoids,
  PS_UUID_NS,
  stockStatus,
  uuidv4,
  uuidv5,
  type Piastres,
} from '@ps/core';

import { supabase } from '../../lib/supabase';
import { persistRow } from '../../lib/outbox';
import { useAuth } from '../../stores/useAuth';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProductRow {
  id: string;
  tenant_id: string;
  name: string;
  category: string;
  price: Piastres;
  cost: Piastres | null;
  stock: number | null; // null = untracked
  is_active: boolean;
}

export interface OrderItemRow {
  id: string;
  order_id: string;
  product_id: string;
  qty: number;
  unit_price: Piastres;
  is_void: boolean;
  voided_at: string | null;
  tenant_id: string;
}

export interface OrderRow {
  id: string;
  tenant_id: string;
  branch_id: string;
  session_id: string | null;
  shift_id: string | null;
  manager_id: string;
  total: Piastres;
  status: 'open' | 'paid' | 'void';
  payment_method: 'cash' | 'wallet' | 'other' | null;
}

/** On-hand stock level (from stock_movements view). */
export interface StockLevel {
  product_id: string;
  on_hand: number;
}

// ─── Query key factory ────────────────────────────────────────────────────────

export const orderKeys = {
  products: (tenantId: string) => ['products', tenantId] as const,
  sessionOrders: (sessionId: string, tenantId: string) =>
    ['session_orders', sessionId, tenantId] as const,
  walkInOrders: (tenantId: string, branchId: string) =>
    ['walkin_orders', tenantId, branchId] as const,
  stockLevels: (tenantId: string, branchId: string) =>
    ['stock_levels', tenantId, branchId] as const,
};

// ─── Product catalog query ────────────────────────────────────────────────────

/**
 * Fetches all ACTIVE products for the tenant. Stale 30s (catalog rarely changes
 * during a shift). The mobile app renders this read-only — owners manage the
 * catalog on the web.
 */
export function useProducts(tenantId: string | null) {
  return useQuery({
    queryKey: orderKeys.products(tenantId ?? ''),
    enabled: Boolean(tenantId),
    staleTime: 30_000,
    queryFn: async (): Promise<ProductRow[]> => {
      const { data, error } = await supabase
        .from('products')
        .select('id, tenant_id, name, category, price, cost, stock, is_active')
        .eq('tenant_id', tenantId)
        .eq('is_active', true)
        .order('category', { ascending: true })
        .order('name', { ascending: true });

      if (error) throw error;
      return (data ?? []) as ProductRow[];
    },
  });
}

// ─── Stock levels query ────────────────────────────────────────────────────────

/**
 * Reads on-hand from the `product_stock_levels` view
 * (on_hand = products.stock + Σ deltas, via @ps/core computeLevels).
 * The view is security_invoker = true; RLS applies.
 *
 * NOTE: products + stock are TENANT-scoped (no branch_id — ADR-0004); the view
 * has no branch_id column, so we filter by tenant only. `branchId` is retained
 * in the query key for cache scoping and as the enable gate (stock is viewed
 * during branch ops) but is intentionally not a query filter.
 */
export function useStockLevels(tenantId: string | null, branchId: string | null) {
  return useQuery({
    queryKey: orderKeys.stockLevels(tenantId ?? '', branchId ?? ''),
    enabled: Boolean(tenantId && branchId),
    staleTime: 10_000,
    queryFn: async (): Promise<StockLevel[]> => {
      const { data, error } = await supabase
        .from('product_stock_levels')
        .select('product_id, on_hand')
        .eq('tenant_id', tenantId);

      if (error) throw error;
      return (data ?? []) as StockLevel[];
    },
  });
}

// ─── Session orders query ─────────────────────────────────────────────────────

export interface SessionOrdersData {
  orders: (OrderRow & { items: OrderItemRow[] })[];
  ordersTotal: Piastres;
}

/**
 * Loads all orders + items for a session. `ordersTotal` is the value to
 * fold into the session's grand_total via computeGrandTotal (ADR-0005).
 */
export function useSessionOrders(
  sessionId: string | undefined,
  tenantId: string | null,
) {
  return useQuery({
    queryKey: orderKeys.sessionOrders(sessionId ?? '', tenantId ?? ''),
    enabled: Boolean(sessionId && tenantId),
    staleTime: 5_000,
    queryFn: async (): Promise<SessionOrdersData> => {
      const { data: ordersData, error: ordersErr } = await supabase
        .from('orders')
        .select('*, order_items(*)')
        .eq('session_id', sessionId)
        .eq('tenant_id', tenantId)
        .neq('status', 'void');

      if (ordersErr) throw ordersErr;

      const orders = (ordersData ?? []).map((o) => ({
        ...o,
        items: (o.order_items ?? []) as OrderItemRow[],
      })) as (OrderRow & { items: OrderItemRow[] })[];

      const ordersTotal = computeOrdersTotalForSession(
        orders.map((o) => ({
          status: o.status,
          lines: o.items.map((i) => ({
            qty: i.qty,
            unit_price: i.unit_price,
            is_void: i.is_void,
          })),
        })),
      );

      return { orders, ordersTotal };
    },
  });
}

// ─── Walk-in orders query ─────────────────────────────────────────────────────

/** Loads open walk-in orders for the current branch (no session_id). */
export function useWalkInOrders(
  tenantId: string | null,
  branchId: string | null,
) {
  return useQuery({
    queryKey: orderKeys.walkInOrders(tenantId ?? '', branchId ?? ''),
    enabled: Boolean(tenantId && branchId),
    staleTime: 10_000,
    queryFn: async (): Promise<(OrderRow & { items: OrderItemRow[] })[]> => {
      const { data, error } = await supabase
        .from('orders')
        .select('*, order_items(*)')
        .eq('tenant_id', tenantId)
        .eq('branch_id', branchId)
        .is('session_id', null)
        .eq('status', 'open')
        .order('created_at', { ascending: false });

      if (error) throw error;

      return (data ?? []).map((o) => ({
        ...o,
        items: (o.order_items ?? []) as OrderItemRow[],
      })) as (OrderRow & { items: OrderItemRow[] })[];
    },
  });
}

// ─── Mutation: add order (session-attached or walk-in) ───────────────────────

export interface AddOrderInput {
  /** If null → walk-in (session_id = null). */
  sessionId: string | null;
  tenantId: string;
  branchId: string;
  managerId: string;
  /** Active shift id, if any. Stamped on the order. */
  shiftId: string | null;
  items: { productId: string; unitPrice: Piastres; qty: number }[];
}

/**
 * Creates an order + its items in one idempotent upsert pass.
 * - Client generates the order id (uuidv4) before calling.
 * - Each item id = uuidv5(`item:{orderId}:{productId}`, PS_UUID_NS) — stable on retry.
 * - unit_price is snapshotted from the catalog at call-time (the caller passes it).
 * - order.total = computeOrderTotal over the items.
 */
export function useAddOrder() {
  const qc = useQueryClient();
  const { claim } = useAuth();

  return useMutation({
    mutationFn: async (input: AddOrderInput) => {
      const now = nowIso();
      const orderId = uuidv4();

      const lineInputs = input.items.map((i) => ({
        qty: i.qty,
        unit_price: i.unitPrice,
        is_void: false as const,
      }));
      const total = computeOrderTotal(lineInputs);

      // Phase 8: enqueue via outbox. Order first; items depend on order so they
      // never orphan-apply. _syncSessionOrdersTotal removed — realtime updates it.
      await persistRow({
        localId: orderId,
        tenantId: input.tenantId,
        branchId: input.branchId,
        table: 'orders',
        op: 'upsert',
        payload: {
          id: orderId,
          tenant_id: input.tenantId,
          branch_id: input.branchId,
          session_id: input.sessionId,
          shift_id: input.shiftId,
          manager_id: input.managerId,
          total,
          status: 'open',
          payment_method: null,
          created_at: now,
          updated_at: now,
        },
        conflict: 'merge',
      });

      const itemRows = input.items.map((i) => ({
        id: uuidv5(`item:${orderId}:${i.productId}`, PS_UUID_NS),
        tenant_id: input.tenantId,
        order_id: orderId,
        product_id: i.productId,
        qty: i.qty,
        unit_price: i.unitPrice,
        is_void: false,
        voided_at: null,
        created_at: now,
        updated_at: now,
      }));

      await persistRow({
        localId: `items:${orderId}`,
        tenantId: input.tenantId,
        branchId: input.branchId,
        table: 'order_items',
        op: 'upsert',
        payload: itemRows as Record<string, unknown>[],
        conflict: 'merge',
        dependsOn: [orderId],
      });

      return { orderId, total };
    },

    onSettled: (_data, _err, input) => {
      if (input.sessionId) {
        void qc.invalidateQueries({
          queryKey: orderKeys.sessionOrders(input.sessionId, input.tenantId),
        });
      } else {
        void qc.invalidateQueries({
          queryKey: orderKeys.walkInOrders(input.tenantId, input.branchId),
        });
      }
      if (claim) {
        void qc.invalidateQueries({
          queryKey: orderKeys.stockLevels(input.tenantId, input.branchId),
        });
      }
    },
  });
}

// ─── Mutation: void a single order item ──────────────────────────────────────

export interface VoidOrderItemInput {
  itemId: string;
  orderId: string;
  sessionId: string | null;
  tenantId: string;
  branchId: string;
  managerId: string;
  /** For audit amount = qty × unit_price. */
  qty: number;
  unitPrice: Piastres;
  productId: string;
  /**
   * @deprecated Pass-through kept for existing callers; no longer drives
   * void stock logic. Stock reversal now queries the RECORDED sale movements
   * (see SHOULD-FIX 2+3).
   */
  productIsTracked?: boolean;
  orderStatus: 'open' | 'paid' | 'void';
}

/**
 * Voids a single order line (ADR-0006 Decision 2):
 *   1. Sets order_items.is_void = true, voided_at = now (idempotent update).
 *   2. Recomputes order.total (non-void lines only) and updates orders row.
 *   3. If session-attached, re-syncs session.orders_total.
 *   4. Writes order_item.void audit log row (deterministic id → idempotent).
 *   5. If the order was PAID and the product is tracked, writes an offsetting
 *      stock_movements row (reason='void', delta=+qty) per Decision 4.
 */
export function useVoidOrderItem() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: VoidOrderItemInput) => {
      const now = nowIso();
      const lineAmount = input.qty * input.unitPrice;
      const voidItemLocalId = uuidv5(`void-item:${input.itemId}`, PS_UUID_NS);

      // 1. Enqueue: mark item voided (idempotent — deterministic localId).
      await persistRow({
        localId: voidItemLocalId,
        tenantId: input.tenantId,
        branchId: input.branchId,
        table: 'order_items',
        op: 'update',
        payload: { id: input.itemId, tenant_id: input.tenantId, is_void: true, voided_at: now, updated_at: now },
        conflict: 'merge',
      });

      // 2. Read all items (supabase) to recompute order total.
      //    Include id so we can treat the newly-voided item as voided even if the
      //    outbox hasn't flushed yet. If offline this throws → void re-attempted online.
      const { data: allItems, error: itemsErr } = await supabase
        .from('order_items')
        .select('id, qty, unit_price, is_void')
        .eq('order_id', input.orderId)
        .eq('tenant_id', input.tenantId);
      if (itemsErr) throw itemsErr;

      const newTotal = computeOrderTotal(
        (allItems ?? []).map((i) => ({
          qty: i.qty,
          unit_price: i.unit_price,
          // Treat the voided item as voided even if the outbox hasn't flushed yet.
          is_void: i.id === input.itemId ? true : i.is_void,
        })),
      );

      // 3. Enqueue: update order total (dependsOn void so ordering is preserved).
      await persistRow({
        localId: uuidv5(`void-order-total:${input.orderId}:${now}`, PS_UUID_NS),
        tenantId: input.tenantId,
        branchId: input.branchId,
        table: 'orders',
        op: 'update',
        payload: { id: input.orderId, tenant_id: input.tenantId, total: newTotal, updated_at: now },
        conflict: 'merge',
        dependsOn: [voidItemLocalId],
      });

      // 4. Enqueue: audit log (dependsOn void).
      const auditId = uuidv5(`void-item:${input.itemId}`, PS_UUID_NS);
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
          action: 'order_item.void',
          entity: 'order_item',
          entity_id: input.itemId,
          amount: lineAmount,
          meta: {
            order_id: input.orderId,
            product_id: input.productId,
            qty: input.qty,
            unit_price: input.unitPrice,
          },
          created_at: now,
        },
        conflict: 'ignore',
        dependsOn: [voidItemLocalId],
      });

      // 5. Stock void offset (if the order was paid).
      if (input.orderStatus === 'paid') {
        const { data: saleMoves, error: saleMovErr } = await supabase
          .from('stock_movements')
          .select('id, product_id, delta')
          .eq('tenant_id', input.tenantId)
          .eq('order_id', input.orderId)
          .eq('product_id', input.productId)
          .eq('reason', 'sale');
        if (saleMovErr) throw saleMovErr;

        if (saleMoves && saleMoves.length > 0) {
          const voidDeltas = offsettingVoids(
            saleMoves.map((m) => ({ product_id: m.product_id, delta: m.delta })),
          );
          const voidRows = voidDeltas.map((v, idx) => ({
            id: uuidv5(`stock-void:${saleMoves[idx]!.id}`, PS_UUID_NS),
            tenant_id: input.tenantId,
            branch_id: input.branchId,
            product_id: v.product_id,
            delta: v.delta,
            reason: 'void' as const,
            order_id: input.orderId,
            manager_id: input.managerId,
            note: null,
            created_at: now,
          }));
          await persistRow({
            localId: uuidv5(`void-stock:${input.itemId}`, PS_UUID_NS),
            tenantId: input.tenantId,
            branchId: input.branchId,
            table: 'stock_movements',
            op: 'upsert',
            payload: voidRows as Record<string, unknown>[],
            conflict: 'ignore',
            dependsOn: [voidItemLocalId],
          });
        }
      }

      return { newTotal };
    },

    onSettled: (_data, _err, input) => {
      if (input.sessionId) {
        void qc.invalidateQueries({
          queryKey: orderKeys.sessionOrders(input.sessionId, input.tenantId),
        });
      } else {
        void qc.invalidateQueries({
          queryKey: orderKeys.walkInOrders(input.tenantId, input.branchId),
        });
      }
      void qc.invalidateQueries({
        queryKey: orderKeys.stockLevels(input.tenantId, input.branchId),
      });
    },
  });
}

// ─── Mutation: pay walk-in order ──────────────────────────────────────────────

export interface PayWalkInOrderInput {
  orderId: string;
  tenantId: string;
  branchId: string;
  managerId: string;
  shiftId: string | null;
  paymentMethod: 'cash' | 'wallet' | 'other';
  /** Current order total (piastres) — for the audit row. */
  total: Piastres;
  /** Items for stock movement writes (tracked only). */
  items: {
    itemId: string;
    productId: string;
    qty: number;
    unitPrice: Piastres;
    isVoid: boolean;
    isTracked: boolean;
  }[];
  cutoverHour?: number;
}

/**
 * Marks a walk-in order paid (ADR-0006 Decision 3):
 *   1. Sets orders.status='paid', payment_method, updated_at.
 *   2. Writes stock_movements (reason='sale', delta=−qty) for each NON-VOID
 *      TRACKED line (Decision 4 — write at paid-time).
 *   3. Writes order.pay audit log (deterministic id → idempotent).
 */
export function usePayWalkInOrder() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: PayWalkInOrderInput) => {
      const now = nowIso();
      const businessDay = businessDayKey(now, input.cutoverHour ?? 6);
      const payLocalId = uuidv5(`order-pay:${input.orderId}`, PS_UUID_NS);

      // 1. Enqueue: mark order paid.
      await persistRow({
        localId: payLocalId,
        tenantId: input.tenantId,
        branchId: input.branchId,
        table: 'orders',
        op: 'update',
        payload: {
          id: input.orderId,
          tenant_id: input.tenantId,
          status: 'paid',
          payment_method: input.paymentMethod,
          updated_at: now,
        },
        conflict: 'merge',
      });

      // 2. Enqueue: stock sale movements for tracked non-void lines (dependsOn pay).
      const trackedLines = input.items.filter((i) => !i.isVoid && i.isTracked);
      if (trackedLines.length > 0) {
        const movementRows = trackedLines.map((i) => ({
          id: uuidv5(`stock-sale:${i.itemId}`, PS_UUID_NS),
          tenant_id: input.tenantId,
          branch_id: input.branchId,
          product_id: i.productId,
          delta: -i.qty,
          reason: 'sale' as const,
          order_id: input.orderId,
          manager_id: input.managerId,
          note: null,
          created_at: now,
        }));
        await persistRow({
          localId: uuidv5(`pay-stock:${input.orderId}`, PS_UUID_NS),
          tenantId: input.tenantId,
          branchId: input.branchId,
          table: 'stock_movements',
          op: 'upsert',
          payload: movementRows as Record<string, unknown>[],
          conflict: 'ignore',
          dependsOn: [payLocalId],
        });
      }

      // 3. Enqueue: audit log (dependsOn pay).
      const auditId = uuidv5(`order-pay:${input.orderId}`, PS_UUID_NS);
      await persistRow({
        localId: `audit-pay:${input.orderId}`,
        tenantId: input.tenantId,
        branchId: input.branchId,
        table: 'audit_log',
        op: 'upsert',
        payload: {
          id: auditId,
          tenant_id: input.tenantId,
          branch_id: input.branchId,
          actor_id: input.managerId,
          action: 'order.pay',
          entity: 'order',
          entity_id: input.orderId,
          amount: input.total,
          meta: {
            payment_method: input.paymentMethod,
            shift_id: input.shiftId,
            business_day: businessDay,
          },
          created_at: now,
        },
        conflict: 'ignore',
        dependsOn: [payLocalId],
      });

      return { paidAt: now };
    },

    onSettled: (_data, _err, input) => {
      void qc.invalidateQueries({
        queryKey: orderKeys.walkInOrders(input.tenantId, input.branchId),
      });
      void qc.invalidateQueries({
        queryKey: orderKeys.stockLevels(input.tenantId, input.branchId),
      });
    },
  });
}

// ─── Internal helper: sync session.orders_total ───────────────────────────────

/**
 * Re-queries all non-void orders+items for a session and updates
 * sessions.orders_total. Called after any order add/void.
 *
 * This is a direct DB update (no optimistic cache for this derived field) to
 * keep it authoritative. The session detail query re-fetches on `onSettled`.
 */
async function _syncSessionOrdersTotal(
  sessionId: string,
  tenantId: string,
): Promise<void> {
  const { data: ordersData, error } = await supabase
    .from('orders')
    .select('status, order_items(qty, unit_price, is_void)')
    .eq('session_id', sessionId)
    .eq('tenant_id', tenantId)
    .neq('status', 'void');

  if (error) throw error;

  const ordersTotal = computeOrdersTotalForSession(
    (ordersData ?? []).map((o) => ({
      status: o.status as 'open' | 'paid' | 'void',
      lines: (o.order_items ?? []).map((i: { qty: number; unit_price: number; is_void: boolean }) => ({
        qty: i.qty,
        unit_price: i.unit_price,
        is_void: i.is_void,
      })),
    })),
  );

  const { error: updateErr } = await supabase
    .from('sessions')
    .update({ orders_total: ordersTotal, updated_at: nowIso() })
    .eq('id', sessionId)
    .eq('tenant_id', tenantId);

  if (updateErr) throw updateErr;
}

/** Exported for use in the session close path (writes sale movements at close). */
export async function writeSessionSaleMovements(params: {
  sessionId: string;
  tenantId: string;
  branchId: string;
  managerId: string;
  orders: (OrderRow & { items: OrderItemRow[] })[];
  cutoverHour?: number;
}): Promise<void> {
  const now = nowIso();

  // Collect all non-void, tracked lines across non-void session orders.
  const movementRows: {
    id: string;
    tenant_id: string;
    branch_id: string;
    product_id: string;
    delta: number;
    reason: 'sale';
    order_id: string;
    manager_id: string;
    note: null;
    created_at: string;
  }[] = [];

  for (const order of params.orders) {
    if (order.status === 'void') continue;
    for (const item of order.items) {
      if (item.is_void) continue;
      // We need the product's stock flag. Fetch it lazily per product.
      // Caller is responsible for only passing tracked items, or we skip.
      // This helper writes the movement for any item passed — caller filters.
      movementRows.push({
        id: uuidv5(`stock-sale:${item.id}`, PS_UUID_NS),
        tenant_id: params.tenantId,
        branch_id: params.branchId,
        product_id: item.product_id,
        delta: -item.qty,
        reason: 'sale',
        order_id: order.id,
        manager_id: params.managerId,
        note: null,
        created_at: now,
      });
    }
  }

  if (movementRows.length > 0) {
    const { error } = await supabase
      .from('stock_movements')
      .upsert(movementRows, { onConflict: 'id' });
    if (error) throw error;
  }
}

/** Convenience wrapper: checks if a raw stock value (number | null) is tracked. */
export function isProductTracked(stock: number | null): boolean {
  return isTracked({ stock });
}

// Re-export for external use
export { computeOrderTotal, computeOrdersTotalForSession, formatEgp, isTracked, stockStatus };
