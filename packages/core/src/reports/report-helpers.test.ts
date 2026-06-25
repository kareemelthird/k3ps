/**
 * Tests for the Phase 6 report helpers (ADR-0007 Decision 5).
 *
 * Coverage targets:
 *   - businessDayRange: key range -> half-open UTC window, across the cutover
 *     boundary, the UTC<->Cairo offset (winter UTC+2 / summer UTC+3), a custom
 *     cutover, single/multi-day, month + year crossings, and an Egypt DST edge.
 *   - The load-bearing PARITY invariant: an instant is in [fromIso, toIso) iff
 *     businessDayKey(instant) is in [fromKey, toKey] — windows (here) and the
 *     SQL day-labels (which replicate businessDayKey) therefore agree.
 *   - daysInRange: inclusive count, single/multi-day, month/year crossings.
 *   - formatEgpPlain: 0, sub-EGP, exact decimal, large, negative, no separators.
 *
 * All tests pin FIXED UTC instants so the host timezone never contaminates them.
 * Cairo is UTC+2 in winter (standard) and UTC+3 in summer (DST, live since 2023:
 * last-Fri-Apr -> last-Thu-Oct).
 */
import { businessDayRange, daysInRange } from './report-helpers';
import { businessDayKey } from '../time/time';
import { formatEgpPlain } from '../money/money';
// Also assert the public surface is re-exported through the package root.
import * as core from '../index';

// ─── businessDayRange: exact window bounds ───────────────────────────────────
describe('businessDayRange — exact UTC window', () => {
  it('single summer day, default cutover 6 -> 06:00 Cairo (UTC+3) = 03:00Z', () => {
    expect(businessDayRange('2026-06-15', '2026-06-15')).toEqual({
      fromIso: '2026-06-15T03:00:00.000Z',
      toIso: '2026-06-16T03:00:00.000Z',
    });
  });

  it('single winter day, default cutover 6 -> 06:00 Cairo (UTC+2) = 04:00Z', () => {
    expect(businessDayRange('2026-01-15', '2026-01-15')).toEqual({
      fromIso: '2026-01-15T04:00:00.000Z',
      toIso: '2026-01-16T04:00:00.000Z',
    });
  });

  it('multi-day summer range spans from fromKey start to (toKey+1) start', () => {
    expect(businessDayRange('2026-06-01', '2026-06-07')).toEqual({
      fromIso: '2026-06-01T03:00:00.000Z',
      toIso: '2026-06-08T03:00:00.000Z',
    });
  });

  it('range crossing a month boundary advances toIso into the next month', () => {
    expect(businessDayRange('2026-06-28', '2026-07-02')).toEqual({
      fromIso: '2026-06-28T03:00:00.000Z',
      toIso: '2026-07-03T03:00:00.000Z',
    });
  });

  it('range crossing a year boundary advances toIso into the next year (winter)', () => {
    expect(businessDayRange('2026-12-30', '2027-01-02')).toEqual({
      fromIso: '2026-12-30T04:00:00.000Z',
      toIso: '2027-01-03T04:00:00.000Z',
    });
  });

  it('honors a custom cutover hour (0 = naive Cairo calendar day)', () => {
    // cutover 0, summer: business day starts at 00:00 Cairo = 21:00Z prev day.
    expect(businessDayRange('2026-06-15', '2026-06-15', 0)).toEqual({
      fromIso: '2026-06-14T21:00:00.000Z',
      toIso: '2026-06-15T21:00:00.000Z',
    });
  });

  it('honors a custom timezone argument (UTC, cutover 6)', () => {
    expect(businessDayRange('2026-06-15', '2026-06-15', 6, 'UTC')).toEqual({
      fromIso: '2026-06-15T06:00:00.000Z',
      toIso: '2026-06-16T06:00:00.000Z',
    });
  });
});

// ─── The cutover boundary: in/out of the range by one minute ─────────────────
describe('businessDayRange — cutover boundary inclusion', () => {
  const { fromIso, toIso } = businessDayRange('2026-06-15', '2026-06-15'); // cutover 6

  it('05:59 Cairo (before cutover) is the PREVIOUS business day -> excluded', () => {
    const justBefore = '2026-06-15T02:59:00.000Z'; // 05:59 Cairo (UTC+3)
    expect(businessDayKey(justBefore)).toBe('2026-06-14');
    expect(justBefore >= fromIso).toBe(false);
  });

  it('06:00 Cairo (cutover instant) opens the business day -> included (fromIso)', () => {
    const atCutover = '2026-06-15T03:00:00.000Z'; // 06:00 Cairo
    expect(businessDayKey(atCutover)).toBe('2026-06-15');
    expect(atCutover).toBe(fromIso);
    expect(atCutover >= fromIso && atCutover < toIso).toBe(true);
  });

  it('05:59 Cairo the next morning is still the same business day -> included', () => {
    const lateNight = '2026-06-16T02:59:00.000Z'; // 05:59 Cairo next day
    expect(businessDayKey(lateNight)).toBe('2026-06-15');
    expect(lateNight >= fromIso && lateNight < toIso).toBe(true);
  });

  it('06:00 Cairo the next morning rolls to the next business day -> excluded (toIso)', () => {
    const nextCutover = '2026-06-16T03:00:00.000Z';
    expect(businessDayKey(nextCutover)).toBe('2026-06-16');
    expect(nextCutover).toBe(toIso);
    expect(nextCutover < toIso).toBe(false);
  });
});

