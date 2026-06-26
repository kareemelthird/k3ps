/**
 * Tests for time module — AC 6–12.
 * All AC references are from docs/specs/phase-2-tenant-foundation.md.
 *
 * Key invariant: CAFE_TZ = 'Africa/Cairo', Egypt weekend = Fri+Sat.
 * Tests use FIXED UTC instants to avoid host-timezone contamination.
 */

import {
  CAFE_TZ,
  dayTypeAt,
  isWithinWindow,
  elapsedMinutes,
  elapsedSeconds,
  formatClock,
  nowIso,
  localHm,
  localHour,
  businessDayKey,
  DEFAULT_CUTOVER_HOUR,
  formatRelativeTime,
} from '../time/time';

// ─── Known UTC → Cairo mapping used across tests ──────────────────────────────
//
// Cairo is UTC+2 in winter, UTC+3 in summer (DST).
// We pin to winter (standard time = UTC+2) to avoid DST ambiguity.
//
// Friday 2026-01-02 00:00 Cairo = Thursday 2026-01-01 22:00 UTC
// Saturday 2026-01-03 00:00 Cairo = Friday 2026-01-02 22:00 UTC
// Sunday 2026-01-04 00:00 Cairo = Saturday 2026-01-03 22:00 UTC
// Monday 2026-01-05 00:00 Cairo = Sunday 2026-01-04 22:00 UTC

const FRIDAY_CAIRO_NOON = '2026-01-02T10:00:00.000Z'; // Fri Jan 2, 12:00 Cairo (UTC+2 winter)
const SATURDAY_CAIRO_NOON = '2026-01-03T10:00:00.000Z'; // Sat Jan 3, 12:00 Cairo
const SUNDAY_CAIRO_NOON = '2026-01-04T10:00:00.000Z'; // Sun Jan 4, 12:00 Cairo
const MONDAY_CAIRO_NOON = '2026-01-05T10:00:00.000Z'; // Mon Jan 5, 12:00 Cairo
const THURSDAY_CAIRO_NOON = '2026-01-08T10:00:00.000Z'; // Thu Jan 8, 12:00 Cairo

// ─── AC 6: dayTypeAt ─────────────────────────────────────────────────────────

describe('dayTypeAt', () => {
  test('AC 6a: Friday in Cairo is weekend', () => {
    expect(dayTypeAt(FRIDAY_CAIRO_NOON)).toBe('weekend');
  });

  test('AC 6b: Saturday in Cairo is weekend', () => {
    expect(dayTypeAt(SATURDAY_CAIRO_NOON)).toBe('weekend');
  });

  test('AC 6c: Sunday in Cairo is weekday', () => {
    expect(dayTypeAt(SUNDAY_CAIRO_NOON)).toBe('weekday');
  });

  test('AC 6d: Monday in Cairo is weekday', () => {
    expect(dayTypeAt(MONDAY_CAIRO_NOON)).toBe('weekday');
  });

  test('AC 6e: Thursday in Cairo is weekday', () => {
    expect(dayTypeAt(THURSDAY_CAIRO_NOON)).toBe('weekday');
  });

  test('AC 6f: midnight-straddling — UTC Thursday night that is Cairo Friday', () => {
    // 2026-01-01 22:00 UTC = 2026-01-02 00:00 Cairo (Friday) — must be weekend
    const utcThursdayNight = '2026-01-01T22:00:00.000Z';
    expect(dayTypeAt(utcThursdayNight)).toBe('weekend');
  });

  test('AC 6g: 21:59 UTC Thursday is still Thursday in Cairo (weekday)', () => {
    // 2026-01-01 21:59 UTC = 2026-01-01 23:59 Cairo (Thursday) — weekday
    const utcThursdayLateDusk = '2026-01-01T21:59:00.000Z';
    expect(dayTypeAt(utcThursdayLateDusk)).toBe('weekday');
  });

  test('CAFE_TZ constant is Africa/Cairo', () => {
    expect(CAFE_TZ).toBe('Africa/Cairo');
  });
});

// ─── AC 7/8/9: isWithinWindow ────────────────────────────────────────────────

