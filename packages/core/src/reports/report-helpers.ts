/**
 * Reports — pure time/range helpers for the Phase 6 owner dashboard (ADR-0007).
 *
 * The dashboard selects a range of **business-day keys** (`'YYYY-MM-DD'`,
 * `businessDayKey`, ADR-0006 Decision 1 / ADR-0007 Decision 3) and the SQL
 * reporting RPCs filter rows on a half-open UTC instant window. These helpers
 * own that key→window conversion so the boundary math has ONE source of truth:
 * `businessDayRange` here and `businessDayKey` agree by construction, which is
 * the load-bearing parity property the SQL labels are tested against.
 *
 * HARD RULES (CLAUDE.md §2.4, §4):
 *   - Pure: instants are derived from the keys, never read from the system
 *     clock. Same input -> same output.
 *   - No React / RN / Expo / Next / Supabase imports — dayjs (tz) only, reused
 *     from the time module so the utc/timezone plugins are loaded once.
 *   - No money math here (the piastre sums live in SQL — ADR-0007 Decision 5).
 */
import { dayjs, CAFE_TZ, DEFAULT_CUTOVER_HOUR } from '../time/time';

/** Inclusive business-day key range mapped to a half-open UTC instant window. */
export interface BusinessDayWindow {
  /** First instant included (UTC ISO-8601), inclusive. */
  fromIso: string;
  /** First instant excluded (UTC ISO-8601), exclusive. */
  toIso: string;
}

/**
 * Map an inclusive business-day key range `[fromKey, toKey]` (`'YYYY-MM-DD'`) to
 * the half-open UTC window `[fromIso, toIso)` that exactly covers those business
 * days for the given tenant cutover hour.
 *
 * The window is the exact inverse of {@link businessDayKey}'s wall-clock
 * boundary math, so the parity invariant holds for every cutover/timezone/DST:
 *   - `businessDayKey(fromIso, cutoverHour, tz) === fromKey`
 *   - the last instant before `toIso` maps to `toKey`
 *   - `toIso` itself maps to `toKey + 1 day` (excluded — half-open)
 *
 * Construction (mirrors the boundary): the start of a business day `K` is the
 * Cairo wall-clock midnight of `K` shifted forward by `cutoverHour` real hours
 * (a cutover-6 business day starts at 06:00 local). `toIso` is the start of the
 * day AFTER `toKey`.
 *
 * @param fromKey     inclusive first business-day key, `'YYYY-MM-DD'`
 * @param toKey       inclusive last business-day key, `'YYYY-MM-DD'`
 * @param cutoverHour hours after local midnight the business day starts (default 6)
 * @param tz          business timezone (default {@link CAFE_TZ})
 */
export function businessDayRange(
  fromKey: string,
  toKey: string,
  cutoverHour: number = DEFAULT_CUTOVER_HOUR,
  tz: string = CAFE_TZ,
): BusinessDayWindow {
  // The day AFTER toKey, as a calendar date string (handles month/year wrap).
  const dayAfterTo = dayjs(toKey).add(1, 'day').format('YYYY-MM-DD');
  return {
    fromIso: businessDayStartIso(fromKey, cutoverHour, tz),
    toIso: businessDayStartIso(dayAfterTo, cutoverHour, tz),
  };
}

/**
 * The UTC instant at which business-day `key` begins: the local (`tz`)
 * **wall-clock** instant `key` at `cutoverHour:00` (a cutover-6 day starts at
 * 06:00 local). Constructing the cutover wall-clock directly and letting the tz
 * plugin resolve its real UTC offset is the exact inverse of
 * {@link businessDayKey}'s wall-clock subtraction — so the parity invariant
 * holds on normal AND DST days. (The earlier "local midnight + cutoverHour
 * absolute hours" form crossed the DST offset boundary on the spring-forward
 * day and landed one hour late: 04:00Z instead of the correct 03:00Z on
 * 2026-04-24.)
 */
function businessDayStartIso(key: string, cutoverHour: number, tz: string): string {
  const hh = String(cutoverHour).padStart(2, '0');
  return dayjs.tz(`${key}T${hh}:00:00`, tz).utc().toISOString();
}

/**
 * Inclusive count of calendar days between two business-day keys — the device
 * utilization denominator (× 24h, ADR-0007 Decision 4).
 *   `daysInRange('2026-06-01', '2026-06-07') === 7`
 *   `daysInRange('2026-06-01', '2026-06-01') === 1`
 * The keys are already business-day dates, so no timezone/cutover is needed.
 * Pure; no clock read. Returns the raw inclusive count (the web layer blocks
 * `from > to` before calling, ADR-0007 Decision 5 hand-off).
 */
export function daysInRange(fromKey: string, toKey: string): number {
  return dayjs(toKey).diff(dayjs(fromKey), 'day') + 1;
}
