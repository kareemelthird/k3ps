/**
 * Session cost aggregation (Phase 4 — ADR-0005).
 *
 * Covers AC 9–13 (open-meter sum, never re-rounded, min-charge once at first
 * rate, zero/negative elapsed, determinism), AC 14–17 (prepaid lock incl. 0,
 * rate-change-after-start, null fallback), AC 18–20 (fixed-match lock + 0/null +
 * linear scale), AC 24 (grand total clamp), AC 25/37/38 (reconstruction from
 * stored snapshots equals stored time_total), and AC 26 (3-segment switch sum).
 *
 * All instants are fixed UTC ISO — no test touches the system clock.
 */
import type { SessionSegment } from '../types';
import {
  type OpenMeterModifiers,
  type SegmentCostInput,
  aggregateOpenMeter,
  computeFixedMatchCost,
  computeGrandTotal,
  computePrepaidCost,
  reconstructTimeCost,
} from './session-cost';
import { openMeterCostPiastres } from './open-meter';

const start = '2026-06-24T10:00:00.000Z';
const at = (mins: number): string => new Date(Date.parse(start) + mins * 60_000).toISOString();

const noMods: OpenMeterModifiers = { rounding_minutes: 5, min_charge_minutes: 0 };

// ── aggregateOpenMeter (AC 9–13) ────────────────────────────────────────────

describe('aggregateOpenMeter (AC 9–13)', () => {
  it('returns zero for no segments', () => {
    expect(aggregateOpenMeter([], noMods)).toEqual({ total: 0, billable_minutes: 0 });
  });

  it('a single segment equals openMeterCostPiastres (AC 9)', () => {
    const seg: SegmentCostInput = { price_per_hour: 3000, started_at: start, ended_at: at(60) };
    const { total } = aggregateOpenMeter([seg], noMods);
    expect(total).toBe(openMeterCostPiastres(start, at(60), 3000, { roundingMinutes: 5 }));
    expect(total).toBe(3000); // 60 min @ 30 EGP/hr
  });

  it('sums per-segment integer costs and NEVER re-rounds the sum (AC 10)', () => {
    // Two segments at different rates; each rounded once at its own rate.
    const a: SegmentCostInput = { price_per_hour: 3333, started_at: start, ended_at: at(7) };
    const b: SegmentCostInput = { price_per_hour: 4444, started_at: at(7), ended_at: at(13) };
    const expected =
      openMeterCostPiastres(start, at(7), 3333, { roundingMinutes: 5 }) +
      openMeterCostPiastres(at(7), at(13), 4444, { roundingMinutes: 5 });
    expect(aggregateOpenMeter([a, b], noMods).total).toBe(expected);
  });

  it('applies min-charge ONCE at the FIRST segment rate (AC 11)', () => {
    // Two short segments at different rates; total billable < min_charge.
    const a: SegmentCostInput = { price_per_hour: 2000, started_at: start, ended_at: at(3) };
    const b: SegmentCostInput = { price_per_hour: 9999, started_at: at(3), ended_at: at(6) };
    const mods: OpenMeterModifiers = { rounding_minutes: 5, min_charge_minutes: 60 };
    // First-segment rate = 2000; min-charge = round(60 * 2000 / 60) = 2000.
    const { total, billable_minutes } = aggregateOpenMeter([a, b], mods);
    expect(total).toBe(2000);
    expect(billable_minutes).toBe(60);
  });

  it('does not apply min-charge when billable already meets the floor', () => {
    const seg: SegmentCostInput = { price_per_hour: 3000, started_at: start, ended_at: at(90) };
    const mods: OpenMeterModifiers = { rounding_minutes: 5, min_charge_minutes: 30 };
    const { total } = aggregateOpenMeter([seg], mods);
    expect(total).toBe(4500); // 90 min @ 30/hr; floor 30 not binding
  });

  it('takes max(sumOfSegments, minChargeCost) — sum wins when larger', () => {
    // Segment cost (5000) exceeds the min-charge floor cost (2000) although
    // billable minutes (3, rounded to 5) are below min_charge_minutes (60)…
    const seg: SegmentCostInput = { price_per_hour: 60000, started_at: start, ended_at: at(3) };
    const mods: OpenMeterModifiers = { rounding_minutes: 5, min_charge_minutes: 60 };
    const { total } = aggregateOpenMeter([seg], mods);
    // billable 5 min @ 600 EGP/hr = round(5*60000/60)=5000; min-charge=round(60*60000/60)=60000.
    expect(total).toBe(60000); // floor binds here (60000 > 5000)
  });

  it('zero elapsed with no min-charge bills 0 (AC 12)', () => {
    const seg: SegmentCostInput = { price_per_hour: 3000, started_at: start, ended_at: start };
    expect(aggregateOpenMeter([seg], { rounding_minutes: 5, min_charge_minutes: 0 }).total).toBe(0);
  });

  it('is deterministic — same inputs, same output (AC 13)', () => {
    const seg: SegmentCostInput = { price_per_hour: 3000, started_at: start, ended_at: at(47) };
    expect(aggregateOpenMeter([seg], noMods)).toEqual(aggregateOpenMeter([seg], noMods));
  });

  it('three segments (single→multi→single) sum to the per-segment total (AC 26)', () => {
    const s1: SegmentCostInput = { price_per_hour: 3000, started_at: start, ended_at: at(20) };
    const s2: SegmentCostInput = { price_per_hour: 5000, started_at: at(20), ended_at: at(50) };
    const s3: SegmentCostInput = { price_per_hour: 3000, started_at: at(50), ended_at: at(80) };
    const expected =
      openMeterCostPiastres(start, at(20), 3000, { roundingMinutes: 5 }) +
      openMeterCostPiastres(at(20), at(50), 5000, { roundingMinutes: 5 }) +
      openMeterCostPiastres(at(50), at(80), 3000, { roundingMinutes: 5 });
    expect(aggregateOpenMeter([s1, s2, s3], noMods).total).toBe(expected);
  });
});

