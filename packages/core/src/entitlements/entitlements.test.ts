/**
 * Tests for the entitlements resolver (ADR-0010 §Q7; Phase-9 Block A, AC 1–6).
 *
 * Covers every status → access transition, trial countdown edges, the grace
 * boundary (exactly at graceUntil), canCreate at/under/over limit + unlimited,
 * and the missing-subscription safe default. The clock (`nowIso`) is always an
 * explicit argument — no system-clock dependence, fully deterministic.
 */
import {
  resolveEntitlement,
  computeGraceUntil,
  canCreate,
  DEFAULT_GRACE_DAYS,
  type PlanDef,
  type SubscriptionSnapshot,
  type EntitlementConfig,
  type Entitlement,
} from './entitlements';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PRO: PlanDef = {
  key: 'pro',
  limits: { maxBranches: 5, maxDevices: 50, maxStaff: 50 },
  features: { reports: true, multiBranch: true },
};

const TRIAL: PlanDef = {
  key: 'trial',
  limits: { maxBranches: 1, maxDevices: 5, maxStaff: 3 },
  features: {},
};

const CFG: EntitlementConfig = { graceDays: 7 };

function sub(partial: Partial<SubscriptionSnapshot>): SubscriptionSnapshot {
  return {
    status: 'active',
    planKey: 'pro',
    comped: false,
    trialEnd: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    ...partial,
  };
}

// ─── AC 1: active → full access, plan limits, no grace ────────────────────────

describe('resolveEntitlement — active (AC 1)', () => {
  const ent = resolveEntitlement(
    sub({ status: 'active', planKey: 'pro' }),
    PRO,
    CFG,
    '2026-06-26T10:00:00.000Z',
  );

  test('returns the plan limits', () => {
    expect(ent.limits).toEqual({ maxBranches: 5, maxDevices: 50, maxStaff: 50 });
  });

  test('returns plan features and planKey', () => {
    expect(ent.features).toEqual({ reports: true, multiBranch: true });
    expect(ent.planKey).toBe('pro');
  });

  test('isReadOnly=false, graceUntil=null, status passthrough', () => {
    expect(ent.isReadOnly).toBe(false);
    expect(ent.graceUntil).toBeNull();
    expect(ent.status).toBe('active');
  });
});

// ─── AC 2: trialing with trial_end in the future → full access ────────────────

describe('resolveEntitlement — trialing (AC 2)', () => {
  const trialEnd = '2026-07-01T00:00:00.000Z';

  test('now before trial_end → full access, trialEnd surfaced', () => {
    const ent = resolveEntitlement(
      sub({ status: 'trialing', planKey: 'trial', trialEnd }),
      TRIAL,
      CFG,
      '2026-06-26T10:00:00.000Z',
    );
    expect(ent.isReadOnly).toBe(false);
    expect(ent.graceUntil).toBeNull();
    expect(ent.trialEnd).toBe(trialEnd);
    expect(ent.status).toBe('trialing');
  });

  test('now > trial_end → read-only (trial lapsed)', () => {
    const ent = resolveEntitlement(
      sub({ status: 'trialing', planKey: 'trial', trialEnd }),
      TRIAL,
      CFG,
      '2026-07-02T00:00:00.000Z',
    );
    expect(ent.isReadOnly).toBe(true);
    expect(ent.graceUntil).toBeNull();
  });

  test('now exactly at trial_end → still full access (inclusive boundary)', () => {
    const ent = resolveEntitlement(
      sub({ status: 'trialing', planKey: 'trial', trialEnd }),
      TRIAL,
      CFG,
      trialEnd,
    );
    expect(ent.isReadOnly).toBe(false);
  });

  test('one millisecond past trial_end → read-only', () => {
    const ent = resolveEntitlement(
      sub({ status: 'trialing', planKey: 'trial', trialEnd }),
      TRIAL,
      CFG,
      '2026-07-01T00:00:00.001Z',
    );
    expect(ent.isReadOnly).toBe(true);
  });

  test('trialing with null trial_end → fail open (not bricked)', () => {
    const ent = resolveEntitlement(
      sub({ status: 'trialing', planKey: 'trial', trialEnd: null }),
      TRIAL,
      CFG,
      '2026-06-26T10:00:00.000Z',
    );
    expect(ent.isReadOnly).toBe(false);
  });
});

// ─── AC 3: past_due grace window ──────────────────────────────────────────────

