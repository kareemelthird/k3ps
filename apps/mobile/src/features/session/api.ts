/**
 * Session API — Phase 4 deeper lifecycle.
 *
 * Queries: session + all segments (for live cost + close summary).
 * Mutations:
 *   - switchPlayMode: close current open segment (materializing boundary splits
 *     via planSegments) and open a new one. Idempotent (client UUIDs + upsert).
 *   - closeSession: planSegments over the open segment → materialize N segment
 *     rows → aggregateOpenMeter → computeGrandTotal → update session → free
 *     device → write audit_log. All writes are idempotent upserts.
 *   - incrementMatchCount: bump match_count for fixed_match sessions.
 *   - fetchRateRules: load all active rate rules for the tenant so @ps/core
 *     can resolve/compute client-side (no re-implementation of pricing here).
 *
 * HARD RULES (CLAUDE.md §2):
 *   - All cost math delegated to @ps/core — no inline money arithmetic here.
 *   - Timers from timestamps, never setInterval-accumulated money.
 *   - Integer piastres only.
 *   - Idempotent writes: client UUIDs + upsert with onConflict:'id'.
 *   - Tenant isolation: every query/write carries tenant_id from claim.
 *   - SECURITY: only the anon publishable key is used (EXPO_PUBLIC_); no
 *     service-role key in the app.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  aggregateOpenMeter,
  computeFixedMatchCost,
  computeGrandTotal,
  computePrepaidCost,
  nowIso,
  planSegments,
  PS_UUID_NS,
  resolveRule,
  uuidv4,
  uuidv5,
  type BillingMode,
  type OpenMeterModifiers,
  type PlayMode,
  type RateRule,
  type SegmentPlan,
  type Session,
  type SessionSegment,
} from '@ps/core';

import { supabase } from '../../lib/supabase';
import { useAuth } from '../../stores/useAuth';

// ─── Query key factory ────────────────────────────────────────────────────────

export const sessionKeys = {
  detail: (sessionId: string, tenantId: string) =>
    ['session', sessionId, tenantId] as const,
  segments: (sessionId: string, tenantId: string) =>
    ['session_segments', sessionId, tenantId] as const,
  rateRules: (tenantId: string) => ['rate_rules', tenantId] as const,
};

// ─── Shape types ──────────────────────────────────────────────────────────────

/** Full session row as returned from the DB. */
export type SessionRow = Session;

/** Full segment row as returned from the DB. */
export type SegmentRow = SessionSegment;

// ─── Rate-rule fetch (all active for tenant, client-side resolution) ──────────

/**
 * Fetches ALL active rate rules for the tenant. The full rule set is required
 * by @ps/core planSegments / resolveRule to enumerate boundaries correctly.
 * Stale 60s (rules rarely change during a shift).
 */
export function useRateRules(tenantId: string | null) {
  return useQuery({
    queryKey: sessionKeys.rateRules(tenantId ?? ''),
    enabled: Boolean(tenantId),
    staleTime: 60_000,
    queryFn: async (): Promise<RateRule[]> => {
      const { data, error } = await supabase
        .from('rate_rules')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('is_active', true)
        .order('priority', { ascending: false });

      if (error) throw error;
      return (data ?? []) as RateRule[];
    },
  });
}

// ─── Session + Segments query ─────────────────────────────────────────────────

export interface SessionDetailData {
  session: SessionRow;
  segments: SegmentRow[];
}

/**
 * Loads the session row + ALL its segments (ordered by started_at).
 * Re-fetched every 30s so the card stays fresh if another device updates it.
 */
