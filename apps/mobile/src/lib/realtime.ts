/**
 * Tenant-scoped realtime subscription (ADR-0009 §Q5).
 *
 * Mechanism:
 *   - Subscribes to `postgres_changes` on all 7 operational tables.
 *   - The authenticated socket carries the user's JWT; Supabase Realtime
 *     evaluates the existing per-table tenant SELECT policies (migration 0004)
 *     before delivering each event — a tenant-A client CANNOT receive a
 *     tenant-B row event (AC 26, DB-enforced, not just a client filter).
 *   - `supabase.realtime.setAuth(accessToken)` is called on subscribe AND on
 *     every token refresh so RLS stays in force after a token rotation.
 *   - A client-side `filter: tenant_id=eq.<tenantId>` is added as defense-in-
 *     depth only — the security boundary is RLS, not the client filter.
 *   - Safe no-op while offline (no crash, no error spam) — reconnects when online.
 *
 * On each change event: invalidate the relevant TanStack Query caches so any
 * device on the same tenant reflects the change within a few seconds (AC 25).
 */
import { useEffect, useRef } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { queryClient } from './queryClient';
import { deviceKeys } from '../features/devices/api';
import { sessionKeys } from '../features/session/api';
import { orderKeys } from '../features/orders/api';
import { stockKeys } from '../features/stock/api';
import { shiftKeys } from '../features/shifts/api';

/** Tables published in migration 0009 with REPLICA IDENTITY FULL. */
const REALTIME_TABLES = [
  'devices',
  'sessions',
  'session_segments',
  'orders',
  'order_items',
  'stock_movements',
  'shifts',
] as const;

/**
 * Hook — call once in the authenticated layout (e.g. operate/_layout.tsx).
 * Cleans up the channel on unmount or when tenantId/branchId change.
 */
export function useRealtime(
  tenantId: string | null,
  branchId: string | null,
  accessToken: string | null,
): void {
  const channelRef = useRef<RealtimeChannel | null>(null);

  // Re-auth on token changes (AC requirement: setAuth on every token refresh)
  useEffect(() => {
    if (!accessToken) return;
    try {
      supabase.realtime.setAuth(accessToken);
    } catch {
      // setAuth may not be available in all supabase-js versions — graceful no-op
    }
  }, [accessToken]);

  useEffect(() => {
    if (!tenantId) return;

    // Tear down any existing channel before creating a new one
    if (channelRef.current) {
      void supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    }

    // Set realtime auth with the current token
    if (accessToken) {
      try {
        supabase.realtime.setAuth(accessToken);
      } catch {
        // graceful no-op
      }
    }

    const channelName = `tenant-${tenantId}`;
    let channel = supabase.channel(channelName);

    // Subscribe to all published tables, scoped to the tenant (defense-in-depth
    // filter — RLS is the actual security boundary per ADR-0009 §Q5)
    for (const table of REALTIME_TABLES) {
      channel = channel.on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table,
          filter: `tenant_id=eq.${tenantId}`,
        },
        () => {
          // Invalidate all caches related to this table so every device on the
          // tenant reflects the change. We use broad key prefixes because branch-
          // level granularity is unnecessary overhead (ADR-0009 §Q5: tenant-scope).
          invalidateForTable(table, tenantId, branchId);
        },
      );
    }

    channel.subscribe((_status, err) => {
      if (err) {
        // Subscription error (e.g. offline) — safe no-op, Supabase retries
      }
    });

    channelRef.current = channel;

    return () => {
      if (channelRef.current) {
        void supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, branchId]);
}

function invalidateForTable(
  table: (typeof REALTIME_TABLES)[number],
  tenantId: string,
  branchId: string | null,
): void {
  switch (table) {
    case 'devices':
      void queryClient.invalidateQueries({
        queryKey: deviceKeys.all(tenantId, branchId ?? ''),
      });
      break;
    case 'sessions':
    case 'session_segments':
      void queryClient.invalidateQueries({
        queryKey: ['active_sessions', tenantId],
      });
      // Also invalidate individual session details (prefix match)
      void queryClient.invalidateQueries({ queryKey: ['session', tenantId] });
      break;
    case 'orders':
    case 'order_items':
      void queryClient.invalidateQueries({
        queryKey: orderKeys.walkInOrders(tenantId, branchId ?? ''),
      });
      // session orders are scoped by sessionId; broad prefix invalidation
      void queryClient.invalidateQueries({ queryKey: ['session_orders'] });
      break;
    case 'stock_movements':
      void queryClient.invalidateQueries({
        queryKey: orderKeys.stockLevels(tenantId, branchId ?? ''),
      });
      void queryClient.invalidateQueries({ queryKey: ['stock_movements', tenantId] });
      break;
    case 'shifts':
      if (branchId) {
        void queryClient.invalidateQueries({
          queryKey: shiftKeys.openShift(tenantId, branchId),
        });
        void queryClient.invalidateQueries({
          queryKey: shiftKeys.shiftList(tenantId, branchId),
        });
      }
      break;
    default:
      break;
  }
  // Always invalidate rate rules on any change (infrequent, cheap)
  void queryClient.invalidateQueries({
    queryKey: sessionKeys.rateRules(tenantId),
  });
}
