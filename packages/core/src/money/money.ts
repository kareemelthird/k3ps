/**
 * Money — the single source of truth for currency math.
 *
 * Money is ALWAYS an integer number of piastres (100 piastres = 1 EGP).
 * Floating-point is never used to represent or accumulate money. Conversions
 * to/from human EGP go exclusively through `egpToPiastres` / `piastresToEgp`;
 * display goes through `formatEgp`. (CLAUDE.md §2.1, §4.)
 *
 * Localization note: the currency suffix and grouping separator are pinned to
 * EGP / Arabic here. They live behind named constants so a later multi-currency
 * change is localized to this file (see CURRENCY).
 */

/** An integer amount of piastres. 100 piastres = 1 EGP. */
export type Piastres = number;

/** Western (ASCII) digits mapped index-wise to Arabic-Indic digits. */
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/**
 * Currency presentation constants. Pinned to EGP today; isolating them here so a
 * future multi-currency feature is a localized change, not a call-site sweep.
 */
export const CURRENCY = {
  /** Smallest unit per major unit (100 piastres = 1 EGP). */
  subunitsPerUnit: 100,
  /** RTL-friendly currency suffix shown after the amount. */
  suffix: 'ج.م',
  /** Arabic thousands separator (U+066C). */
  groupSeparator: '٬',
  /** Decimal separator for the fractional part. */
  decimalSeparator: '.',
} as const;

/**
 * Convert Western digits in a string to Arabic-Indic (٠١٢٣…) for display.
 * Non-digit characters are left untouched.
 */
export function toArabicDigits(input: string): string {
  return input.replace(/[0-9]/g, (d) => ARABIC_DIGITS[Number(d)] ?? d);
}

/**
 * Convert an EGP amount (whole or fractional) to integer piastres.
 * Uses `Math.round` once at the boundary so no float drift accumulates.
 */
export function egpToPiastres(egp: number): Piastres {
  return Math.round(egp * CURRENCY.subunitsPerUnit);
}

/**
 * Convert integer piastres back to a EGP number. For display/round-trip only —
 * never feed the result back into money math without re-converting.
 */
export function piastresToEgp(piastres: Piastres): number {
  return piastres / CURRENCY.subunitsPerUnit;
}

/**
 * Format piastres as an Arabic-friendly EGP string.
 * - Arabic-Indic digits, Arabic thousands separator `٬`, suffix `ج.م`.
 * - Whole pounds omit the fractional part (e.g. 125000 -> "١٬٢٥٠ ج.م").
 * - Negatives carry a leading `-` sign.
 *
 * @param piastres integer piastres (rounded defensively)
 * @param withSuffix include the ` ج.م` suffix (default true)
 */
export function formatEgp(piastres: Piastres, withSuffix = true): string {
  const sign = piastres < 0 ? '-' : '';
  const abs = Math.abs(Math.round(piastres));
  const pounds = Math.floor(abs / CURRENCY.subunitsPerUnit);
  const cents = abs % CURRENCY.subunitsPerUnit;

  const poundsStr = groupThousands(pounds);
  const body =
    cents === 0
      ? poundsStr
      : `${poundsStr}${CURRENCY.decimalSeparator}${cents.toString().padStart(2, '0')}`;

  return `${sign}${toArabicDigits(body)}${withSuffix ? ` ${CURRENCY.suffix}` : ''}`;
}

/**
 * Machine-readable decimal-EGP string for CSV cells (ADR-0007 Decision 6):
 * integer piastres -> `'1234.50'` — exactly two decimals, **Western** digits,
 * dot decimal, **no** currency symbol and **no** thousands separator.
 *
 * This is the one place EGP is intentionally NOT Arabic-Indic: a CSV value an
 * accountant/spreadsheet parses. On-screen money stays `formatEgp` (Arabic).
 * Keeps currency formatting in @ps/core (CLAUDE.md §4), never inlined in UI.
 *
 * Pure and exact: integer arithmetic only, no float drift.
 *   - `formatEgpPlain(0)      === '0.00'`
 *   - `formatEgpPlain(50)     === '0.50'`
 *   - `formatEgpPlain(123450) === '1234.50'`
 *   - `formatEgpPlain(-250)   === '-2.50'`
 */