export function useSessionDetail(
  sessionId: string | undefined,
  tenantId: string | null,
) {
  return useQuery({
    queryKey: sessionKeys.detail(sessionId ?? '', tenantId ?? ''),
    enabled: Boolean(sessionId && tenantId),
    refetchInterval: 30_000,
    queryFn: async (): Promise<SessionDetailData> => {
      const [sessionRes, segmentsRes] = await Promise.all([
        supabase
          .from('sessions')
          .select('*')
          .eq('id', sessionId)
          .eq('tenant_id', tenantId)
          .single(),
        supabase
          .from('session_segments')
          .select('*')
          .eq('session_id', sessionId)
          .eq('tenant_id', tenantId)
          .order('started_at', { ascending: true }),
      ]);

      if (sessionRes.error) throw sessionRes.error;
      if (segmentsRes.error) throw segmentsRes.error;

      return {
        session: sessionRes.data as SessionRow,
        segments: (segmentsRes.data ?? []) as SegmentRow[],
      };
    },
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Derive OpenMeterModifiers from the first segment's rate rule in the full
 * rules list. Falls back to {0, 0} when the rule is not found (null-safe).
 */
function modifiersFromFirstSegment(
  segments: SegmentRow[],
  rateRules: RateRule[],
): OpenMeterModifiers {
  const firstSeg = segments[0];
  if (!firstSeg?.rate_rule_id) return { rounding_minutes: 0, min_charge_minutes: 0 };
  const rule = rateRules.find((r) => r.id === firstSeg.rate_rule_id);
  if (!rule) return { rounding_minutes: 0, min_charge_minutes: 0 };
  return {
    rounding_minutes: rule.rounding_minutes,
    min_charge_minutes: rule.min_charge_minutes,
  };
}

/**
 * Compute the live grand_total (integer piastres) for an open-meter session
 * using planSegments over the single open segment + all closed segments.
 * This is the ADR-0005 preview-splits pattern: no DB write happens here.
 *
 * Takes an explicit device_type for the planSegments resolution context (so
 * rate-rule resolution is correct — never derive it from device_id). Called
 * every tick; the current instant is passed in (this helper never reads the
 * clock). Returns { timeCost, grandTotal, segmentPlans }.
 */
export function computeLiveOpenMeterWithType(
  session: SessionRow,
  segments: SegmentRow[],
  rateRules: RateRule[],
  deviceType: string,
  atIso: string,
): { timeCost: number; grandTotal: number; segmentPlans: SegmentPlan[] } {
  const closedSegs = segments.filter((s) => s.ended_at !== null);
  const openSeg = segments.find((s) => s.ended_at === null);
  const mods = modifiersFromFirstSegment(segments, rateRules);

  const closedInputs = closedSegs.map((s) => ({
    price_per_hour: s.price_per_hour_snapshot,
    started_at: s.started_at,
    ended_at: s.ended_at as string,
  }));

  let allSegmentPlans: SegmentPlan[] = [];
  let openInputs: { price_per_hour: number; started_at: string; ended_at: string }[] = [];

  if (openSeg) {
    const ctx = {
      device_type: deviceType,
      play_mode: (openSeg.play_mode ?? 'single') as PlayMode,
      billing_mode: 'open' as BillingMode,
    };

    allSegmentPlans = planSegments(rateRules, ctx, openSeg.started_at, atIso);
    openInputs = allSegmentPlans.map((p) => ({
      price_per_hour: p.price_per_hour_snapshot,
      started_at: p.started_at,
      ended_at: p.ended_at,
    }));
  }

  const allInputs = [...closedInputs, ...openInputs];
  const { total: timeCost } = aggregateOpenMeter(allInputs, mods);
  const grandTotal = computeGrandTotal({
    time_total: timeCost,
    orders_total: session.orders_total ?? 0,
    discount: session.discount ?? 0,
  });

  return { timeCost, grandTotal, segmentPlans: allSegmentPlans };
}

// ─── Mutation: switch play mode ───────────────────────────────────────────────

export interface SwitchPlayModeInput {
  sessionId: string;
  tenantId: string;
  /** The open segment to close. */
  openSegment: SegmentRow;
  /** New play mode to open. */
  newPlayMode: PlayMode;
  /** Device type for rule resolution (from the device row). */
  deviceType: string;
  /** All active rate rules (fetched client-side). */
  rateRules: RateRule[];
}

/**
 * Close the open segment (materializing boundary splits via planSegments) and
 * open a new segment with the new play mode. Idempotent: client UUIDs + upsert.
 *
 * A mode switch at time T may span multiple boundaries between
 * [openSeg.started_at, T): planSegments writes those sub-segments all at once
 * so no boundary is hidden (ADR-0005 Decision 1: operator action materializes).
 */
export function useSwitchPlayMode() {
  const qc = useQueryClient();
  const { claim } = useAuth();

  return useMutation({
    mutationFn: async (input: SwitchPlayModeInput) => {
      const switchedAt = nowIso();

      // 1. Materialize sub-segments for the closed portion [openSeg.started_at, switchedAt).
      //    planSegments enumerates boundaries in that range (ADR-0005 §3).
      const closedPlans = planSegments(
        input.rateRules,
        {
          device_type: input.deviceType,
          play_mode: input.openSegment.play_mode,
          billing_mode: 'open',
        },
        input.openSegment.started_at,
        switchedAt,
      );

      // 2. For each plan, create a segment row (deterministic UUID, idempotent upsert).
      //    The FIRST plan's id re-uses the existing open segment's id (upsert
      //    updates it in-place). Plans 2..N use uuidv5 keyed by
      //    '{sessionId}:{plan.started_at}' so a replay always maps to the SAME row
      //    — no duplicate sub-segments (BLOCKER 3 / CLAUDE.md §2.8).
      const segmentRows = closedPlans.map((plan, idx) => ({
        id: idx === 0
          ? input.openSegment.id
          : uuidv5(`seg:${input.sessionId}:${plan.started_at}`, PS_UUID_NS),
        tenant_id: input.tenantId,
        session_id: input.sessionId,
        play_mode: plan.play_mode,
        rate_rule_id: plan.rate_rule_id,
        price_per_hour_snapshot: plan.price_per_hour_snapshot,
        started_at: plan.started_at,
        ended_at: plan.ended_at,
        updated_at: nowIso(),
      }));

      // 3. Resolve the rate for the NEW segment at switchedAt.
      const newRule = resolveRule(input.rateRules, {
        device_type: input.deviceType,
        play_mode: input.newPlayMode,
        billing_mode: 'open',
        at_iso: switchedAt,
      });

      const newSegmentId = uuidv4();
      const newSegmentRow = {
        id: newSegmentId,
        tenant_id: input.tenantId,
        session_id: input.sessionId,
        play_mode: input.newPlayMode,
        rate_rule_id: newRule?.id ?? null,
        price_per_hour_snapshot: newRule?.price_per_hour ?? 0,
        started_at: switchedAt,
        ended_at: null,
        updated_at: nowIso(),
      };

      // 4. Write all closed sub-segments + the new open segment as idempotent upserts.
      const { error: segsErr } = await supabase
        .from('session_segments')
        .upsert([...segmentRows, newSegmentRow], { onConflict: 'id' });
      if (segsErr) throw segsErr;

      return { switchedAt, newSegmentId };
    },

    onSettled: (data, _err, input) => {
      void qc.invalidateQueries({
        queryKey: sessionKeys.detail(input.sessionId, input.tenantId),
      });
      void qc.invalidateQueries({
        queryKey: sessionKeys.segments(input.sessionId, input.tenantId),
      });
      if (claim) {
        void qc.invalidateQueries({ queryKey: ['active_sessions', claim.tenant_id] });
      }
    },
  });
}

// ─── Mutation: close session ──────────────────────────────────────────────────

export interface CloseSessionPhase4Input {
  sessionId: string;
  deviceId: string;
  tenantId: string;
  branchId: string;
  managerId: string;
  session: SessionRow;
  segments: SegmentRow[];
  rateRules: RateRule[];
  /** Device type for planSegments rule resolution. */
  deviceType: string;
}

/**
 * Close the session. For open-meter:
 *   1. planSegments over the open segment → materialize N segment rows.
 *   2. aggregateOpenMeter over ALL segments (closed prior + new) → time_total.
 *   3. computeGrandTotal → grand_total.
 *   4. Update session (status, ended_at, time_total, grand_total).
 *   5. Free the device.
 *   6. Write audit_log (idempotent upsert).
 *
 * For prepaid / fixed_match: skip planSegments; compute cost from locked values.
 * All writes are idempotent (client UUIDs + upsert).
 *
 * ADR-0005 invariant: the same planSegments that drives the live preview drives
 * the close — so live total == stored total for the same atIso.
 */
export function useCloseSessionPhase4() {
  const qc = useQueryClient();
  const { claim } = useAuth();

  return useMutation({
    mutationFn: async (input: CloseSessionPhase4Input) => {
      const endedAt = nowIso();
      const now = endedAt;
      const billingMode = input.session.billing_mode;

      let timeTotalPiastres = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const newSegmentRows: any[] = [];

      if (billingMode === 'open') {
        // ── Open-meter close ──
        // Materialize the open segment via planSegments (ADR-0005 Decision 1).
        const openSeg = input.segments.find((s) => s.ended_at === null);
        const closedSegs = input.segments.filter((s) => s.ended_at !== null);

        // Derive modifiers from the first segment's rule.
        const mods = modifiersFromFirstSegment(input.segments, input.rateRules);

        // Previously closed segments: feed their snapshots directly.
        const closedInputs = closedSegs.map((s) => ({
          price_per_hour: s.price_per_hour_snapshot,
          started_at: s.started_at,
          ended_at: s.ended_at as string,
        }));

        let openInputs: { price_per_hour: number; started_at: string; ended_at: string }[] = [];

        if (openSeg) {
          const ctx = {
            device_type: input.deviceType,
            play_mode: (openSeg.play_mode ?? 'single') as PlayMode,
            billing_mode: 'open' as BillingMode,
          };

          const plans = planSegments(input.rateRules, ctx, openSeg.started_at, endedAt);

          // Materialize: first plan reuses the existing segment id (idempotent).
          // Plans 2..N use uuidv5 keyed by '{sessionId}:{plan.started_at}' so
          // a retry always maps the same boundary-split to the same row id —
          // no duplicate sub-segments on retry (BLOCKER 3 / CLAUDE.md §2.8).
          plans.forEach((plan, idx) => {
            newSegmentRows.push({
              id: idx === 0
                ? openSeg.id
                : uuidv5(`seg:${input.sessionId}:${plan.started_at}`, PS_UUID_NS),
              tenant_id: input.tenantId,
              session_id: input.sessionId,
              play_mode: plan.play_mode,
              rate_rule_id: plan.rate_rule_id,
              price_per_hour_snapshot: plan.price_per_hour_snapshot,
              started_at: plan.started_at,
              ended_at: plan.ended_at,
              updated_at: now,
            });
          });

          openInputs = plans.map((p) => ({
            price_per_hour: p.price_per_hour_snapshot,
            started_at: p.started_at,
            ended_at: p.ended_at,
          }));
        }

        const allInputs = [...closedInputs, ...openInputs];
        const { total } = aggregateOpenMeter(allInputs, mods);
        timeTotalPiastres = total;

      } else if (billingMode === 'prepaid') {
        // ── Prepaid close: use locked prepaid_total (never re-compute from rules) ──
        // If prepaid_total is non-null (including 0) it is returned exactly.
        // Legacy fallback (prepaid_total == null): read block_price and blocks
        // from the first segment's snapshot so the fallback matches the engine
        // contract (block_price × max(1, blocks)) — not just 0 (SHOULD-FIX 5).
        const firstSeg = input.segments[0];
        const resolvedRule = firstSeg?.rate_rule_id
          ? input.rateRules.find((r) => r.id === firstSeg.rate_rule_id) ?? null
          : null;
        timeTotalPiastres = computePrepaidCost({
          prepaid_total: input.session.prepaid_total ?? null,
          block_price: resolvedRule?.price_per_hour ?? firstSeg?.price_per_hour_snapshot ?? 0,
          blocks: 1,
        });

      } else if (billingMode === 'fixed_match') {
        // ── Fixed-match close: locked price × match_count ──
        const firstSeg = input.segments[0];
        timeTotalPiastres = computeFixedMatchCost({
          fixed_match_price: firstSeg?.price_per_hour_snapshot ?? 0,
          match_count: input.session.match_count ?? 0,
        });
      }

      const grandTotal = computeGrandTotal({
        time_total: timeTotalPiastres,
        orders_total: input.session.orders_total ?? 0,
        discount: input.session.discount ?? 0,
      });

      // Write materialized segments (open-meter only; others have no new segments).
      if (newSegmentRows.length > 0) {
        const { error: segsErr } = await supabase
          .from('session_segments')
          .upsert(newSegmentRows, { onConflict: 'id' });
        if (segsErr) throw segsErr;
      }

      // Update session row.
      const { error: sessionErr } = await supabase
        .from('sessions')
        .update({
          status: 'closed',
          ended_at: endedAt,
          time_total: timeTotalPiastres,
          grand_total: grandTotal,
          updated_at: now,
        })
        .eq('id', input.sessionId)
        .eq('tenant_id', input.tenantId);
      if (sessionErr) throw sessionErr;

      // Free the device.
      const { error: deviceErr } = await supabase
        .from('devices')
        .update({ status: 'free', updated_at: now })
        .eq('id', input.deviceId)
        .eq('tenant_id', input.tenantId);
      if (deviceErr) throw deviceErr;

      // Write audit_log (deterministic UUID → idempotent upsert; one close = one row).
      // uuidv5 key 'close:{sessionId}' is stable: any retry produces the SAME id
      // and the upsert updates-in-place instead of inserting a second row
      // (BLOCKER 3 / AC 40 / CLAUDE.md §2.8).
      const auditId = uuidv5(`close:${input.sessionId}`, PS_UUID_NS);
      const { error: auditErr } = await supabase
        .from('audit_log')
        .upsert(
          {
            id: auditId,
            tenant_id: input.tenantId,
            branch_id: input.branchId,
            actor_id: input.managerId,
            action: 'session.close',
            entity: 'sessions',
            entity_id: input.sessionId,
            amount: grandTotal,
            meta: {
              billing_mode: billingMode,
              device_id: input.deviceId,
              time_total: timeTotalPiastres,
            },
            created_at: now,
          },
          { onConflict: 'id' },
        );
      if (auditErr) throw auditErr;

      return { grandTotal, timeTotalPiastres, endedAt };
    },

    onSettled: (_data, _err, input) => {
      void qc.invalidateQueries({
        queryKey: sessionKeys.detail(input.sessionId, input.tenantId),
      });
      if (claim) {
        void qc.invalidateQueries({ queryKey: ['devices', claim.tenant_id] });
        void qc.invalidateQueries({ queryKey: ['active_sessions', claim.tenant_id] });
      }
    },
  });
}

// ─── Mutation: increment match count ─────────────────────────────────────────

export interface IncrementMatchCountInput {
  sessionId: string;
  tenantId: string;
  currentCount: number;
  delta: 1 | -1;
}

/** Bump match_count for a fixed_match session. Idempotent: last-write-wins. */
export function useIncrementMatchCount() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: IncrementMatchCountInput) => {
      const newCount = Math.max(0, input.currentCount + input.delta);
      const { error } = await supabase
        .from('sessions')
        .update({
          match_count: newCount,
          updated_at: nowIso(),
        })
        .eq('id', input.sessionId)
        .eq('tenant_id', input.tenantId);
      if (error) throw error;
      return { newCount };
    },
    onSettled: (_data, _err, input) => {
      void qc.invalidateQueries({
        queryKey: sessionKeys.detail(input.sessionId, input.tenantId),
      });
    },
  });
}

// ─── Re-export the Phase-3 start mutation (now extended to all billing modes) ─

export type { StartSessionInput } from '../devices/api';