describe('resolveEntitlement — past_due grace (AC 3)', () => {
  const periodEnd = '2026-06-20T00:00:00.000Z';
  // graceDays 7 → graceUntil = 2026-06-27T00:00:00.000Z
  const graceUntil = '2026-06-27T00:00:00.000Z';

  test('within grace → not read-only, graceUntil returned', () => {
    const ent = resolveEntitlement(
      sub({ status: 'past_due', currentPeriodEnd: periodEnd }),
      PRO,
      CFG,
      '2026-06-25T00:00:00.000Z',
    );
    expect(ent.isReadOnly).toBe(false);
    expect(ent.graceUntil).toBe(graceUntil);
  });

  test('exactly at graceUntil → still in grace (inclusive), graceUntil returned', () => {
    const ent = resolveEntitlement(
      sub({ status: 'past_due', currentPeriodEnd: periodEnd }),
      PRO,
      CFG,
      graceUntil,
    );
    expect(ent.isReadOnly).toBe(false);
    expect(ent.graceUntil).toBe(graceUntil);
  });

  test('one millisecond past graceUntil → read-only, graceUntil cleared', () => {
    const ent = resolveEntitlement(
      sub({ status: 'past_due', currentPeriodEnd: periodEnd }),
      PRO,
      CFG,
      '2026-06-27T00:00:00.001Z',
    );
    expect(ent.isReadOnly).toBe(true);
    expect(ent.graceUntil).toBeNull();
  });

  test('past_due with no currentPeriodEnd → lapsed (read-only)', () => {
    const ent = resolveEntitlement(
      sub({ status: 'past_due', currentPeriodEnd: null }),
      PRO,
      CFG,
      '2026-06-25T00:00:00.000Z',
    );
    expect(ent.isReadOnly).toBe(true);
    expect(ent.graceUntil).toBeNull();
  });

  test('graceDays 0 → graceUntil equals currentPeriodEnd', () => {
    const ent = resolveEntitlement(
      sub({ status: 'past_due', currentPeriodEnd: periodEnd }),
      PRO,
      { graceDays: 0 },
      periodEnd,
    );
    expect(ent.isReadOnly).toBe(false);
    expect(ent.graceUntil).toBe(periodEnd);
  });
});

// ─── AC 4: canceled / incomplete → read-only, billing never blocked ──────────

describe('resolveEntitlement — canceled & incomplete (AC 4)', () => {
  test('canceled → read-only', () => {
    const ent = resolveEntitlement(
      sub({ status: 'canceled' }),
      PRO,
      CFG,
      '2026-06-26T10:00:00.000Z',
    );
    expect(ent.isReadOnly).toBe(true);
    expect(ent.graceUntil).toBeNull();
    // No field models the billing path as blocked — it is always reachable.
    expect(Object.keys(ent)).not.toContain('billingBlocked');
  });

  test('incomplete → read-only', () => {
    const ent = resolveEntitlement(
      sub({ status: 'incomplete' }),
      PRO,
      CFG,
      '2026-06-26T10:00:00.000Z',
    );
    expect(ent.isReadOnly).toBe(true);
    expect(ent.graceUntil).toBeNull();
  });

  test('unknown/malformed status → fail closed (read-only), no throw', () => {
    const ent = resolveEntitlement(
      sub({ status: 'bogus' as never }),
      PRO,
      CFG,
      '2026-06-26T10:00:00.000Z',
    );
    expect(ent.isReadOnly).toBe(true);
    expect(ent.graceUntil).toBeNull();
  });
});

// ─── AC 5: comped overrides payment state ─────────────────────────────────────

describe('resolveEntitlement — comped (AC 5)', () => {
  test('comped canceled → full access from the comped plan', () => {
    const ent = resolveEntitlement(
      sub({ status: 'canceled', comped: true, planKey: 'pro' }),
      PRO,
      CFG,
      '2026-06-26T10:00:00.000Z',
    );
    expect(ent.isReadOnly).toBe(false);
    expect(ent.graceUntil).toBeNull();
    expect(ent.limits).toEqual(PRO.limits);
  });

  test('comped past_due past grace → still full access', () => {
    const ent = resolveEntitlement(
      sub({
        status: 'past_due',
        comped: true,
        currentPeriodEnd: '2026-01-01T00:00:00.000Z',
      }),
      PRO,
      CFG,
      '2026-06-26T10:00:00.000Z',
    );
    expect(ent.isReadOnly).toBe(false);
  });
});

// ─── AC 6: missing-subscription safe default (fail open) ──────────────────────

