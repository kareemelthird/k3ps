/**
 * entitlements — pure SaaS-billing access resolver (ADR-0010 §Q7).
 *
 * Turns a tenant's subscription snapshot + plan + "now" into the effective
 * access level: limits, features, the operational read-only gate, and the
 * past_due grace window. Reused by the web paywall/usage meters (and optionally
 * mobile). The DB cap trigger reads the SAME plan limits, so the two layers
 * cannot disagree.
 *
 * HARD RULES (CLAUDE.md §2.4): pure (no framework/Supabase imports), the clock
 * is an argument (no internal `Date.now`), deterministic, never throws on
 * missing input. This is the platform → tenant ACCESS axis; it never computes
 * café money (that is the pricing engine).
 */
export {
  type PlanKey,
  type SubscriptionStatus,
  type CapResource,
  type PlanLimits,
  type PlanFeatures,
  type PlanDef,
  type SubscriptionSnapshot,
  type EntitlementConfig,
  type Entitlement,
  DEFAULT_GRACE_DAYS,
  resolveEntitlement,
  computeGraceUntil,
  canCreate,
} from './entitlements';
