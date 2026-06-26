/**
 * Entitlements — the pure resolver that turns a tenant's subscription + plan +
 * "now" into the effective access level (limits, features, read-only gate, grace
 * window). It is the SaaS-billing decision layer (ADR-0010 §Q7) and is reused by
 * the web paywall/usage meters and optionally mobile.
 *
 * HARD RULES (CLAUDE.md §2.4, §4; ADR-0010 §Q7):
 *   - PURE: no React / RN / Expo / Next / Supabase imports. Runs in plain Node.
 *   - The clock is an ARGUMENT (`nowIso`). No system-clock read inside decisions
 *     (so the purity guard's clock check stays green and output is deterministic).
 *   - Limits are integers (plan caps); money is never touched here (that is the
 *     café pricing axis). This module decides ACCESS, not price.
 *   - Never throws on missing/partial input — it returns a safe, non-bricking
 *     default (fail OPEN on a billing-data gap, mirroring the DB cap trigger).
 *
 * READ-ONLY TRUTH TABLE (ADR-0010 §Q7 — implemented EXACTLY here):
 *
 *   | status      | condition                                  | isReadOnly | graceUntil |
 *   |-------------|--------------------------------------------|------------|------------|
 *   | any         | comped === true                            | false      | null       |
 *   | active      | —                                          | false      | null       |
 *   | trialing    | now <= trialEnd                            | false      | null       |
 *   | trialing    | now >  trialEnd                            | true       | null       |
 *   | past_due    | now <= currentPeriodEnd + graceDays        | false      | thatTs     |
 *   | past_due    | now >  currentPeriodEnd + graceDays        | true       | null       |
 *   | canceled    | —                                          | true       | null       |
 *   | incomplete  | —                                          | true       | null       |
 *
 * "read-only" means OPERATIONAL writes are gated (start sessions / take orders).
 * The billing / Checkout / Portal path is ALWAYS reachable and is never modelled
 * as blocked — an owner can always pay to recover (ADR-0010 §Q6, AC 4/28).
 */
import { dayjs } from '../time/time';

/** The subscription tiers (ADR-0010 §Q1). Adding a tier is a data change. */
export type PlanKey = 'trial' | 'basic' | 'pro';

/** Subscription lifecycle status, mapped from Stripe (ADR-0010 §Q4). */
export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'incomplete';

/** A countable, cap-enforced resource (ADR-0010 §Q3). */
export type CapResource = 'branch' | 'device' | 'staff';

/**
 * Per-plan creation caps. Integers (per ADR-0010 §Q1 the DB stores `int`
 * columns). A `null` or negative value is treated as "unlimited" by
 * {@link canCreate} (defensive — no current tier is unlimited).
 */
export interface PlanLimits {
  maxBranches: number;
  maxDevices: number;
  maxStaff: number;
}

/** Forward-flexible feature-flag set (ADR-0010 §Q1, `plans.features` JSONB). */
export interface PlanFeatures {
  [flag: string]: boolean;
}

/** A resolved plan row from the catalog. */
export interface PlanDef {
  key: PlanKey;
  limits: PlanLimits;
  features: PlanFeatures;
}

/**
 * A snapshot of the tenant's `subscriptions` row. ISO strings only — no `Date`
 * objects cross the pure boundary (ADR-0010 §Q7).
 */
