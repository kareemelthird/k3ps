/**
 * Rate-rule resolution + boundary enumeration (Phase 4 — ADR-0005).
 *
 * Covers AC 1–8 (resolution: match predicate, priority, id tie-break, no-match
 * null, Cairo weekend incl. UTC↔Cairo boundary, end-exclusive + midnight-wrap
 * windows, null-bound all-day, purity) and AC 21–22/26-shape (boundary
 * enumeration + planSegments determinism, single segment, exact-boundary
 * instant, multi-window off-peak→peak→after-midnight, DST-spanning boundary).
 *
 * All instants are fixed UTC ISO — no test touches the system clock.
 */
import type { BillingMode, PlayModeRule, DayTypeRule, RateRule } from '../types';
import {
  type BoundaryContext,
  type RuleContext,
  planSegments,
  rateBoundaryInstants,
  resolveRule,
  ruleMatches,
} from './rate-rules';

// ── Fixtures ────────────────────────────────────────────────────────────────

let nextId = 0;
function rule(overrides: Partial<RateRule> = {}): RateRule {
  nextId += 1;
  return {
    id: `r${String(nextId).padStart(3, '0')}`,
    tenant_id: 't1',
    device_type: 'ps5',
    play_mode: 'single' as PlayModeRule,
    billing_mode: 'open' as BillingMode,
    day_type: 'any' as DayTypeRule,
    time_start: null,
    time_end: null,
    price_per_hour: 3000, // 30 EGP/hr in piastres
    block_minutes: null,
    block_price: null,
    fixed_match_price: null,
    rounding_minutes: 5,
    min_charge_minutes: 0,
    priority: 0,
    is_active: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const ctx = (over: Partial<RuleContext> = {}): RuleContext => ({
  device_type: 'ps5',
  play_mode: 'single',
  billing_mode: 'open',
  at_iso: '2026-06-24T12:00:00.000Z', // a Wednesday (weekday in Cairo)
  ...over,
});

const bctx = (over: Partial<BoundaryContext> = {}): BoundaryContext => ({
  device_type: 'ps5',
  play_mode: 'single',
  billing_mode: 'open',
  ...over,
});

// ── ruleMatches (AC 1) ──────────────────────────────────────────────────────

describe('ruleMatches (AC 1)', () => {
  it('matches on exact device/play/billing/day/window', () => {
    expect(ruleMatches(rule(), ctx())).toBe(true);
  });

  it('excludes inactive rules', () => {
    expect(ruleMatches(rule({ is_active: false }), ctx())).toBe(false);
  });

  it('excludes a mismatched billing_mode', () => {
    expect(ruleMatches(rule({ billing_mode: 'prepaid' }), ctx())).toBe(false);
  });

  it("device_type 'any' matches any device", () => {
    expect(ruleMatches(rule({ device_type: 'any' }), ctx({ device_type: 'vip' }))).toBe(true);
  });

  it('a concrete device_type must equal ctx', () => {
    expect(ruleMatches(rule({ device_type: 'ps4' }), ctx({ device_type: 'ps5' }))).toBe(false);
  });

  it("play_mode 'any' matches single and multi", () => {
    const r = rule({ play_mode: 'any' });
    expect(ruleMatches(r, ctx({ play_mode: 'single' }))).toBe(true);
    expect(ruleMatches(r, ctx({ play_mode: 'multi' }))).toBe(true);
  });

  it('a concrete play_mode must equal ctx', () => {
    expect(ruleMatches(rule({ play_mode: 'multi' }), ctx({ play_mode: 'single' }))).toBe(false);
  });

  it("day_type 'any' matches weekday and weekend", () => {
    const r = rule({ day_type: 'any' });
    // 2026-06-24 = Wed (weekday); 2026-06-26 = Fri (weekend in Cairo).
    expect(ruleMatches(r, ctx({ at_iso: '2026-06-24T12:00:00.000Z' }))).toBe(true);
    expect(ruleMatches(r, ctx({ at_iso: '2026-06-26T12:00:00.000Z' }))).toBe(true);
  });

  it('a weekday rule excludes a weekend instant', () => {
    expect(
      ruleMatches(rule({ day_type: 'weekday' }), ctx({ at_iso: '2026-06-26T12:00:00.000Z' })),
    ).toBe(false);
  });
});

// ── day-type at the UTC↔Cairo boundary (AC 5) ───────────────────────────────

describe('day_type respects Cairo, not UTC (AC 5)', () => {
  it('an instant that is Thursday in UTC but Friday in Cairo resolves weekend', () => {
    // 2026-06-25T22:00Z = Fri 00:00 Cairo (UTC+2/+3). Cairo DST: +03:00 in summer
    // → 22:00Z is 01:00 Fri Cairo. A weekend rule must match, a weekday must not.
    const weekend = rule({ day_type: 'weekend', priority: 5 });
    const weekday = rule({ day_type: 'weekday', priority: 5 });
    const at = '2026-06-25T22:00:00.000Z';
    expect(ruleMatches(weekend, ctx({ at_iso: at }))).toBe(true);
    expect(ruleMatches(weekday, ctx({ at_iso: at }))).toBe(false);
  });
});

// ── window matching: end-exclusive + midnight wrap + null bounds (AC 6, 7) ──

describe('time-window matching (AC 6, 7)', () => {
  // Cairo is UTC+3 in June 2026 (DST). 18:00 Cairo = 15:00Z; 02:00 Cairo = 23:00Z prev.
  const wrap = rule({ time_start: '18:00', time_end: '02:00' });

  it('matches at 18:00 (inclusive start)', () => {
    expect(ruleMatches(wrap, ctx({ at_iso: '2026-06-24T15:00:00.000Z' }))).toBe(true);
  });

  it('matches at 01:30 (inside the wrap)', () => {
    // 01:30 Cairo = 22:30Z previous UTC day.
    expect(ruleMatches(wrap, ctx({ at_iso: '2026-06-24T22:30:00.000Z' }))).toBe(true);
  });

  it('does NOT match at 02:00 (exclusive end)', () => {
    // 02:00 Cairo = 23:00Z previous day.
    expect(ruleMatches(wrap, ctx({ at_iso: '2026-06-24T23:00:00.000Z' }))).toBe(false);
  });

  it('null bounds mean all-day', () => {
    const allDay = rule({ time_start: null, time_end: null });
    expect(ruleMatches(allDay, ctx({ at_iso: '2026-06-24T03:00:00.000Z' }))).toBe(true);
  });
});

// ── resolveRule: priority, tie-break, null (AC 2, 3, 4) ─────────────────────

describe('resolveRule (AC 2, 3, 4)', () => {
  it('returns null when no rule matches (no throw)', () => {
    expect(resolveRule([], ctx())).toBeNull();
    expect(resolveRule([rule({ billing_mode: 'prepaid' })], ctx())).toBeNull();
  });

  it('picks the highest priority', () => {
    const low = rule({ id: 'a', priority: 1, price_per_hour: 1000 });
    const high = rule({ id: 'b', priority: 9, price_per_hour: 9000 });
    expect(resolveRule([low, high], ctx())?.id).toBe('b');
  });

  it('breaks ties by id ascending, independent of array order', () => {
    const x = rule({ id: 'zzz', priority: 5 });
    const y = rule({ id: 'aaa', priority: 5 });
    expect(resolveRule([x, y], ctx())?.id).toBe('aaa');
    expect(resolveRule([y, x], ctx())?.id).toBe('aaa');
  });

  it('does not mutate the input array', () => {
    const arr = [rule({ id: 'b', priority: 5 }), rule({ id: 'a', priority: 5 })];
    const snapshot = arr.map((r) => r.id);
    resolveRule(arr, ctx());
    expect(arr.map((r) => r.id)).toEqual(snapshot);
  });

  it('is pure — same inputs, same output (AC 8)', () => {
    const rules = [rule({ id: 'a', priority: 1 }), rule({ id: 'b', priority: 2 })];
    const c = ctx();
    expect(resolveRule(rules, c)?.id).toBe(resolveRule(rules, c)?.id);
  });
});

// ── rateBoundaryInstants ────────────────────────────────────────────────────

describe('rateBoundaryInstants', () => {
  it('returns [] when endIso <= startIso', () => {
    const r = [rule()];
    expect(rateBoundaryInstants(r, bctx(), '2026-06-24T12:00:00.000Z', '2026-06-24T12:00:00.000Z')).toEqual([]);
    expect(rateBoundaryInstants(r, bctx(), '2026-06-24T13:00:00.000Z', '2026-06-24T12:00:00.000Z')).toEqual([]);
  });

  it('returns [] for a single all-day rule (no boundary in range)', () => {
    const r = [rule({ time_start: null, time_end: null, day_type: 'any' })];
    const out = rateBoundaryInstants(r, bctx(), '2026-06-24T10:00:00.000Z', '2026-06-24T14:00:00.000Z');
    expect(out).toEqual([]);
  });

  it('returns [] when the rule set is empty (null throughout — no change)', () => {
    expect(rateBoundaryInstants([], bctx(), '2026-06-24T10:00:00.000Z', '2026-06-24T14:00:00.000Z')).toEqual([]);
  });

  it('finds a single off-peak→peak boundary at the window edge', () => {
    // off-peak all day (low priority); peak 18:00–22:00 Cairo (high priority).
    // June 2026 Cairo = UTC+3 → 18:00 Cairo = 15:00Z.
    const offpeak = rule({ id: 'off', priority: 1, time_start: null, time_end: null });
    const peak = rule({ id: 'peak', priority: 9, time_start: '18:00', time_end: '22:00' });
    const out = rateBoundaryInstants(
      [offpeak, peak],
      bctx(),
      '2026-06-24T14:00:00.000Z', // 17:00 Cairo (off-peak)
      '2026-06-24T16:00:00.000Z', // 19:00 Cairo (peak)
    );
    expect(out).toEqual(['2026-06-24T15:00:00.000Z']); // 18:00 Cairo
  });

  it('multi-window off-peak→peak→after-midnight determinism', () => {
    // off-peak all day; peak 18:00–24:00; late-night 00:00–06:00 (distinct rule).
    const offpeak = rule({ id: 'off', priority: 1, time_start: null, time_end: null });
    const peak = rule({ id: 'peak', priority: 9, time_start: '18:00', time_end: '00:00' });
    const late = rule({ id: 'late', priority: 9, time_start: '00:00', time_end: '06:00' });
    const rules = [offpeak, peak, late];
    // 16:00Z(=19:00 Cairo, peak) → next day 05:00Z(=08:00 Cairo, off-peak).
    const start = '2026-06-24T16:00:00.000Z';
    const end = '2026-06-25T05:00:00.000Z';
    const out = rateBoundaryInstants(rules, bctx(), start, end);
    // Boundaries: peak→late at 24:00 Cairo (=21:00Z), late→off at 06:00 Cairo (=03:00Z next day).
    expect(out).toEqual([
      '2026-06-24T21:00:00.000Z', // 00:00 Cairo (midnight) — peak ends, late begins
      '2026-06-25T03:00:00.000Z', // 06:00 Cairo — late ends, off-peak resumes
    ]);
    // Determinism: array-order independent.
    const shuffled = rateBoundaryInstants([late, offpeak, peak], bctx(), start, end);
    expect(shuffled).toEqual(out);
  });

  it('flips on the weekday→weekend boundary at local midnight', () => {
    // weekday rule + weekend rule, both all-day, different ids → midnight flip.
    const weekday = rule({ id: 'wd', day_type: 'weekday', priority: 5 });
    const weekend = rule({ id: 'we', day_type: 'weekend', priority: 5 });
    // Thu 20:00Z = Thu 23:00 Cairo; Fri 06:00Z = Fri 09:00 Cairo. Midnight Cairo
    // Thu→Fri = 2026-06-25 00:00 Cairo = 2026-06-24T21:00Z.
    const out = rateBoundaryInstants(
      [weekday, weekend],
      bctx(),
      '2026-06-25T20:00:00.000Z', // Thu 23:00 Cairo (weekday)
      '2026-06-26T06:00:00.000Z', // Fri 09:00 Cairo (weekend)
    );
    expect(out).toEqual(['2026-06-25T21:00:00.000Z']); // Fri 00:00 Cairo
  });

  it('drops candidate instants where resolution does not actually change', () => {
    // A window edge for a rule that never wins priority must not create a boundary.
    const winner = rule({ id: 'win', priority: 9, time_start: null, time_end: null });
    const loser = rule({ id: 'lose', priority: 1, time_start: '18:00', time_end: '22:00' });
    const out = rateBoundaryInstants(
      [winner, loser],
      bctx(),
      '2026-06-24T14:00:00.000Z',
      '2026-06-24T20:00:00.000Z',
    );
    expect(out).toEqual([]); // winner resolves throughout; no real change
  });

  it('DST-spanning boundary maps to a defined UTC instant', () => {
    // Egypt 2026 DST ends ~last Thursday/Friday of Oct (fall back 03:00→02:00).
    // We assert a window edge inside a DST-affected day still yields a single,
    // well-defined ascending UTC instant (no crash, no duplicate, sorted).
    const offpeak = rule({ id: 'off', priority: 1, time_start: null, time_end: null });
    const peak = rule({ id: 'peak', priority: 9, time_start: '18:00', time_end: '22:00' });
    const rules = [offpeak, peak];
    // Span a full late-October day across the DST change.
    const out = rateBoundaryInstants(
      rules,
      bctx(),
      '2026-10-30T10:00:00.000Z',
      '2026-10-31T10:00:00.000Z',
    );
    // Must be ascending, de-duplicated, all strictly inside, and valid ISO.
    const ms = out.map((s) => Date.parse(s));
    expect(ms.every((m) => !Number.isNaN(m))).toBe(true);
    for (let i = 1; i < ms.length; i += 1) {
      expect(ms[i]! > ms[i - 1]!).toBe(true);
    }
    expect(new Set(out).size).toBe(out.length);
    // Each peak window edge (18:00 and 22:00 Cairo) crossed once a day → boundaries exist.
    expect(out.length).toBeGreaterThanOrEqual(2);
  });
});

// ── planSegments ────────────────────────────────────────────────────────────

describe('planSegments', () => {
  it('returns [] for a non-positive interval', () => {
    expect(planSegments([rule()], bctx(), '2026-06-24T12:00:00.000Z', '2026-06-24T12:00:00.000Z')).toEqual([]);
  });

  it('produces one segment when there is no boundary', () => {
    const r = [rule({ id: 'only', price_per_hour: 3000 })];
    const plans = planSegments(r, bctx(), '2026-06-24T10:00:00.000Z', '2026-06-24T12:00:00.000Z');
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      started_at: '2026-06-24T10:00:00.000Z',
      ended_at: '2026-06-24T12:00:00.000Z',
      play_mode: 'single',
      rate_rule_id: 'only',
      price_per_hour_snapshot: 3000,
    });
  });

  it('snapshots rate 0 / null id when no rule resolves', () => {
    const plans = planSegments([], bctx(), '2026-06-24T10:00:00.000Z', '2026-06-24T12:00:00.000Z');
    expect(plans).toHaveLength(1);
    expect(plans[0]?.rate_rule_id).toBeNull();
    expect(plans[0]?.price_per_hour_snapshot).toBe(0);
  });

  it('produces boundaries.length + 1 plans, each snapshot at its own start', () => {
    const offpeak = rule({ id: 'off', priority: 1, price_per_hour: 2000, time_start: null, time_end: null });
    const peak = rule({ id: 'peak', priority: 9, price_per_hour: 5000, time_start: '18:00', time_end: '22:00' });
    const plans = planSegments(
      [offpeak, peak],
      bctx(),
      '2026-06-24T14:00:00.000Z', // 17:00 Cairo off-peak
      '2026-06-24T16:00:00.000Z', // 19:00 Cairo peak
    );
    expect(plans).toHaveLength(2);
    expect(plans[0]).toMatchObject({ rate_rule_id: 'off', price_per_hour_snapshot: 2000, ended_at: '2026-06-24T15:00:00.000Z' });
    expect(plans[1]).toMatchObject({ rate_rule_id: 'peak', price_per_hour_snapshot: 5000, started_at: '2026-06-24T15:00:00.000Z' });
    // Contiguous: each plan's end is the next plan's start.
    expect(plans[0]?.ended_at).toBe(plans[1]?.started_at);
  });

  it('snapshots price 0 when the resolved rule has a null price_per_hour', () => {
    // e.g. a prepaid/fixed-match rule that still resolves but carries no hourly price.
    const r = [rule({ id: 'np', price_per_hour: null })];
    const plans = planSegments(r, bctx(), '2026-06-24T10:00:00.000Z', '2026-06-24T11:00:00.000Z');
    expect(plans).toHaveLength(1);
    expect(plans[0]?.rate_rule_id).toBe('np');
    expect(plans[0]?.price_per_hour_snapshot).toBe(0);
  });

  it('carries the requested play_mode onto every plan', () => {
    const r = [rule({ play_mode: 'any' })];
    const plans = planSegments(r, bctx({ play_mode: 'multi' }), '2026-06-24T10:00:00.000Z', '2026-06-24T11:00:00.000Z');
    expect(plans.every((p) => p.play_mode === 'multi')).toBe(true);
  });

  it('an exact-boundary instant as endIso excludes the boundary (end-exclusive interval)', () => {
    // Interval ends exactly at the peak start → still one off-peak segment.
    const offpeak = rule({ id: 'off', priority: 1, time_start: null, time_end: null });
    const peak = rule({ id: 'peak', priority: 9, time_start: '18:00', time_end: '22:00' });
    const plans = planSegments(
      [offpeak, peak],
      bctx(),
      '2026-06-24T14:00:00.000Z', // 17:00 Cairo
      '2026-06-24T15:00:00.000Z', // exactly 18:00 Cairo (peak start = endpoint, excluded)
    );
    expect(plans).toHaveLength(1);
    expect(plans[0]?.rate_rule_id).toBe('off');
  });
});