describe('isWithinWindow', () => {
  // Build an ISO string that corresponds to a known Cairo time.
  // 2026-01-02 is a Friday (winter, UTC+2).
  const cairoAt = (hh: number, mm: number): string => {
    const utcH = hh - 2; // UTC+2 winter
    // Clamp to same day for simplicity; use next-day for negative hours
    const date = utcH < 0 ? '2026-01-01' : '2026-01-02';
    const h = ((utcH % 24) + 24) % 24;
    return `${date}T${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00.000Z`;
  };

  // Window '18:00'–'02:00' (wraps past midnight)
  describe("wrap window '18:00'–'02:00'", () => {
    test('AC 7a: 01:00 Cairo → true', () => {
      expect(isWithinWindow(cairoAt(1, 0), '18:00', '02:00')).toBe(true);
    });

    test('AC 7b: 02:00 Cairo → false (end-exclusive)', () => {
      expect(isWithinWindow(cairoAt(2, 0), '18:00', '02:00')).toBe(false);
    });

    test('AC 7c: 17:59 Cairo → false (before start)', () => {
      expect(isWithinWindow(cairoAt(17, 59), '18:00', '02:00')).toBe(false);
    });

    test('18:00 Cairo → true (inclusive start)', () => {
      expect(isWithinWindow(cairoAt(18, 0), '18:00', '02:00')).toBe(true);
    });

    test('23:59 Cairo → true (late night, still in window)', () => {
      expect(isWithinWindow(cairoAt(23, 59), '18:00', '02:00')).toBe(true);
    });
  });

  // AC 8: null bounds
  describe('AC 8: null bounds = all-day', () => {
    test('null start + null end → always true', () => {
      expect(isWithinWindow(cairoAt(3, 0), null, null)).toBe(true);
      expect(isWithinWindow(cairoAt(12, 0), null, null)).toBe(true);
      expect(isWithinWindow(cairoAt(23, 59), null, null)).toBe(true);
    });

    test('null start → true', () => {
      expect(isWithinWindow(cairoAt(3, 0), null, '17:00')).toBe(true);
    });

    test('null end → true', () => {
      expect(isWithinWindow(cairoAt(3, 0), '09:00', null)).toBe(true);
    });
  });

  // AC 9: non-wrapping window '09:00'–'17:00'
  describe("non-wrap window '09:00'–'17:00'", () => {
    test('AC 9a: 09:00 Cairo → true (inclusive start)', () => {
      expect(isWithinWindow(cairoAt(9, 0), '09:00', '17:00')).toBe(true);
    });

    test('AC 9b: 17:00 Cairo → false (end-exclusive)', () => {
      expect(isWithinWindow(cairoAt(17, 0), '09:00', '17:00')).toBe(false);
    });

    test('12:00 Cairo → true (inside window)', () => {
      expect(isWithinWindow(cairoAt(12, 0), '09:00', '17:00')).toBe(true);
    });

    test('08:59 Cairo → false (before start)', () => {
      expect(isWithinWindow(cairoAt(8, 59), '09:00', '17:00')).toBe(false);
    });

    test('17:01 Cairo → false (after end)', () => {
      expect(isWithinWindow(cairoAt(17, 1), '09:00', '17:00')).toBe(false);
    });
  });
});

// ─── AC 10: elapsedMinutes / elapsedSeconds clamp ────────────────────────────

describe('elapsedMinutes', () => {
  test('AC 10a: end before start returns 0', () => {
    const start = '2026-01-01T12:00:00.000Z';
    const end = '2026-01-01T11:00:00.000Z';
    expect(elapsedMinutes(start, end)).toBe(0);
  });

  test('same start and end → 0', () => {
    const t = '2026-01-01T12:00:00.000Z';
    expect(elapsedMinutes(t, t)).toBe(0);
  });

  test('60 seconds → 1 minute', () => {
    const start = '2026-01-01T12:00:00.000Z';
    const end = '2026-01-01T12:01:00.000Z';
    expect(elapsedMinutes(start, end)).toBe(1);
  });

  test('90 seconds → 1.5 minutes', () => {
    const start = '2026-01-01T12:00:00.000Z';
    const end = '2026-01-01T12:01:30.000Z';
    // elapsedMinutes returns fractional for sub-minute precision
    expect(elapsedMinutes(start, end)).toBeCloseTo(1.5, 1);
  });
});

