/**
 * Rate-rule resolution + boundary enumeration (Phase 4 — ADR-0005).
 *
 * The heart of pricing: given the tenant's active `rate_rules` and a context at a
 * single instant, pick the governing rule (highest priority, deterministic id
 * tie-break). Boundaries (peak/off-peak, weekday/weekend) are an EMERGENT property
 * of the rule set — there is no `peak_windows` config (unlike the trial). The
 * instants at which the resolved rule id changes for a fixed context ARE the
 * boundaries; `rateBoundaryInstants` enumerates them and `planSegments` splits the
 * interval into the ordered sub-segments the close/switch write path materializes.
 *
 * HARD RULES (CLAUDE.md §2, §4):
 *   - Pure: instants + rules passed in; the wall clock is never read in cost math.
 *   - Same input → same output (sorted candidates, id-compared, tz-fixed).
 *   - Integer piastres only; snapshots carry the resolved `price_per_hour` or 0.
 *   - No React / RN / Expo / Next / Supabase imports.
 *
 * Re-derived from the trial's sound `ruleMatches`/`resolveRule` algorithm; never
 * imported from it. Boundary enumeration is new (the trial used a `peak_windows`
 * config; PS-Managment derives boundaries from the rule set per ADR-0005).
 */
import type { Piastres } from '../money';
import type { BillingMode, PlayMode, RateRule } from '../types';
import { CAFE_TZ, dayTypeAt, isWithinWindow } from '../time';
// dayjs is configured (utc + timezone plugins) in ../time/time.ts; import the
// same configured instance so Cairo↔UTC conversion is DST-safe and consistent.
import { dayjs } from '../time/time';

/** Context for resolving a rate rule at one instant. Never reads the clock. */
export interface RuleContext {
  device_type: string;
  /** Concrete play mode of the session — never 'any' (rules may be 'any'). */
  play_mode: PlayMode;
  billing_mode: BillingMode;
  /** UTC ISO instant; day_type + window resolved in Cairo (CAFE_TZ). */
  at_iso: string;
}

/**
 * True iff `rule` is active and every condition matches `ctx`:
 *  - `billing_mode` equal;
 *  - `device_type` equal OR rule.device_type === 'any';
 *  - `play_mode` equal OR rule.play_mode === 'any';
 *  - `day_type` === dayTypeAt(ctx.at_iso) (Cairo) OR rule.day_type === 'any';
 *  - isWithinWindow(ctx.at_iso, rule.time_start, rule.time_end)
 *    (end-exclusive, midnight-wrap, null bound = all-day).
 *
 * Pure; no clock read; no throw.
 */
export function ruleMatches(rule: RateRule, ctx: RuleContext): boolean {
  if (!rule.is_active) return false;
  if (rule.billing_mode !== ctx.billing_mode) return false;
  if (rule.device_type !== 'any' && rule.device_type !== ctx.device_type) {
    return false;
  }
  if (rule.play_mode !== 'any' && rule.play_mode !== ctx.play_mode) {
    return false;
  }
  if (rule.day_type !== 'any' && rule.day_type !== dayTypeAt(ctx.at_iso)) {
    return false;
  }
  return isWithinWindow(ctx.at_iso, rule.time_start, rule.time_end);
}

/**
 * Highest-priority active matching rule; ties broken deterministically by `id`
 * (ascending) so the result is independent of input array order. Returns `null`
 * when no rule matches (documented no-match fallback → callers treat as rate 0).
 *
 * Pure; no clock read; does NOT mutate `rules`.
 */
export function resolveRule(
  rules: RateRule[],
  ctx: RuleContext,
): RateRule | null {
  let best: RateRule | null = null;
  for (const rule of rules) {
    if (!ruleMatches(rule, ctx)) continue;
    if (best === null) {
      best = rule;
      continue;
    }
    if (rule.priority > best.priority) {
      best = rule;
    } else if (rule.priority === best.priority && rule.id < best.id) {
      // Deterministic tie-break by id (ascending) — order-independent.
      best = rule;
    }
  }
  return best;
}

/** Context for boundary enumeration — the fixed dimensions over the interval. */
export interface BoundaryContext {
  device_type: string;
  play_mode: PlayMode;
  billing_mode: BillingMode;
}

/** Resolved rule id at an instant, or null when no rule matches. */
function resolvedIdAt(
  rules: RateRule[],
  ctx: BoundaryContext,
  at_iso: string,
): string | null {
  const rule = resolveRule(rules, { ...ctx, at_iso });
  return rule === null ? null : rule.id;
}

/**
 * Candidate Cairo-local transition times that could change which rule resolves:
 * every rule's `time_start`/`time_end` plus `'00:00'` (day_type flips at local
 * midnight). De-duplicated, sorted ascending. Always includes '00:00'.
 */
