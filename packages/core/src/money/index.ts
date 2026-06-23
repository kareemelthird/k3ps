/**
 * money — integer piastres (100 piastres = 1 EGP).
 *
 * HARD RULES (CLAUDE.md §2.1, §4):
 *   - Money is always integer piastres. Never store or pass floats for money.
 *   - Round once via Math.round; no accumulated float drift.
 *   - All display goes through formatEgp / toArabicDigits — never inline in UI.
 *   - No React / RN / Next / Supabase imports here.
 */
export {
  type Piastres,
  CURRENCY,
  toArabicDigits,
  egpToPiastres,
  piastresToEgp,
  formatEgp,
  sumPiastres,
} from './money';