describe('resolveEntitlement — missing input safe defaults (AC 6)', () => {
  test('null subscription → fail open, not read-only', () => {
    const ent = resolveEntitlement(null, PRO, CFG, '2026-06-26T10:00:00.000Z');
    expect(ent.isReadOnly).toBe(false);
    expect(ent.graceUntil).toBeNull();
    expect(ent.limits).toEqual(PRO.limits);
    expect(ent.status).toBe('active');
  });

  test('null subscription AND null plan → unlimited fallback, not bricked', () => {
    const ent = resolveEntitlement(null, null, CFG, '2026-06-26T10:00:00.000Z');
    expect(ent.isReadOnly).toBe(false);
    expect(canCreate(ent, 'branch', 999999)).toBe(true);
  });

  test('null cfg → DEFAULT_GRACE_DAYS used for the grace window', () => {
    const periodEnd = '2026-06-20T00:00:00.000Z';
    const ent = resolveEntitlement(
      sub({ status: 'past_due', currentPeriodEnd: periodEnd }),
      PRO,
      null,
      '2026-06-26T12:00:00.000Z', // 6 days in, default grace 7 → still in grace
    );
    expect(DEFAULT_GRACE_DAYS).toBe(7);
    expect(ent.isReadOnly).toBe(false);
    expect(ent.graceUntil).toBe('2026-06-27T00:00:00.000Z');
  });

  test('does not throw on a null plan with a present subscription', () => {
    expect(() =>
      resolveEntitlement(sub({ status: 'active' }), null, CFG, '2026-06-26T10:00:00.000Z'),
    ).not.toThrow();
  });

  // Branch coverage: line 168 — plan.features == null → defaults to {}
  // The PlanDef type documents features as required, but a DB row could return null
  // (e.g. corrupted or migrated row); the resolver must not crash or expose null.
  test('plan with null features → defaults to empty object (defensive branch)', () => {
    const planNullFeatures = {
      key: 'pro' as const,
      limits: { maxBranches: 5, maxDevices: 50, maxStaff: 50 },
      features: null as unknown as Record<string, boolean>,
    };
    const ent = resolveEntitlement(
      sub({ status: 'active' }),
      planNullFeatures,
      CFG,
      '2026-06-26T10:00:00.000Z',
    );
    expect(ent.features).toEqual({});
    expect(ent.isReadOnly).toBe(false);
  });
});

// ─── computeGraceUntil ────────────────────────────────────────────────────────

describe('computeGraceUntil', () => {
  test('adds graceDays to currentPeriodEnd as UTC ISO', () => {
    expect(
      computeGraceUntil(sub({ currentPeriodEnd: '2026-06-20T00:00:00.000Z' }), 7),
    ).toBe('2026-06-27T00:00:00.000Z');
  });

  test('null currentPeriodEnd → null', () => {
    expect(computeGraceUntil(sub({ currentPeriodEnd: null }), 7)).toBeNull();
  });

  test('null subscription → null', () => {
    expect(computeGraceUntil(null, 7)).toBeNull();
  });

  test('non-finite graceDays falls back to DEFAULT_GRACE_DAYS', () => {
    expect(
      computeGraceUntil(
        sub({ currentPeriodEnd: '2026-06-20T00:00:00.000Z' }),
        Number.NaN,
      ),
    ).toBe('2026-06-27T00:00:00.000Z');
  });
});

// ─── canCreate ────────────────────────────────────────────────────────────────

describe('canCreate', () => {
  const ent: Entitlement = resolveEntitlement(
    sub({ status: 'active' }),
    PRO, // branches 5, devices 50, staff 50
    CFG,
    '2026-06-26T10:00:00.000Z',
  );

  test('under limit → true', () => {
    expect(canCreate(ent, 'branch', 4)).toBe(true);
    expect(canCreate(ent, 'device', 0)).toBe(true);
  });

  test('at limit → false (strictly below)', () => {
    expect(canCreate(ent, 'branch', 5)).toBe(false);
    expect(canCreate(ent, 'staff', 50)).toBe(false);
  });

  test('over limit → false', () => {
    expect(canCreate(ent, 'device', 51)).toBe(false);
  });

  test('null limit → unlimited (true)', () => {
    const unlimited: Entitlement = {
      ...ent,
      limits: { maxBranches: null as unknown as number, maxDevices: 50, maxStaff: 50 },
    };
    expect(canCreate(unlimited, 'branch', 10_000)).toBe(true);
  });

  test('negative limit → treated as unlimited (true)', () => {
    const unlimited: Entitlement = {
      ...ent,
      limits: { maxBranches: -1, maxDevices: 50, maxStaff: 50 },
    };
    expect(canCreate(unlimited, 'branch', 10_000)).toBe(true);
  });

  test('unknown resource → defaults to unlimited (no crash)', () => {
    expect(canCreate(ent, 'unknown' as never, 10_000)).toBe(true);
  });
});