export interface SubscriptionSnapshot {
  status: SubscriptionStatus;
  planKey: PlanKey;
  comped: boolean;
  /** ISO; the app-side trial end (ADR-0010 §Q6). */
  trialEnd: string | null;
  /** ISO; the current Stripe billing-period end (drives the grace window). */
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

/** Platform-level config injected at the call site (ADR-0010 §Q6). */
export interface EntitlementConfig {
  /** Days of full access after `currentPeriodEnd` while `past_due`. */
  graceDays: number;
}

/** The resolved access level for a tenant. */
export interface Entitlement {
  status: SubscriptionStatus;
  planKey: PlanKey;
  limits: PlanLimits;
  features: PlanFeatures;
  /** Operational writes gated (NOT the billing path, which is always reachable). */
  isReadOnly: boolean;
  /** ISO; non-null ONLY inside the `past_due` grace window (banner state). */
  graceUntil: string | null;
  /** ISO; passthrough of the trial end for countdown display. */
  trialEnd: string | null;
}

/** Platform default grace length (ADR-0010 §Q6, `platform_settings`). */
export const DEFAULT_GRACE_DAYS = 7;

/**
 * Fail-open fallback plan used only when no plan is resolvable. Unlimited caps
 * (so {@link canCreate} never blocks on a data gap) and no features. Mirrors the
 * DB cap trigger's "fail open on missing subscription" rule (ADR-0010 §Q3) —
 * we must never brick a tenant over a billing-row gap.
 */
const FALLBACK_PLAN: PlanDef = {
  key: 'trial',
  limits: {
    maxBranches: Number.MAX_SAFE_INTEGER,
    maxDevices: Number.MAX_SAFE_INTEGER,
    maxStaff: Number.MAX_SAFE_INTEGER,
  },
  features: {},
};

/** Strictly `a > b` for two ISO instants (no clock read). */
function isAfter(aIso: string, bIso: string): boolean {
  return dayjs(aIso).valueOf() > dayjs(bIso).valueOf();
}

/**
 * The end of the `past_due` grace window: `currentPeriodEnd + graceDays`, as a
 * canonical UTC ISO string. Returns `null` when there is no period end to anchor
 * on (an unanchored `past_due` has no computable grace → treated as lapsed by
 * {@link resolveEntitlement}). Pure: dates in, date out, no clock read.
 */
export function computeGraceUntil(
  sub: SubscriptionSnapshot | null | undefined,
  graceDays: number,
): string | null {
  if (sub == null || sub.currentPeriodEnd == null) return null;
  const days = Number.isFinite(graceDays) ? graceDays : DEFAULT_GRACE_DAYS;
  return dayjs(sub.currentPeriodEnd).add(days, 'day').toISOString();
}

/**
 * Resolve a tenant's effective entitlement from its subscription snapshot, the
 * resolved plan, platform config, and the caller-supplied `nowIso`.
 *
 * Implements the ADR-0010 §Q7 truth table exactly. Never throws: a missing
 * subscription fails OPEN (full access, no grace) so a billing-data gap can
 * never brick operations; an unknown status fails CLOSED (read-only) while
 * leaving the billing path reachable.
 *
 * @param sub    the subscription snapshot (nullish → safe fail-open default)
 * @param plan   the resolved plan (nullish → unlimited fallback plan)
 * @param cfg    platform config (nullish graceDays → {@link DEFAULT_GRACE_DAYS})
 * @param nowIso the reference instant as a UTC ISO string (an ARGUMENT)
 */
export function resolveEntitlement(
  sub: SubscriptionSnapshot | null | undefined,
  plan: PlanDef | null | undefined,
  cfg: EntitlementConfig | null | undefined,
  nowIso: string,
): Entitlement {
  const resolvedPlan = plan ?? FALLBACK_PLAN;
  const limits = resolvedPlan.limits;
  const features = resolvedPlan.features ?? {};
  const planKey = resolvedPlan.key;
  const graceDays = cfg?.graceDays ?? DEFAULT_GRACE_DAYS;

  // Missing subscription → fail OPEN (never brick over a billing-row gap).
  if (sub == null) {
    return {
      status: 'active',
      planKey,
      limits,
      features,
      isReadOnly: false,
      graceUntil: null,
      trialEnd: null,
    };
  }

  const base = {
    status: sub.status,
    planKey,
    limits,
    features,
    trialEnd: sub.trialEnd ?? null,
  };

  // comp overrides ALL payment-state gating (ADR-0010 §Q7, AC 5).
  if (sub.comped === true) {
    return { ...base, isReadOnly: false, graceUntil: null };
  }

  switch (sub.status) {
    case 'active':
      return { ...base, isReadOnly: false, graceUntil: null };

    case 'trialing': {
      // Full access while now <= trialEnd. A missing trialEnd fails OPEN (a
      // trialing row with no end is a data anomaly we must not brick on).
      const expired = sub.trialEnd != null && isAfter(nowIso, sub.trialEnd);
      return { ...base, isReadOnly: expired, graceUntil: null };
    }

    case 'past_due': {
      const graceUntil = computeGraceUntil(sub, graceDays);
      const withinGrace = graceUntil != null && !isAfter(nowIso, graceUntil);
      return {
        ...base,
        isReadOnly: !withinGrace,
        graceUntil: withinGrace ? graceUntil : null,
      };
    }

    case 'canceled':
    case 'incomplete':
      return { ...base, isReadOnly: true, graceUntil: null };

    default:
      // Unknown status → fail CLOSED (read-only), billing still reachable.
      return { ...base, isReadOnly: true, graceUntil: null };
  }
}

/** Map a {@link CapResource} to its limit field on {@link PlanLimits}. */
function limitFor(limits: PlanLimits, resource: CapResource): number | null {
  switch (resource) {
    case 'branch':
      return limits.maxBranches;
    case 'device':
      return limits.maxDevices;
    case 'staff':
      return limits.maxStaff;
    default:
      return null;
  }
}

/**
 * UX pre-check: may the tenant create one more of `resource` right now? True iff
 * `currentCount` is STRICTLY below the plan cap. A `null`/`undefined` or negative
 * cap is treated as unlimited (always allowed). This mirrors the DB cap trigger
 * (ADR-0010 §Q3) — it is advisory UX; the trigger is the authoritative backstop.
 */
export function canCreate(
  ent: Entitlement,
  resource: CapResource,
  currentCount: number,
): boolean {
  const limit = limitFor(ent.limits, resource);
  if (limit == null || limit < 0) return true; // unlimited
  return currentCount < limit;
}