describe('elapsedSeconds', () => {
  test('AC 10b: end before start returns 0', () => {
    const start = '2026-01-01T12:00:00.000Z';
    const end = '2026-01-01T11:00:00.000Z';
    expect(elapsedSeconds(start, end)).toBe(0);
  });

  test('same start and end → 0', () => {
    const t = '2026-01-01T12:00:00.000Z';
    expect(elapsedSeconds(t, t)).toBe(0);
  });

  test('3661 seconds', () => {
    const start = '2026-01-01T00:00:00.000Z';
    const end = '2026-01-01T01:01:01.000Z';
    expect(elapsedSeconds(start, end)).toBe(3661);
  });
});

// ─── AC 11: formatClock ──────────────────────────────────────────────────────

describe('formatClock', () => {
  test("AC 11: formatClock(3661) === '01:01:01'", () => {
    expect(formatClock(3661)).toBe('01:01:01');
  });

  test("formatClock(0) === '00:00:00'", () => {
    expect(formatClock(0)).toBe('00:00:00');
  });

  test("formatClock(59) === '00:00:59'", () => {
    expect(formatClock(59)).toBe('00:00:59');
  });

  test("formatClock(3600) === '01:00:00'", () => {
    expect(formatClock(3600)).toBe('01:00:00');
  });

  test("formatClock(86399) === '23:59:59'", () => {
    expect(formatClock(86399)).toBe('23:59:59');
  });

  test('formatClock clamps negative to 00:00:00', () => {
    expect(formatClock(-10)).toBe('00:00:00');
  });

  test('formatClock handles fractional seconds (floors)', () => {
    expect(formatClock(3661.9)).toBe('01:01:01');
  });
});

// ─── AC 12: nowIso returns valid UTC ISO, no Date.now() in arg-taking fns ────