export function formatEgpPlain(piastres: Piastres): string {
  const sign = piastres < 0 ? '-' : '';
  const abs = Math.abs(Math.round(piastres));
  const pounds = Math.floor(abs / CURRENCY.subunitsPerUnit);
  const cents = abs % CURRENCY.subunitsPerUnit;
  return `${sign}${pounds}${CURRENCY.decimalSeparator}${cents.toString().padStart(2, '0')}`;
}

/** Group a non-negative integer into thousands using the Arabic separator. */
function groupThousands(n: number): string {
  return groupThousandsWith(n.toString(), CURRENCY.groupSeparator);
}

/**
 * Group a non-negative integer digit-string into thousands with an explicit
 * separator. Locale-free so output is deterministic regardless of host locale.
 */
function groupThousandsWith(digits: string, separator: string): string {
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    const fromEnd = digits.length - i;
    if (i > 0 && fromEnd % 3 === 0) out += separator;
    out += digits[i];
  }
  return out;
}

/**
 * Minor-unit exponent per ISO-4217 currency (digits after the decimal point).
 * The common cases; anything unmapped uses {@link DEFAULT_MINOR_DIGITS} (2).
 */
const CURRENCY_MINOR_DIGITS: Readonly<Record<string, number>> = {
  egp: 2,
  usd: 2,
  eur: 2,
  gbp: 2,
  sar: 2,
  aed: 2,
  jpy: 0,
  krw: 0,
  bhd: 3,
  kwd: 3,
  omr: 3,
  tnd: 3,
};

/** Fraction digits for a currency not listed in {@link CURRENCY_MINOR_DIGITS}. */
export const DEFAULT_MINOR_DIGITS = 2;

/** Options for {@link formatMoneyMinor}. */
export interface FormatMoneyMinorOptions {
  /** Render Arabic-Indic digits + Arabic grouping separator (default Western). */
  arabicDigits?: boolean;
}

/**
 * Format an integer amount of MINOR units in an arbitrary currency for display.
 *
 * This is the SEPARATE **platform-currency axis** (ADR-0010 §Q5): the SaaS
 * subscription charge a tenant pays the platform. It is intentionally distinct
 * from {@link formatEgp}, which stays pinned to the café's operational EGP
 * piastres and must not change. Both are integer minor units — never floats.
 *
 * Behaviour:
 *   - Fraction digits come from the currency (`USD`→2, `JPY`→0, `KWD`→3),
 *     defaulting to {@link DEFAULT_MINOR_DIGITS} for unknown codes.
 *   - The currency code is appended uppercased: `"1,234.50 USD"`.
 *   - `arabicDigits: true` → Arabic-Indic digits + `٬` grouping: `"١٬٢٣٤.٥٠ EGP"`.
 *   - Negatives carry a leading `-`. Zero formats as `"0.00 USD"` (or `"0 JPY"`).
 *
 * Pure and exact: integer arithmetic only, no float drift.
 *
 * @param minorUnits   integer amount in the currency's smallest unit
 * @param currencyCode ISO-4217-ish code (e.g. `'usd'`, `'EGP'`, `'JPY'`)
 * @param opts         display options ({@link FormatMoneyMinorOptions})
 */
export function formatMoneyMinor(
  minorUnits: number,
  currencyCode: string,
  opts: FormatMoneyMinorOptions = {},
): string {
  const code = (currencyCode ?? '').trim();
  const digits = CURRENCY_MINOR_DIGITS[code.toLowerCase()] ?? DEFAULT_MINOR_DIGITS;
  const arabic = opts.arabicDigits === true;
  const groupSep = arabic ? CURRENCY.groupSeparator : ',';

  const value = Math.round(minorUnits);
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);

  const divisor = 10 ** digits;
  const major = Math.floor(abs / divisor);
  const minor = abs % divisor;

  let body = groupThousandsWith(major.toString(), groupSep);
  if (digits > 0) {
    body += CURRENCY.decimalSeparator + minor.toString().padStart(digits, '0');
  }
  if (arabic) body = toArabicDigits(body);

  const codeOut = code.toUpperCase();
  return codeOut ? `${sign}${body} ${codeOut}` : `${sign}${body}`;
}

/**
 * Sum a list of piastre amounts. Integers in, integer out (each addend is
 * rounded defensively). `sumPiastres([])` is `0`.
 */
export function sumPiastres(amounts: Piastres[]): Piastres {
  return amounts.reduce<Piastres>((acc, n) => acc + Math.round(n), 0);
}