// ─── The load-bearing parity invariant (ADR-0007 Decision 3) ─────────────────
describe('businessDayRange <-> businessDayKey parity', () => {
  // Fixture of instants incl. a 02:00 Cairo late-night instant, a 06:00 cutover
  // instant, a UTC-vs-Cairo calendar-boundary instant, and a DST-period instant.
  const fixture = [
    '2026-06-09T23:30:00.000Z', // 02:30 Cairo 2026-06-10 -> key 2026-06-09 (late night, prev day)
    '2026-06-10T00:00:00.000Z', // 03:00 Cairo 2026-06-10 -> still prev business day
    '2026-06-10T03:00:00.000Z', // 06:00 Cairo 2026-06-10 -> key 2026-06-10 (cutover)
    '2026-06-10T10:00:00.000Z', // 13:00 Cairo -> key 2026-06-10
    '2026-06-10T21:30:00.000Z', // 00:30 Cairo 2026-06-11 (UTC day differs from Cairo day) -> key 2026-06-10
    '2026-06-11T02:59:00.000Z', // 05:59 Cairo 2026-06-11 -> key 2026-06-10
    '2026-04-24T12:00:00.000Z', // Egypt DST spring-forward day -> key 2026-04-24
    '2026-10-30T01:00:00.000Z', // around Egypt DST fall-back -> well-defined key
  ];

  const ranges: Array<[string, string]> = [
    ['2026-06-10', '2026-06-10'],
    ['2026-06-09', '2026-06-11'],
    ['2026-04-24', '2026-04-24'],
    ['2026-10-30', '2026-10-30'],
  ];

  for (const [fromKey, toKey] of ranges) {
    it(`instant ∈ [fromIso,toIso) iff businessDayKey ∈ [${fromKey},${toKey}]`, () => {
      const { fromIso, toIso } = businessDayRange(fromKey, toKey);
      for (const at of fixture) {
        const inWindow = at >= fromIso && at < toIso;
        const key = businessDayKey(at);
        const inKeyRange = key >= fromKey && key <= toKey;
        expect(inWindow).toBe(inKeyRange);
      }
    });
  }

  it('bound endpoints map exactly: businessDayKey(fromIso)=fromKey, last instant before toIso=toKey', () => {
    for (const [fromKey, toKey] of ranges) {
      const { fromIso, toIso } = businessDayRange(fromKey, toKey);
      expect(businessDayKey(fromIso)).toBe(fromKey);
      const lastIncluded = new Date(Date.parse(toIso) - 1).toISOString();
      expect(businessDayKey(lastIncluded)).toBe(toKey);
      // toIso itself is excluded and belongs to the day AFTER toKey.
      expect(businessDayKey(toIso) > toKey).toBe(true);
    }
  });

  it('parity holds for a custom cutover (3am) across the boundary', () => {
    const { fromIso, toIso } = businessDayRange('2026-06-10', '2026-06-10', 3);
    expect(businessDayKey(fromIso, 3)).toBe('2026-06-10');
    const lastIncluded = new Date(Date.parse(toIso) - 1).toISOString();
    expect(businessDayKey(lastIncluded, 3)).toBe('2026-06-10');
  });
});

// ─── daysInRange ─────────────────────────────────────────────────────────────
describe('daysInRange — inclusive calendar-day count', () => {
  it('single day is 1', () => {
    expect(daysInRange('2026-06-15', '2026-06-15')).toBe(1);
  });

  it('one week is 7', () => {
    expect(daysInRange('2026-06-01', '2026-06-07')).toBe(7);
  });

  it('counts across a month boundary', () => {
    expect(daysInRange('2026-06-28', '2026-07-02')).toBe(5);
  });

  it('counts across a year boundary', () => {
    expect(daysInRange('2026-12-30', '2027-01-02')).toBe(4);
  });

  it('counts a full non-leap February correctly', () => {
    expect(daysInRange('2026-02-01', '2026-02-28')).toBe(28);
  });
});

// ─── formatEgpPlain ──────────────────────────────────────────────────────────
describe('formatEgpPlain — CSV decimal EGP, Western digits', () => {
  it('zero -> 0.00', () => {
    expect(formatEgpPlain(0)).toBe('0.00');
  });

  it('sub-EGP amounts keep two decimals', () => {
    expect(formatEgpPlain(5)).toBe('0.05');
    expect(formatEgpPlain(50)).toBe('0.50');
    expect(formatEgpPlain(99)).toBe('0.99');
  });

  it('whole pounds show .00', () => {
    expect(formatEgpPlain(100)).toBe('1.00');
  });

  it('exact decimal for a mixed amount', () => {
    expect(formatEgpPlain(123450)).toBe('1234.50');
  });

  it('negatives carry a leading minus', () => {
    expect(formatEgpPlain(-250)).toBe('-2.50');
    expect(formatEgpPlain(-1)).toBe('-0.01');
  });

  it('large values stay exact with no thousands separator', () => {
    const out = formatEgpPlain(1234567890); // 12,345,678.90 EGP
    expect(out).toBe('12345678.90');
    expect(out).not.toContain('٬'); // no Arabic group separator
    expect(out).not.toContain(','); // no Western group separator
  });

  it('uses Western digits only (no Arabic-Indic)', () => {
    expect(formatEgpPlain(123450)).toMatch(/^[0-9.]+$/);
  });

  it('defensively rounds a non-integer input once (no float drift)', () => {
    expect(formatEgpPlain(250.4)).toBe('2.50');
    expect(formatEgpPlain(250.6)).toBe('2.51');
  });
});

// ─── Public surface is exported through the package root ──────────────────────
describe('package root re-exports', () => {
  it('exposes businessDayRange, daysInRange, formatEgpPlain', () => {
    expect(typeof core.businessDayRange).toBe('function');
    expect(typeof core.daysInRange).toBe('function');
    expect(typeof core.formatEgpPlain).toBe('function');
  });
});