// ── computePrepaidCost (AC 14–17) — the lock invariant ──────────────────────

describe('computePrepaidCost — lock invariant (AC 14–17)', () => {
  it('charges a non-null prepaid_total EXACTLY (AC 14)', () => {
    expect(computePrepaidCost({ prepaid_total: 12500 })).toBe(12500);
  });

  it('treats prepaid_total = 0 as a valid locked price, not missing (AC 15)', () => {
    expect(computePrepaidCost({ prepaid_total: 0 })).toBe(0);
  });

  it('ignores fallback fields when prepaid_total is locked (AC 16)', () => {
    // A later rate change would alter block_price; the lock must ignore it.
    expect(computePrepaidCost({ prepaid_total: 8000, block_price: 99999, blocks: 5 })).toBe(8000);
  });

  it('uses block_price × max(1, blocks) fallback only when null (AC 17)', () => {
    expect(computePrepaidCost({ prepaid_total: null, block_price: 2000, blocks: 3 })).toBe(6000);
  });

  it('fallback floors blocks at 1 and defaults block_price to 0', () => {
    expect(computePrepaidCost({ prepaid_total: null, block_price: 2000, blocks: 0 })).toBe(2000);
    expect(computePrepaidCost({ prepaid_total: null })).toBe(0);
  });
});

// ── computeFixedMatchCost (AC 18–20) ────────────────────────────────────────

describe('computeFixedMatchCost (AC 18–20)', () => {
  it('cost = price × match_count (AC 18)', () => {
    expect(computeFixedMatchCost({ fixed_match_price: 1500, match_count: 4 })).toBe(6000);
  });

  it('returns 0 for match_count 0 or null (AC 19)', () => {
    expect(computeFixedMatchCost({ fixed_match_price: 1500, match_count: 0 })).toBe(0);
    expect(computeFixedMatchCost({ fixed_match_price: 1500, match_count: null })).toBe(0);
  });

  it('floors a negative match_count at 0 (guard)', () => {
    expect(computeFixedMatchCost({ fixed_match_price: 1500, match_count: -3 })).toBe(0);
  });

  it('scales linearly with no rounding drift (AC 20)', () => {
    const p = 1234;
    for (let n = 0; n <= 10; n += 1) {
      expect(computeFixedMatchCost({ fixed_match_price: p, match_count: n })).toBe(p * n);
    }
  });
});

// ── computeGrandTotal (AC 24) ───────────────────────────────────────────────

describe('computeGrandTotal (AC 24)', () => {
  it('time + orders − discount', () => {
    expect(computeGrandTotal({ time_total: 5000, orders_total: 2000, discount: 1000 })).toBe(6000);
  });

  it('defaults orders and discount to 0', () => {
    expect(computeGrandTotal({ time_total: 5000 })).toBe(5000);
  });

  it('clamps to >= 0 when discount exceeds the bill', () => {
    expect(computeGrandTotal({ time_total: 1000, discount: 5000 })).toBe(0);
  });
});

