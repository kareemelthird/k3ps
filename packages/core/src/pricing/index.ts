/**
 * pricing — open-meter cost math (integer piastres, pure).
 *
 * Phase 3 ships the single open-meter helper so the counters bill through
 * @ps/core instead of inline floats. Phase 4 will add rate-rule resolution and
 * the multi-segment session engine here, reusing this helper per segment.
 *
 * HARD RULES (CLAUDE.md §2.1, §2.4, §4):
 *   - Money is integer piastres; rounding happens once per period.
 *   - Pure: instants passed in, no wall-clock read in cost math.
 *   - No React / RN / Next / Supabase imports.
 */
export {
  type OpenMeterOptions,
  roundUpMinutes,
  billableMinutes,
  openMeterCostPiastres,
} from './open-meter';
