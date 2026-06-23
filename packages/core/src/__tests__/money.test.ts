/**
 * Tests for money module — AC 1–5.
 * All AC references are from docs/specs/phase-2-tenant-foundation.md.
 */

import {
  egpToPiastres,
  piastresToEgp,
  formatEgp,
  sumPiastres,
  toArabicDigits,
  CURRENCY,
} from '../money/money';

// ─── AC 1: egpToPiastres ──────────────────────────────────────────────────────

describe('egpToPiastres', () => {
  test('AC 1a: egpToPiastres(12.5) === 1250', () => {
    expect(egpToPiastres(12.5)).toBe(1250);
    expect(Number.isInteger(egpToPiastres(12.5))).toBe(true);
  });

  test('AC 1b: egpToPiastres(0.1) === 10 (no float drift)', () => {
    expect(egpToPiastres(0.1)).toBe(10);
  });

  test('egpToPiastres(0) === 0', () => {
    expect(egpToPiastres(0)).toBe(0);
  });

  test('egpToPiastres(1) === 100', () => {
    expect(egpToPiastres(1)).toBe(100);
  });

  test('egpToPiastres(100) === 10000', () => {
    expect(egpToPiastres(100)).toBe(10000);
  });

  test('no accumulated drift across a sequence', () => {
    // Sum of 10 × 0.1 EGP should be exactly 100 piastres, not 99 or 101
    const sum = Array.from({ length: 10 }, () => egpToPiastres(0.1)).reduce(
      (a, b) => a + b,
      0,
    );
    expect(sum).toBe(100);
  });

  test('returns an integer (not a float)', () => {
    const result = egpToPiastres(1.23456789);
    expect(Number.isInteger(result)).toBe(true);
  });
});

// ─── AC 2: piastresToEgp ─────────────────────────────────────────────────────

describe('piastresToEgp', () => {
  test('AC 2a: piastresToEgp(1250) === 12.5', () => {
    expect(piastresToEgp(1250)).toBe(12.5);
  });

  test('AC 2b: round-trip for integer EGP values', () => {
    for (const egp of [0, 1, 5, 10, 50, 100, 1000]) {
      const piastres = egpToPiastres(egp);
      expect(piastresToEgp(piastres)).toBe(egp);
    }
  });

  test('piastresToEgp(0) === 0', () => {
    expect(piastresToEgp(0)).toBe(0);
  });
});

// ─── AC 3: formatEgp ─────────────────────────────────────────────────────────

describe('formatEgp', () => {
  test('AC 3: formatEgp(125000) contains Arabic thousands separator ٬', () => {
    const result = formatEgp(125000);
    expect(result).toContain('٬');
  });

  test('AC 3: formatEgp(125000) contains currency suffix ج.م', () => {
    const result = formatEgp(125000);
    expect(result).toContain(CURRENCY.suffix); // ج.م
  });

  test('AC 3: formatEgp(125000) omits .00 for whole pounds (125000 piastres = 1250 EGP)', () => {
    const result = formatEgp(125000);
    // Should not contain .00
    expect(result).not.toContain('.٠٠');
    expect(result).not.toContain('.00');
  });

  test('AC 3: formatEgp(-500) is negative (signed)', () => {
    const result = formatEgp(-500);
    expect(result).toContain('-');
  });

  test('formatEgp(0) works', () => {
    const result = formatEgp(0);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  test('formatEgp with fraction (not whole pounds)', () => {
    const result = formatEgp(150); // 1.50 EGP
    expect(result).toContain('.'); // should have fractional part
  });

  test('formatEgp withSuffix=false omits suffix', () => {
    const result = formatEgp(100, false);
    expect(result).not.toContain(CURRENCY.suffix);
  });

  test('formatEgp uses Arabic-Indic digits', () => {
    const result = formatEgp(100); // 1 EGP
    // Should not contain ASCII digits 0-9
    expect(/[0-9]/.test(result)).toBe(false);
  });

  test('formatEgp(100000) = 1000 EGP with thousands separator', () => {
    const result = formatEgp(100000);
    expect(result).toContain('٬');
  });
});

// ─── AC 4: sumPiastres ───────────────────────────────────────────────────────

describe('sumPiastres', () => {
  test('AC 4a: sumPiastres([10, 20, 30]) === 60', () => {
    expect(sumPiastres([10, 20, 30])).toBe(60);
  });

  test('AC 4b: sumPiastres([]) === 0', () => {
    expect(sumPiastres([])).toBe(0);
  });

  test('sumPiastres with a single element', () => {
    expect(sumPiastres([500])).toBe(500);
  });

  test('sumPiastres with negatives', () => {
    expect(sumPiastres([100, -50])).toBe(50);
  });

  test('sumPiastres result is an integer', () => {
    const result = sumPiastres([10, 20, 30]);
    expect(Number.isInteger(result)).toBe(true);
  });
});

// ─── AC 5: toArabicDigits ────────────────────────────────────────────────────

describe('toArabicDigits', () => {
  test("AC 5a: toArabicDigits('12345') === '١٢٣٤٥'", () => {
    expect(toArabicDigits('12345')).toBe('١٢٣٤٥');
  });

  test('AC 5b: non-digit characters are left unchanged', () => {
    const result = toArabicDigits('12 EGP, 34%');
    // Digits are mapped
    expect(result).toContain('١٢');
    expect(result).toContain('٣٤');
    // Non-digits remain
    expect(result).toContain(' EGP, ');
    expect(result).toContain('%');
  });

  test("toArabicDigits('0') === '٠'", () => {
    expect(toArabicDigits('0')).toBe('٠');
  });

  test("toArabicDigits('9') === '٩'", () => {
    expect(toArabicDigits('9')).toBe('٩');
  });

  test('toArabicDigits on a string with no digits returns it unchanged', () => {
    expect(toArabicDigits('hello')).toBe('hello');
  });

  test("toArabicDigits('0123456789') maps all digits", () => {
    expect(toArabicDigits('0123456789')).toBe('٠١٢٣٤٥٦٧٨٩');
  });
});