// ── reconstructTimeCost (AC 25 / 37 / 38) ───────────────────────────────────

let segId = 0;
function storedSegment(over: Partial<SessionSegment> = {}): SessionSegment {
  segId += 1;
  return {
    id: `seg${segId}`,
    tenant_id: 't1',
    session_id: 's1',
    play_mode: 'single',
    rate_rule_id: 'r1',
    price_per_hour_snapshot: 3000,
    started_at: start,
    ended_at: at(60),
    created_at: start,
    updated_at: start,
    ...over,
  };
}

describe('reconstructTimeCost — snapshots only (AC 25/37/38)', () => {
  it('open: equals the aggregateOpenMeter over stored snapshots (single segment)', () => {
    const seg = storedSegment({ ended_at: at(60), price_per_hour_snapshot: 3000 });
    const mods: OpenMeterModifiers = { rounding_minutes: 5, min_charge_minutes: 0 };
    const storedTimeTotal = aggregateOpenMeter(
      [{ price_per_hour: 3000, started_at: start, ended_at: at(60) }],
      mods,
    ).total;
    expect(
      reconstructTimeCost({ billing_mode: 'open', segments: [seg], modifiers: mods }),
    ).toBe(storedTimeTotal);
  });

  it('open multi-segment: reconstruction equals the close-time stored total (AC 38)', () => {
    const segs = [
      storedSegment({ started_at: start, ended_at: at(20), price_per_hour_snapshot: 3000 }),
      storedSegment({ started_at: at(20), ended_at: at(50), price_per_hour_snapshot: 5000, play_mode: 'multi' }),
      storedSegment({ started_at: at(50), ended_at: at(80), price_per_hour_snapshot: 3000 }),
    ];
    const mods: OpenMeterModifiers = { rounding_minutes: 5, min_charge_minutes: 0 };
    const close = aggregateOpenMeter(
      segs.map((s) => ({ price_per_hour: s.price_per_hour_snapshot, started_at: s.started_at, ended_at: s.ended_at! })),
      mods,
    ).total;
    expect(reconstructTimeCost({ billing_mode: 'open', segments: segs, modifiers: mods })).toBe(close);
  });

  it('open: bills an open segment to at_iso (live)', () => {
    const seg = storedSegment({ ended_at: null, price_per_hour_snapshot: 3000 });
    const cost = reconstructTimeCost({
      billing_mode: 'open',
      segments: [seg],
      modifiers: { rounding_minutes: 5, min_charge_minutes: 0 },
      at_iso: at(30),
    });
    expect(cost).toBe(1500); // 30 min @ 30/hr
  });

  it('open: throws if an open segment has no at_iso (cost math must not read the clock)', () => {
    const seg = storedSegment({ ended_at: null });
    expect(() => reconstructTimeCost({ billing_mode: 'open', segments: [seg] })).toThrow(/at_iso/);
  });

  it('open: defaults modifiers to no-op when omitted', () => {
    const seg = storedSegment({ ended_at: at(60), price_per_hour_snapshot: 3000 });
    expect(reconstructTimeCost({ billing_mode: 'open', segments: [seg] })).toBe(3000);
  });

  it('prepaid: returns the locked prepaid_total, never the segments', () => {
    const seg = storedSegment({ price_per_hour_snapshot: 99999 });
    expect(
      reconstructTimeCost({ billing_mode: 'prepaid', segments: [seg], prepaid_total: 7000 }),
    ).toBe(7000);
  });

  it('prepaid: prepaid_total = 0 reconstructs to 0', () => {
    expect(reconstructTimeCost({ billing_mode: 'prepaid', segments: [], prepaid_total: 0 })).toBe(0);
  });

  it('prepaid: omitted prepaid_total falls back to the null (legacy 0) path', () => {
    expect(reconstructTimeCost({ billing_mode: 'prepaid', segments: [] })).toBe(0);
  });

  it('fixed_match: locked price from first segment × match_count', () => {
    const seg = storedSegment({ price_per_hour_snapshot: 1500 }); // re-used as per-match price
    expect(
      reconstructTimeCost({ billing_mode: 'fixed_match', segments: [seg], match_count: 3 }),
    ).toBe(4500);
  });

  it('fixed_match: 0 when no segment / no match_count', () => {
    expect(reconstructTimeCost({ billing_mode: 'fixed_match', segments: [] })).toBe(0);
  });
});
