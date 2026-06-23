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