describe('nowIso', () => {
  test('AC 12: returns a valid UTC ISO-8601 string', () => {
    const iso = nowIso();
    expect(() => new Date(iso)).not.toThrow();
    expect(new Date(iso).toISOString()).toBe(iso);
  });

  test('nowIso result is a recent timestamp', () => {
    const before = Date.now();
    const iso = nowIso();
    const after = Date.now();
    const ts = new Date(iso).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

// ─── localHm / localHour coverage ────────────────────────────────────────────

describe('localHm', () => {
  test('returns HH:mm string for a known Cairo instant', () => {
    // 2026-01-02 10:00 UTC = 12:00 Cairo (UTC+2 winter)
    const result = localHm('2026-01-02T10:00:00.000Z');
    expect(result).toBe('12:00');
  });
});

describe('localHour', () => {
  test('returns correct hour for a known Cairo instant', () => {
    // 2026-01-02 10:00 UTC = 12:00 Cairo
    expect(localHour('2026-01-02T10:00:00.000Z')).toBe(12);
  });
});

// ─── businessDayKey (ADR-0006 Decision 1) ────────────────────────────────────
//
// Cairo is UTC+2 in winter (standard) and UTC+3 in summer (DST, late-Apr→late-Oct).
// Default cutover hour = 6: instants before 06:00 local belong to the PREVIOUS
// business day; 06:00 and after belong to the current local date.

describe('businessDayKey', () => {
  test('default cutover hour constant is 6', () => {
    expect(DEFAULT_CUTOVER_HOUR).toBe(6);
  });

  test('02:00 Cairo (before cutover) maps to the PREVIOUS business day', () => {
    // 2026-06-12 02:00 Cairo (summer, UTC+3) = 2026-06-11 23:00 UTC.
    expect(businessDayKey('2026-06-11T23:00:00.000Z')).toBe('2026-06-11');
  });

  test('06:00 Cairo (exactly at cutover) maps to the SAME local date', () => {
    // 2026-06-12 06:00 Cairo (summer, UTC+3) = 2026-06-12 03:00 UTC.
    expect(businessDayKey('2026-06-12T03:00:00.000Z')).toBe('2026-06-12');
  });

  test('05:59 Cairo (one minute before cutover) stays on the previous day', () => {
    // 2026-06-12 05:59 Cairo (UTC+3) = 2026-06-12 02:59 UTC.
    expect(businessDayKey('2026-06-12T02:59:00.000Z')).toBe('2026-06-11');
  });

  test('midnight Cairo maps to the previous business day (default cutover)', () => {
    // 2026-06-12 00:00 Cairo (UTC+3) = 2026-06-11 21:00 UTC.
    expect(businessDayKey('2026-06-11T21:00:00.000Z')).toBe('2026-06-11');
  });

  test('noon Cairo maps to the same local date', () => {
    // 2026-06-12 12:00 Cairo (UTC+3) = 2026-06-12 09:00 UTC.
    expect(businessDayKey('2026-06-12T09:00:00.000Z')).toBe('2026-06-12');
  });

  test('custom cutover hour = 0 (raw calendar day): midnight stays same day', () => {
    // 2026-06-12 00:00 Cairo = 2026-06-11 21:00 UTC; with cutover 0 → same date.
    expect(businessDayKey('2026-06-11T21:00:00.000Z', 0)).toBe('2026-06-12');
  });

  test('custom cutover hour = 8: 07:00 Cairo still belongs to previous day', () => {
    // 2026-06-12 07:00 Cairo (UTC+3) = 2026-06-12 04:00 UTC; 07 < 08 → prev.
    expect(businessDayKey('2026-06-12T04:00:00.000Z', 8)).toBe('2026-06-11');
  });

  test('custom cutover hour = 8: 08:00 Cairo flips to current day', () => {
    // 2026-06-12 08:00 Cairo (UTC+3) = 2026-06-12 05:00 UTC.
    expect(businessDayKey('2026-06-12T05:00:00.000Z', 8)).toBe('2026-06-12');
  });

  test('winter (UTC+2) instant: 02:00 Cairo maps to previous day', () => {
    // 2026-01-02 02:00 Cairo (winter, UTC+2) = 2026-01-02 00:00 UTC.
    expect(businessDayKey('2026-01-02T00:00:00.000Z')).toBe('2026-01-01');
  });

  test('winter (UTC+2) instant: 06:00 Cairo maps to same day', () => {
    // 2026-01-02 06:00 Cairo (winter, UTC+2) = 2026-01-02 04:00 UTC.
    expect(businessDayKey('2026-01-02T04:00:00.000Z')).toBe('2026-01-02');
  });

  test('DST-spanning business day: 03:00 Cairo summer still maps correctly', () => {
    // A late-night instant in summer (UTC+3). 2026-07-15 03:00 Cairo =
    // 2026-07-15 00:00 UTC; 03 < 06 → previous business day.
    expect(businessDayKey('2026-07-15T00:00:00.000Z')).toBe('2026-07-14');
  });

  test('weekend sanity (Fri/Sat): a Friday late-night session keys to Friday', () => {
    // Egypt weekend = Fri+Sat. 2026-01-03 (Sat) 01:00 Cairo (winter, UTC+2) =
    // 2026-01-02 23:00 UTC; before cutover → previous business day 2026-01-02
    // (Friday). Confirms a Sat-after-midnight session reconciles into Friday.
    const key = businessDayKey('2026-01-02T23:00:00.000Z');
    expect(key).toBe('2026-01-02');
    expect(dayTypeAt('2026-01-02T10:00:00.000Z')).toBe('weekend'); // Friday
  });

  test('explicit tz argument is honoured (UTC tz, no cutover)', () => {
    // Same instant, tz=UTC, cutover 0 → the raw UTC calendar date.
    expect(businessDayKey('2026-06-11T21:00:00.000Z', 0, 'UTC')).toBe(
      '2026-06-11',
    );
  });

  test('pure: same input → same output across repeated calls', () => {
    const iso = '2026-06-12T03:00:00.000Z';
    expect(businessDayKey(iso)).toBe(businessDayKey(iso));
  });
});

// ─── businessDayKey — DST boundary parity with the SQL wall-clock label ───────
//
// The authoritative business-day definition is the SQL reporting expression
// (migration 0007):
//   ((anchor AT TIME ZONE 'Africa/Cairo') - make_interval(hours => cutover))::date
// i.e. the Cairo WALL-CLOCK minus the cutover as a plain (DST-free) interval.
// businessDayKey must equal that for every instant, including the cutover hour
// of Egypt's DST days. Egypt 2026 transitions (IANA Africa/Cairo):
//   * spring-forward: 2026-04-24, local 00:00 jumps to 01:00 (UTC+2 → UTC+3),
//     so local 00:00–00:59 does not exist.
//   * fall-back:      last-Fri-Oct, local clocks step back (UTC+3 → UTC+2).
// The expected keys below are HAND-COMPUTED from the SQL wall-clock expression
// (take the Cairo local time shown, subtract 6h on the clock, take the date).
describe('businessDayKey — DST wall-clock parity (regression for the spring-forward blocker)', () => {
  // [instant UTC, Cairo wall-clock, expected businessDayKey @ cutover 6]
  const cases: Array<[string, string, string]> = [
    // Normal summer day — just before / just after the 06:00 cutover.
    ['2026-06-12T02:59:00.000Z', '05:59', '2026-06-11'],
    ['2026-06-12T03:00:00.000Z', '06:00', '2026-06-12'],
    // DST SPRING-FORWARD day (2026-04-24). The bug: absolute-hour subtraction
    // crossed the UTC+2→UTC+3 boundary and returned 2026-04-23 for 06:30 local.
    ['2026-04-24T02:59:00.000Z', '05:59', '2026-04-23'], // before cutover
    ['2026-04-24T03:00:00.000Z', '06:00', '2026-04-24'], // exactly at cutover
    ['2026-04-24T03:30:00.000Z', '06:30', '2026-04-24'], // first cutover hour — was WRONG
    ['2026-04-24T00:00:00.000Z', '03:00', '2026-04-23'], // late-night, prev day
    // DST FALL-BACK day (2026-10-30) — before / at the 06:00 cutover.
    ['2026-10-30T03:30:00.000Z', '05:30', '2026-10-29'],
    ['2026-10-30T04:00:00.000Z', '06:00', '2026-10-30'],
    // UTC-vs-Cairo calendar-boundary instant: 00:30 Cairo (UTC day differs).
    ['2026-06-10T21:30:00.000Z', '00:30', '2026-06-10'],
  ];

  for (const [iso, local, expected] of cases) {
    test(`${iso} (Cairo ${local}) → ${expected}`, () => {
      expect(localHm(iso)).toBe(local);
      expect(businessDayKey(iso)).toBe(expected);
    });
  }

  test('AT the cutover hour on the spring-forward day, a 06:00–06:59 Cairo instant keys to 2026-04-24', () => {
    // 06:00 Cairo (UTC+3) = 03:00Z; 06:59 Cairo = 03:59Z. Both must key to the
    // spring-forward business day itself, never the day before.
    expect(businessDayKey('2026-04-24T03:00:00.000Z')).toBe('2026-04-24');
    expect(businessDayKey('2026-04-24T03:59:00.000Z')).toBe('2026-04-24');
  });
});

describe('formatRelativeTime — bucketed, i18n-friendly last-synced token', () => {
  const now = '2026-06-26T12:00:00.000Z';

  it('returns a structured token (unit + value), never a formatted string', () => {
    expect(formatRelativeTime(now, '2026-06-26T11:30:00.000Z')).toEqual({ unit: 'minutes', value: 30 });
  });

  it('< 10s → now', () => {
    expect(formatRelativeTime(now, '2026-06-26T11:59:55.000Z')).toEqual({ unit: 'now', value: 0 });
    expect(formatRelativeTime(now, now)).toEqual({ unit: 'now', value: 0 });
  });

  it('10s..<60s → seconds', () => {
    expect(formatRelativeTime(now, '2026-06-26T11:59:45.000Z')).toEqual({ unit: 'seconds', value: 15 });
  });

  it('<60m → minutes (rounded)', () => {
    expect(formatRelativeTime(now, '2026-06-26T11:58:40.000Z')).toEqual({ unit: 'minutes', value: 1 }); // 80s → 1m
    expect(formatRelativeTime(now, '2026-06-26T11:01:00.000Z')).toEqual({ unit: 'minutes', value: 59 });
  });

  it('<24h → hours (rounded)', () => {
    expect(formatRelativeTime(now, '2026-06-26T11:00:00.000Z')).toEqual({ unit: 'hours', value: 1 });
    expect(formatRelativeTime(now, '2026-06-25T13:00:00.000Z')).toEqual({ unit: 'hours', value: 23 });
  });

  it('>=24h → days (rounded)', () => {
    expect(formatRelativeTime(now, '2026-06-25T12:00:00.000Z')).toEqual({ unit: 'days', value: 1 });
    expect(formatRelativeTime(now, '2026-06-23T12:00:00.000Z')).toEqual({ unit: 'days', value: 3 });
  });

  it('clamps a future instant to now (never negative)', () => {
    expect(formatRelativeTime(now, '2026-06-26T12:05:00.000Z')).toEqual({ unit: 'now', value: 0 });
  });
});
