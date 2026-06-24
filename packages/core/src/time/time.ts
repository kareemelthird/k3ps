/**
 * Time — Africa/Cairo business-day math, all derived from timestamps.
 *
 * Billing NEVER trusts a `setInterval` counter. We store `started_at` as a UTC
 * ISO string and compute elapsed = end - start at render. A backgrounded app,
 * device sleep, or dropped network can therefore never corrupt a bill
 * (CLAUDE.md §2.2). Functions that take an instant take it as an argument; they
 * do not read the system clock internally — only `nowIso()` does, and it takes
 * no cost-relevant input. (CLAUDE.md §2.4, §4.)
 *
 * Localization note: the business timezone and weekend days are pinned to
 * Egypt today but live behind named constants so a later multi-timezone change
 * is localized to this file.
 */
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);

/** Business timezone for all day-type / time-window logic. */
export const CAFE_TZ = 'Africa/Cairo';

/**
 * Weekend day-of-week indices in `CAFE_TZ` (0=Sun … 6=Sat).
 * Egypt's weekend is Friday (5) + Saturday (6).
 */
export const WEEKEND_DAYS: readonly number[] = [5, 6];

/** Weekday vs weekend, used for rate-rule day-type matching. */
export type DayType = 'weekday' | 'weekend';

/** Current instant as a UTC ISO-8601 string (the canonical stored form). */
export function nowIso(): string {
  return dayjs().utc().toISOString();
}

/**
 * Fractional minutes elapsed between two ISO instants. Clamps to 0 when `end`
 * precedes `start` (e.g. clock skew) so a bill never goes negative.
 * Defaults `end` to now when omitted (display convenience only — pass an
 * explicit `end` for any cost computation).
 */
export function elapsedMinutes(startIso: string, endIso?: string): number {
  return elapsedMs(startIso, endIso) / 60000;
}

/** Whole seconds elapsed (floored); clamps to 0 like {@link elapsedMinutes}. */
export function elapsedSeconds(startIso: string, endIso?: string): number {
  return Math.floor(elapsedMs(startIso, endIso) / 1000);
}

function elapsedMs(startIso: string, endIso?: string): number {
  const start = dayjs(startIso).valueOf();
  const end = (endIso ? dayjs(endIso) : dayjs()).valueOf();
  return Math.max(0, end - start);
}

/** Format a second count as zero-padded `HH:MM:SS` for the live timer. */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

/** Day-type (`weekday`/`weekend`) of an instant, computed in `CAFE_TZ`. */
export function dayTypeAt(iso: string): DayType {
  const dow = dayjs(iso).tz(CAFE_TZ).day();
  return WEEKEND_DAYS.includes(dow) ? 'weekend' : 'weekday';
}

/** Local `HH:mm` of an instant in `CAFE_TZ` (used for time-window matching). */
export function localHm(iso: string): string {
  return dayjs(iso).tz(CAFE_TZ).format('HH:mm');
}

/** Local hour 0–23 in `CAFE_TZ` (used for busiest-hours reporting). */
export function localHour(iso: string): number {
  return dayjs(iso).tz(CAFE_TZ).hour();
}

/**
 * Whether the local time of `iso` falls inside the window `[start, end)`.
 * - Times are `"HH:mm"` strings, compared in `CAFE_TZ`.
 * - **End-exclusive:** `end` itself is outside the window.
 * - **Wraps past midnight** when `start > end` (e.g. `18:00`–`02:00`).
 * - Either bound `null` means all-day (always `true`).
 */
export function isWithinWindow(
  iso: string,
  start: string | null,
  end: string | null,
): boolean {
  if (start == null || end == null) return true;
  const t = localHm(iso);
  if (start <= end) {
    // Same-day window: [start, end)
    return t >= start && t < end;
  }
  // Wrapping window, e.g. 18:00–02:00: inside if at/after start OR before end.
  return t >= start || t < end;
}

/** Default business-day cutover hour (ADR-0006 Decision 1). */
export const DEFAULT_CUTOVER_HOUR = 6;

/**
 * The business-day key `'YYYY-MM-DD'` for an instant, in `tz`, shifted by a
 * cutover hour so late-night activity stays on the previous business day
 * (ADR-0006 Decision 1 — the dominant late-night-café pattern).
 *
 * Algorithm: take the local (`tz`) wall-clock of `atIso`, subtract `cutoverHour`
 * hours, and return the resulting local calendar date.
 *   cutover 6: `2026-06-12T02:00` Cairo → `'2026-06-11'`;
 *              `2026-06-12T06:00` Cairo → `'2026-06-12'`.
 *
 * Pure: the instant is passed in (no clock read). DST-safe via the dayjs tz
 * plugin already used by {@link dayTypeAt} / {@link localHm} — the subtraction
 * happens on the zoned instant, so a DST shift on the business day is absorbed.
 *
 * @param atIso      the instant (UTC ISO-8601, or any dayjs-parseable instant)
 * @param cutoverHour hours after local midnight the business day starts (default 6)
 * @param tz         business timezone (default {@link CAFE_TZ})
 */
export function businessDayKey(
  atIso: string,
  cutoverHour: number = DEFAULT_CUTOVER_HOUR,
  tz: string = CAFE_TZ,
): string {
  return dayjs(atIso).tz(tz).subtract(cutoverHour, 'hour').format('YYYY-MM-DD');
}

export { dayjs };
