/**
 * Session cost aggregation (Phase 4 — ADR-0005).
 *
 * Turns segments + locked session values into the bill, in integer piastres:
 *   - open-meter  → Σ per-segment integer costs, min-charge ONCE at the first
 *                   segment's rate (never per segment, never re-rounded);
 *   - prepaid     → the LOCKED `prepaid_total` charged exactly (incl. 0), or the
 *                   documented `block_price × max(1, blocks)` fallback when null;
 *   - fixed-match → locked price × max(0, match_count);
 *   - grand total → time + orders − discount, clamped >= 0;
 *   - reconstruction → time cost from STORED snapshots ONLY (never reads current
 *                      rate_rules), proving every bill is reconstructible (§3).
 *
 * HARD RULES (CLAUDE.md §2, §4):
 *   - Integer piastres only; round once per segment; NEVER re-round the sum.
 *   - Pure: instants passed in; the wall clock is never read in cost math.
 *   - No React / RN / Expo / Next / Supabase imports.
 *
 * Re-derived from the trial's sound open-meter / prepaid-lock / fixed-match
 * algorithms; never imported from it.
 */
import type { Piastres } from '../money';
import { sumPiastres } from '../money';
import { elapsedMinutes } from '../time';
import type { BillingMode, SessionSegment } from '../types';
import { billableMinutes, openMeterCostPiastres } from './open-meter';

/** One billed open-meter segment (stored snapshot or planned). */
export interface SegmentCostInput {
  /** The FROZEN snapshot rate for this segment (integer piastres / hour). */
  price_per_hour: Piastres;
  started_at: string;
  /** For an open segment, pass at_iso (the render/close instant). */
  ended_at: string;
}

export interface OpenMeterModifiers {
  /** From the FIRST segment's resolving rule. */
  rounding_minutes: number;
  /** From the FIRST segment's resolving rule (Decision 4). */
  min_charge_minutes: number;
}

export interface OpenMeterTotal {
  /** Σ per-segment integer costs, min-charge applied once. */
  total: Piastres;
  billable_minutes: number;
}

/**
 * Sum per-segment open-meter costs (each rounded ONCE at its own snapshot rate
 * via openMeterCostPiastres / roundUpMinutes), then apply min-charge ONCE at
 * session level using the FIRST segment's rate (Decision 4). The sum is NEVER
 * re-rounded. Empty segments ⇒ { total: 0, billable_minutes: 0 }.
 *
 * Pure; instants passed in.
 */
export function aggregateOpenMeter(
  segments: SegmentCostInput[],
  mods: OpenMeterModifiers,
): OpenMeterTotal {
  if (segments.length === 0) return { total: 0, billable_minutes: 0 };

  const rounding = mods.rounding_minutes;

  // 1. Per-segment cost: round each segment's minutes once at its own rate. No
  //    min-charge here — that is a single session-level floor (step 3).
  const segmentCosts = segments.map((seg) =>
    openMeterCostPiastres(seg.started_at, seg.ended_at, seg.price_per_hour, {
      roundingMinutes: rounding,
    }),
  );
  const sumOfSegments = sumPiastres(segmentCosts);

  // 2. Total billable minutes = Σ per-segment rounded minutes (for display +
  //    the min-charge comparison). Reuse the SAME rounding the cost used.
  const totalBillable = segments.reduce((acc, seg) => {
    const elapsed = elapsedMinutes(seg.started_at, seg.ended_at);
    return acc + billableMinutes(elapsed, { roundingMinutes: rounding });
  }, 0);

  // 3. Min-charge ONCE at session level, at the FIRST segment's rate.
  const minChargeMinutes = mods.min_charge_minutes;
  if (minChargeMinutes > 0 && totalBillable < minChargeMinutes) {
    const firstRate = segments[0]!.price_per_hour;
    const minChargeCost = Math.round((minChargeMinutes * firstRate) / 60);
    return {
      total: Math.max(sumOfSegments, minChargeCost),
      billable_minutes: Math.max(totalBillable, minChargeMinutes),
    };
  }

  return { total: sumOfSegments, billable_minutes: totalBillable };
}

export interface PrepaidCostInput {
  /** LOCKED price at purchase; null ⇒ legacy fallback. */
  prepaid_total: Piastres | null;
  /** Legacy fallback only (used iff prepaid_total == null). */
  block_price?: Piastres | null;
  /** Legacy fallback; default 1, floored at 1. */
  blocks?: number;
}

