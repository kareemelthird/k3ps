/**
 * Open-meter cost helper — invariants from pricing-engine-guard:
 *  (1) integer piastres only, rounded ONCE; (2) round-up + min-charge applied
 *  once per period; (4) purity — instants in, same input → same output, no
 *  clock read. Covers rounding boundaries, min-charge floor, zero/negative
 *  elapsed, exact hours, and the null-end guard that keeps cost math pure.
 */
import {
  billableMinutes,
  openMeterCostPiastres,
  roundUpMinutes,
} from './open-meter';

// Fixed UTC anchors so tests never touch the system clock.
const start = '2026-06-23T10:00:00.000Z';
/** ISO instant `mins` minutes after `start`. */
const at = (mins: number): string =>
  new Date(Date.parse(start) + mins * 60_000).toISOString();

describe('roundUpMinutes', () => {
  it('returns 0 for zero or negative minutes', () => {
    expect(roundUpMinutes(0, 5)).toBe(0);
    expect(roundUpMinutes(-3, 5)).toBe(0);
  });

  it('rounds up to the nearest increment', () => {
    expect(roundUpMinutes(31, 5)).toBe(35);
    expect(roundUpMinutes(30, 5)).toBe(30); // exact multiple unchanged
    expect(roundUpMinutes(0.1, 5)).toBe(5);
  });

  it('ceils to whole minutes when increment <= 0', () => {
    expect(roundUpMinutes(30.2, 0)).toBe(31);
    expect(roundUpMinutes(30.0, 0)).toBe(30);
    expect(roundUpMinutes(30.2, -1)).toBe(31);
  });
});

describe('billableMinutes', () => {
  it('with no options, ceils partial minutes to whole minutes', () => {
    expect(billableMinutes(30.4)).toBe(31);
    expect(billableMinutes(0)).toBe(0);
  });

  it('applies the rounding increment', () => {
    expect(billableMinutes(31, { roundingMinutes: 5 })).toBe(35);
  });

  it('takes the larger of rounded minutes and the min-charge floor', () => {
    expect(billableMinutes(3, { minChargeMinutes: 30 })).toBe(30); // floor wins
    expect(billableMinutes(45, { minChargeMinutes: 30 })).toBe(45); // played wins
  });

  it('ignores a non-positive min-charge', () => {
    expect(billableMinutes(0, { minChargeMinutes: 0 })).toBe(0);
    expect(billableMinutes(0, { minChargeMinutes: -10 })).toBe(0);
  });

  it('combines rounding then floor', () => {
    // 26 -> round up to 30, floor 20 -> max(30, 20) = 30
    expect(billableMinutes(26, { roundingMinutes: 5, minChargeMinutes: 20 })).toBe(30);
    // 6 -> round up to 10, floor 20 -> max(10, 20) = 20
    expect(billableMinutes(6, { roundingMinutes: 5, minChargeMinutes: 20 })).toBe(20);
  });
});

describe('openMeterCostPiastres', () => {
  const RATE = 6000; // 60 EGP/hour in piastres

  it('bills an exact hour as exactly the hourly rate', () => {
    expect(openMeterCostPiastres(start, at(60), RATE)).toBe(6000);
  });

  it('bills exactly half an hour at half rate', () => {
    expect(openMeterCostPiastres(start, at(30), RATE)).toBe(3000);
  });

  it('clamps negative elapsed (end before start) to 0', () => {
    const before = new Date(Date.parse(start) - 10 * 60_000).toISOString();
    expect(openMeterCostPiastres(start, before, RATE)).toBe(0);
  });

  it('zero elapsed with no min-charge costs 0', () => {
    expect(openMeterCostPiastres(start, start, RATE)).toBe(0);
  });

  it('applies the min-charge floor on a very short session', () => {
    // 3 min played, min-charge 30 min -> 30/60 * 6000 = 3000
    expect(
      openMeterCostPiastres(start, at(3), RATE, { minChargeMinutes: 30 }),
    ).toBe(3000);
  });

  it('min-charge applies even at zero elapsed', () => {
    expect(
      openMeterCostPiastres(start, start, RATE, { minChargeMinutes: 15 }),
    ).toBe(1500); // 15/60 * 6000
  });

  it('rounds elapsed UP to the increment before billing', () => {
    // 31 min @ rounding 5 -> 35 billed -> 35/60 * 6000 = 3500
    expect(
      openMeterCostPiastres(start, at(31), RATE, { roundingMinutes: 5 }),
    ).toBe(3500);
  });

  it('rounds the money exactly once (no float drift)', () => {
    // 7 min @ 6000/hr = 7/60*6000 = 700 exactly
    expect(openMeterCostPiastres(start, at(7), RATE)).toBe(700);
    // 1 min @ 6001/hr = 100.0166.. -> rounds to 100
    expect(openMeterCostPiastres(start, at(1), 6001)).toBe(100);
    // 1 min @ 6030/hr = 100.5 -> Math.round -> 101
    expect(openMeterCostPiastres(start, at(1), 6030)).toBe(101);
  });

  it('always returns an integer', () => {
    const out = openMeterCostPiastres(start, at(37), 5555, { roundingMinutes: 5 });
    expect(Number.isInteger(out)).toBe(true);
  });

  it('is deterministic — same inputs, same output', () => {
    const a = openMeterCostPiastres(start, at(45), RATE, { roundingMinutes: 5 });
    const b = openMeterCostPiastres(start, at(45), RATE, { roundingMinutes: 5 });
    expect(a).toBe(b);
  });

  it('throws when endIso is null (no implicit clock read)', () => {
    expect(() => openMeterCostPiastres(start, null, RATE)).toThrow(/endIso/);
  });

  it('summing per-segment costs never re-rounds the total', () => {
    // Two back-to-back segments at the same rate must equal one combined call.
    const seg1 = openMeterCostPiastres(start, at(20), RATE);
    const seg2 = openMeterCostPiastres(at(20), at(45), RATE);
    const combined = openMeterCostPiastres(start, at(45), RATE);
    expect(seg1 + seg2).toBe(combined);
  });
});
