/**
 * Tests for formatMoneyMinor — the SEPARATE platform-currency axis (ADR-0010 §Q5).
 * Integer minor units in, display string out. Distinct from formatEgp (which
 * stays EGP-pinned for café money). Western vs Arabic digits, multiple currency
 * minor-unit exponents (2 / 0 / 3), zero, sub-unit, large, and negative amounts.
 */
import { formatMoneyMinor, DEFAULT_MINOR_DIGITS } from './money';

describe('formatMoneyMinor — Western digits (default)', () => {
  test('zero formats with two decimals for a 2-digit currency', () => {
    expect(formatMoneyMinor(0, 'usd')).toBe('0.00 USD');
  });

  test('sub-unit amount keeps the fractional part', () => {
    expect(formatMoneyMinor(50, 'usd')).toBe('0.50 USD');
    expect(formatMoneyMinor(5, 'usd')).toBe('0.05 USD');
  });

  test('whole + fraction with thousands grouping', () => {
    expect(formatMoneyMinor(123450, 'usd')).toBe('1,234.50 USD');
  });

  test('large amount groups every three digits', () => {
    expect(formatMoneyMinor(1234567890, 'usd')).toBe('12,345,678.90 USD');
  });

  test('negative carries a leading minus', () => {
    expect(formatMoneyMinor(-250, 'usd')).toBe('-2.50 USD');
  });

  test('uppercases the currency code regardless of input case', () => {
    expect(formatMoneyMinor(100, 'eUr')).toBe('1.00 EUR');
  });
});

describe('formatMoneyMinor — currency minor-unit exponents', () => {
  test('JPY has zero fraction digits (no decimal point)', () => {
    expect(formatMoneyMinor(1234, 'jpy')).toBe('1,234 JPY');
    expect(formatMoneyMinor(0, 'jpy')).toBe('0 JPY');
  });

  test('KWD has three fraction digits', () => {
    expect(formatMoneyMinor(1234567, 'kwd')).toBe('1,234.567 KWD');
    expect(formatMoneyMinor(5, 'kwd')).toBe('0.005 KWD');
  });

  test('unknown currency code uses the default of two digits', () => {
    expect(DEFAULT_MINOR_DIGITS).toBe(2);
    expect(formatMoneyMinor(12345, 'xyz')).toBe('123.45 XYZ');
  });

  test('EGP on the platform axis (distinct call from formatEgp)', () => {
    expect(formatMoneyMinor(125000, 'egp')).toBe('1,250.00 EGP');
  });
});

describe('formatMoneyMinor — Arabic digits option', () => {
  test('Arabic-Indic digits with Arabic grouping separator', () => {
    expect(formatMoneyMinor(123450, 'egp', { arabicDigits: true })).toBe(
      '١٬٢٣٤.٥٠ EGP',
    );
  });

  test('Western vs Arabic differ only in glyphs/grouping, same value', () => {
    const western = formatMoneyMinor(99999, 'usd');
    const arabic = formatMoneyMinor(99999, 'usd', { arabicDigits: true });
    expect(western).toBe('999.99 USD');
    expect(arabic).toBe('٩٩٩.٩٩ USD');
  });

  test('negative Arabic amount', () => {
    expect(formatMoneyMinor(-150, 'egp', { arabicDigits: true })).toBe('-١.٥٠ EGP');
  });

  test('arabicDigits:false behaves as default Western', () => {
    expect(formatMoneyMinor(123450, 'usd', { arabicDigits: false })).toBe(
      '1,234.50 USD',
    );
  });
});

describe('formatMoneyMinor — edge inputs', () => {
  test('rounds a non-integer minor value defensively', () => {
    expect(formatMoneyMinor(100.4, 'usd')).toBe('1.00 USD');
    expect(formatMoneyMinor(100.6, 'usd')).toBe('1.01 USD');
  });

  test('empty currency code omits the suffix', () => {
    expect(formatMoneyMinor(12345, '')).toBe('123.45');
  });
});
