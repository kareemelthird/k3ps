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

/** Group a non-negative integer into thousands using the Arabic separator. */
function groupThousands(n: number): string {
  // Locale-free grouping so output is deterministic regardless of host locale.
  const s = n.toString();
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const fromEnd = s.length - i;
    if (i > 0 && fromEnd % 3 === 0) out += CURRENCY.groupSeparator;
    out += s[i];
  }
  return out;
}

/**
 * Sum a list of piastre amounts. Integers in, integer out (each addend is
 * rounded defensively). `sumPiastres([])` is `0`.
 */
export function sumPiastres(amounts: Piastres[]): Piastres {
  return amounts.reduce<Piastres>((acc, n) => acc + Math.round(n), 0);
}
