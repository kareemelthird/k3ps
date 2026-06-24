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

// Phase 4 — rate-rule resolution + boundary enumeration (ADR-0005).
export {
  type RuleContext,
  type BoundaryContext,
  type SegmentPlan,
  ruleMatches,
  resolveRule,
  rateBoundaryInstants,
  planSegments,
} from './rate-rules';

// Phase 4 — session cost aggregation (open / prepaid / fixed-match / grand
// total / snapshot reconstruction).
export {
  type SegmentCostInput,
  type OpenMeterModifiers,
  type OpenMeterTotal,
  type PrepaidCostInput,
  type FixedMatchCostInput,
  type GrandTotalInput,
  type ReconstructInput,
  aggregateOpenMeter,
  computePrepaidCost,
  computeFixedMatchCost,
  computeGrandTotal,
  reconstructTimeCost,
} from './session-cost';