function candidateLocalTimes(rules: RateRule[]): string[] {
  const set = new Set<string>(['00:00']);
  for (const rule of rules) {
    if (rule.time_start != null) set.add(rule.time_start);
    if (rule.time_end != null) set.add(rule.time_end);
  }
  return [...set].sort();
}

/**
 * Ascending, de-duplicated list of UTC-ISO instants STRICTLY inside
 * (startIso, endIso) at which `resolveRule` changes resolved rule id
 * (Decision 2). Endpoints excluded. Empty array ⇒ a single segment spans the
 * whole interval. Returns [] when endIso <= startIso.
 *
 * Algorithm (ADR-0005 §"Boundary enumeration"):
 *  1. Candidate instants = every Cairo day the interval touches × every distinct
 *     local time in {rules' time_start, rules' time_end, '00:00'}, mapped to UTC.
 *  2. Keep only candidates strictly inside (startIso, endIso); sort + de-dup.
 *  3. Walk candidates; keep one iff its resolved rule id differs from the id of
 *     the last KEPT instant (seeded with the resolution at startIso).
 *
 * Pure; instants + rules passed in; no clock read. DST-safe — Cairo→UTC goes
 * through dayjs tz (the same plugin dayTypeAt/localHm use).
 */
export function rateBoundaryInstants(
  rules: RateRule[],
  ctx: BoundaryContext,
  startIso: string,
  endIso: string,
): string[] {
  const startMs = dayjs(startIso).valueOf();
  const endMs = dayjs(endIso).valueOf();
  if (!(endMs > startMs)) return [];

  const localTimes = candidateLocalTimes(rules);

  // Cairo calendar days the interval [start, end) touches. Iterate inclusive of
  // the end day so a window edge / midnight on the final day is considered.
  const firstDay = dayjs(startIso).tz(CAFE_TZ).startOf('day');
  const lastDay = dayjs(endIso).tz(CAFE_TZ).startOf('day');

  // Build candidate UTC ms (de-duplicated) strictly inside (start, end).
  const candidateMsSet = new Set<number>();
  let day = firstDay;
  // Guard the loop (bounded by interval length / 1 day; defensive cap).
  for (let i = 0; i <= 366 && !day.isAfter(lastDay); i += 1) {
    const ymd = day.format('YYYY-MM-DD');
    for (const hm of localTimes) {
      // Construct the Cairo wall-clock instant, then take its UTC value.
      const ms = dayjs.tz(`${ymd}T${hm}`, CAFE_TZ).valueOf();
      if (ms > startMs && ms < endMs) candidateMsSet.add(ms);
    }
    day = day.add(1, 'day');
  }

  const candidates = [...candidateMsSet].sort((a, b) => a - b);

  // Filter to real boundaries: keep a candidate iff the resolved id changes
  // versus the previous kept point (seeded at the interval start).
  const kept: string[] = [];
  let prevId = resolvedIdAt(rules, ctx, startIso);
  for (const ms of candidates) {
    const iso = dayjs(ms).utc().toISOString();
    const id = resolvedIdAt(rules, ctx, iso);
    if (id !== prevId) {
      kept.push(iso);
      prevId = id;
    }
  }
  return kept;
}

/** One materialized sub-segment plan: a [from,to) with its resolved snapshot. */
export interface SegmentPlan {
  started_at: string;
  ended_at: string;
  play_mode: PlayMode;
  /** Resolved rule's id at `started_at`, or null when no rule matches. */
  rate_rule_id: string | null;
  /** Resolved rule's `price_per_hour`, or 0 when no rule / rule price null. */
  price_per_hour_snapshot: Piastres;
}

/**
 * Split [startIso, endIso) for `ctx.play_mode` into the ordered SegmentPlan[]
 * the close/switch write path materializes — one per sub-interval between
 * boundaries, snapshot resolved at each sub-interval's OWN start instant.
 * `boundaries.length + 1` plans. Returns [] when endIso <= startIso.
 *
 * Pure. The live preview uses the same boundaries to sum cost without persisting.
 */
export function planSegments(
  rules: RateRule[],
  ctx: BoundaryContext,
  startIso: string,
  endIso: string,
): SegmentPlan[] {
  if (!(dayjs(endIso).valueOf() > dayjs(startIso).valueOf())) return [];

  const boundaries = rateBoundaryInstants(rules, ctx, startIso, endIso);
  const cuts = [startIso, ...boundaries, endIso];

  const plans: SegmentPlan[] = [];
  for (let i = 0; i < cuts.length - 1; i += 1) {
    const from = cuts[i] as string; // cuts has length >= 2; index in range.
    const to = cuts[i + 1] as string;
    const rule = resolveRule(rules, { ...ctx, at_iso: from });
    plans.push({
      started_at: from,
      ended_at: to,
      play_mode: ctx.play_mode,
      rate_rule_id: rule === null ? null : rule.id,
      price_per_hour_snapshot: rule === null ? 0 : rule.price_per_hour ?? 0,
    });
  }
  return plans;
}