/**
 * Prepaid time cost. If `prepaid_total` is non-null (INCLUDING 0) → return it
 * EXACTLY; never consult rules (lock invariant, AC 14–16). If null → legacy
 * fallback round(block_price × max(1, blocks)), defaulting block_price to 0.
 * `prepaid_minutes` is advisory (Decision 6) and is NOT an input here. Pure.
 */
export function computePrepaidCost(input: PrepaidCostInput): Piastres {
  if (input.prepaid_total != null) return input.prepaid_total;
  const blockPrice = input.block_price ?? 0;
  const blocks = Math.max(1, Math.floor(input.blocks ?? 1));
  return Math.round(blockPrice * blocks);
}

export interface FixedMatchCostInput {
  /** LOCKED at start (snapshot on the first segment). */
  fixed_match_price: Piastres;
  /** Floored at 0; null ⇒ 0. */
  match_count: number | null;
}

/** cost = fixed_match_price × max(0, match_count|0). Integer piastres. Pure. */
export function computeFixedMatchCost(input: FixedMatchCostInput): Piastres {
  const count = Math.max(0, Math.floor(input.match_count ?? 0));
  return input.fixed_match_price * count;
}

export interface GrandTotalInput {
  /** From aggregate/prepaid/fixed-match. */
  time_total: Piastres;
  /** Default 0 (Phase 5 supplies real value). */
  orders_total?: Piastres;
  /** Default 0 (Phase 5 UI; engine accepts now). */
  discount?: Piastres;
}

/** grand_total = time_total + orders_total − discount, clamped >= 0. Pure. */
export function computeGrandTotal(input: GrandTotalInput): Piastres {
  const orders = input.orders_total ?? 0;
  const discount = input.discount ?? 0;
  return Math.max(0, input.time_total + orders - discount);
}

export interface ReconstructInput {
  billing_mode: BillingMode;
  /** Stored rows: play_mode, price_per_hour_snapshot, started_at, ended_at. */
  segments: SessionSegment[];
  /** Session-level locked value (read from the session row). */
  prepaid_total?: Piastres | null;
  /** Session-level locked value (read from the session row). */
  match_count?: number | null;
  /** Modifiers anchored from the FIRST segment's rule, snapshotted at close. */
  modifiers?: OpenMeterModifiers;
  /** Instant for any still-open segment (live); omit at close. */
  at_iso?: string;
}

/**
 * Compute the time cost of a session from STORED snapshots ONLY — never reads
 * current rate_rules (CLAUDE.md §3, AC 25). Open mode → aggregateOpenMeter over
 * the segments' snapshot rates; prepaid → computePrepaidCost(prepaid_total);
 * fixed_match → computeFixedMatchCost(first-segment snapshot × match_count).
 *
 * For an open segment (ended_at == null) it bills to `at_iso` (live); at close
 * all segments are closed so the result equals the stored time_total. Pure.
 *
 * @throws if an open segment is present (ended_at == null) but `at_iso` is omitted
 *         — billing an open segment without an instant would read the clock.
 */
export function reconstructTimeCost(input: ReconstructInput): Piastres {
  switch (input.billing_mode) {
    case 'prepaid':
      return computePrepaidCost({ prepaid_total: input.prepaid_total ?? null });

    case 'fixed_match': {
      // Locked per-match price lives on the FIRST segment's snapshot (ADR-0005
      // Decision 7) — never re-resolved from current rules.
      const first = input.segments[0];
      const price = first?.price_per_hour_snapshot ?? 0;
      return computeFixedMatchCost({
        fixed_match_price: price,
        match_count: input.match_count ?? 0,
      });
    }

    case 'open':
    default: {
      const mods: OpenMeterModifiers = input.modifiers ?? {
        rounding_minutes: 0,
        min_charge_minutes: 0,
      };
      const segs: SegmentCostInput[] = input.segments.map((seg) => {
        if (seg.ended_at == null) {
          if (input.at_iso == null) {
            throw new Error(
              'reconstructTimeCost: open segment (ended_at=null) requires at_iso; ' +
                'pass the render/close instant (cost math must not read the clock).',
            );
          }
          return {
            price_per_hour: seg.price_per_hour_snapshot,
            started_at: seg.started_at,
            ended_at: input.at_iso,
          };
        }
        return {
          price_per_hour: seg.price_per_hour_snapshot,
          started_at: seg.started_at,
          ended_at: seg.ended_at,
        };
      });
      return aggregateOpenMeter(segs, mods).total;
    }
  }
}
