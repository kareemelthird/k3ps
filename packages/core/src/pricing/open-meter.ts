/**
 * Open-meter pricing — the one pure helper the live counter bills with.
 *
 * Open meter = "pay for the time you played": cost = billable minutes × the
 * resolved hourly rate. This module owns ONLY that single-rate computation so
 * the mobile/web counters stop doing float money math (`(minutes/60)*price`)
 * inline. It is forward-compatible with the Phase-4 rate-rule + segment engine,
 * which will resolve the rate/window per segment and call this per segment.
 *
 * HARD RULES (CLAUDE.md §2.1, §2.4, §4):
 *   - Money is integer piastres. The float→int rounding happens ONCE, here.
 *   - Pure: the caller passes both instants in. We never read the system clock
 *     (no nowIso, no wall-clock call) inside cost math — same input, same output.
 *   - No React / RN / Expo / Next / Supabase imports.
 *
 * Rounding model (matches the trial's sound open-meter algorithm):
 *   1. elapsed   = minutes from start→end, clamped to 0 (clock skew never bills).
 *   2. billable  = max( roundUp(elapsed, roundingMinutes), minChargeMinutes ).
 *   3. cost      = round( billable × ratePerHour / 60 )   ← single rounding.
 *
 * Rounding and the min-charge are applied ONCE for this period; a caller that
 * splits a session into segments must call this per segment and SUM the integer
 * results — never re-round the sum (CLAUDE.md §2.1, pricing-engine-guard inv. 2).
 */
import type { Piastres } from '../money';
import { elapsedMinutes } from '../time';

/** Tunables for one open-meter period. Both default to "no effect". */
export interface OpenMeterOptions {
  /**
   * Round billable minutes UP to the nearest multiple of this many minutes
   * (e.g. `5` bills 31 min as 35). `<= 0` or omitted rounds up to whole
   * minutes only (partial minutes are never given away free).
   */
  roundingMinutes?: number;
  /**
   * Floor on billable minutes — the customer is charged for at least this many
   * minutes regardless of how short the session was. `<= 0` or omitted = none.
   */
  minChargeMinutes?: number;
}

/**
 * Round elapsed minutes UP to the nearest `increment`.
 * - `minutes <= 0` → `0` (nothing played, nothing billed).
 * - `increment > 0` → next multiple of `increment` (e.g. 31 @ 5 → 35).
 * - `increment <= 0` → ceil to whole minutes (partial minute → next minute).
 */
export function roundUpMinutes(minutes: number, increment: number): number {
  if (minutes <= 0) return 0;
  if (increment > 0) return Math.ceil(minutes / increment) * increment;
  return Math.ceil(minutes);
}

/**
 * Billable minutes for one open-meter period: round elapsed up to the rounding
 * increment, then take the larger of that and the min-charge floor. Returns `0`
 * only when nothing was played AND there is no min-charge.
 *
 * Exposed so a UI can show "billed: NN min" using the exact same math the cost
 * is derived from (no second, drifting calculation).
 */
export function billableMinutes(
  elapsed: number,
  opts: OpenMeterOptions = {},
): number {
  const rounded = roundUpMinutes(elapsed, opts.roundingMinutes ?? 0);
  const floor = opts.minChargeMinutes ?? 0;
  return Math.max(rounded, floor > 0 ? floor : 0);
}

/**
 * Open-meter cost in **integer piastres** for one continuous period at a single
 * hourly rate.
 *
 * @param startIso             UTC ISO instant the period started.
 * @param endIso               UTC ISO instant the period ended. Pass the
 *                             explicit "now"/"at" instant for a live session —
 *                             this function never reads the clock itself, so the
 *                             caller controls the snapshot and the result stays
 *                             reproducible/auditable. `null` is rejected to keep
 *                             cost math pure (no implicit now).
 * @param ratePerHourPiastres  Integer piastres charged per whole hour.
 * @param opts                 Rounding increment + min-charge floor (see type).
 * @returns                    Integer piastres; rounded exactly once.
 *
 * @throws if `endIso` is `null`/`undefined` — the caller must supply the end/at
 *         instant so the computation is pure and deterministic.
 */
export function openMeterCostPiastres(
  startIso: string,
  endIso: string | null,
  ratePerHourPiastres: number,
  opts: OpenMeterOptions = {},
): Piastres {
  if (endIso == null) {
    throw new Error(
      'openMeterCostPiastres: endIso must be an explicit instant; ' +
        'pass the current/at time in (cost math must not read the clock).',
    );
  }
  const elapsed = elapsedMinutes(startIso, endIso);
  const minutes = billableMinutes(elapsed, opts);
  // Single rounding: minutes/60 is fractional, the rate is integer piastres.
  // Math.round once → no float drift, no accumulation across calls.
  return Math.round((minutes * ratePerHourPiastres) / 60);
}
