'use client';

/**
 * /admin/subscriptions — Platform subscription management (design §7, AC 33–34).
 *
 * Content:
 *  - SubscriptionStatStrip: active / trialing / past_due counts + MRR
 *  - SubscriptionsTable: all subscriptions with filter + comp action
 *  - CompOverrideDialog: reason-gated plan grant/override
 *
 * Data: fetched client-side via Supabase. The super-admin SELECT-only RLS policy
 * (ADR-0008) grants cross-tenant access when is_super_admin() = true.
 * Mutations flow through the set-tenant-plan edge function — no service-role key.
 *
 * Money: formatMoneyMinor for MRR (platform currency) — NEVER formatEgp here.
 * All strings via i18n. Arabic-Indic numerals. RTL-first.
 * Security flag: comp dialog audited via edge fn which writes audit_log.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { getBrowserClient } from '@/lib/supabase/client';
import { AdminShell } from '@/components/admin/AdminShell';
import { SubscriptionStatStrip } from '@/components/admin/SubscriptionStatStrip';
import { SubscriptionsTable, type SubscriptionRow } from '@/components/admin/SubscriptionsTable';
import { CompOverrideDialog } from '@/components/admin/CompOverrideDialog';

// ── DB row shapes ─────────────────────────────────────────────────────────────

interface SubscriptionDbRow {
  tenant_id: string;
  plan: string;
  status: 'trialing' | 'active' | 'past_due' | 'canceled' | 'incomplete';
  comped: boolean;
  trial_end: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  stripe_subscription_id: string | null;
}

interface TenantDbRow {
  id: string;
  name: string;
}

interface PlanDbRow {
  key: string;
  name_key: string;
  price_amount: number | null;
  price_currency: string;
  sort_order: number;
}

// ── MRR computation ───────────────────────────────────────────────────────────

/**
 * Approximate MRR: sum of monthly price_amount for active (non-comped) subscriptions.
 * This is a rough MRR indicator only — displayed with "≈" prefix in the i18n key.
 * Platform currency only. No EGP involved.
 */
function computeApproxMrr(
  subs: SubscriptionDbRow[],
  plans: PlanDbRow[],
): { mrrMinor: number; currency: string; hasAmounts: boolean } {
  const planMap = new Map<string, PlanDbRow>(plans.map((p) => [p.key, p]));
  let mrrMinor = 0;
  let currency = 'egp'; // platform currency — seed data uses EGP
  let hasAmounts = false;
  for (const s of subs) {
    if (s.status !== 'active' || s.comped) continue;
    const plan = planMap.get(s.plan);
    if (plan?.price_amount) {
      mrrMinor += plan.price_amount;
      currency = plan.price_currency || currency;
      hasAmounts = true;
    }
  }
  return { mrrMinor, currency, hasAmounts };
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AdminSubscriptionsPage() {
  const t = useTranslations('admin.subs');
  const tAdmin = useTranslations('admin');

  const [subs, setSubs] = useState<SubscriptionDbRow[]>([]);
  const [tenants, setTenants] = useState<TenantDbRow[]>([]);
  const [plans, setPlans] = useState<PlanDbRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // CompOverride dialog state
  const [compTarget, setCompTarget] = useState<SubscriptionRow | null>(null);
  const [compSubmitting, setCompSubmitting] = useState(false);
  const [compError, setCompError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const supabase = getBrowserClient();
      const [subsResult, tenantsResult, plansResult] = await Promise.all([
        supabase
          .from('subscriptions')
          .select('tenant_id, plan, status, comped, trial_end, current_period_end, cancel_at_period_end, stripe_subscription_id')
          .order('status', { ascending: true }),
        supabase
          .from('tenants')
          .select('id, name')
          .order('name', { ascending: true }),
        supabase
          .from('plans')
          .select('key, name_key, price_amount, price_currency, sort_order')
          .eq('is_active', true)
          .order('sort_order', { ascending: true }),
      ]);

      if (subsResult.error) throw subsResult.error;
      if (tenantsResult.error) throw tenantsResult.error;
      if (plansResult.error) throw plansResult.error;

      setSubs((subsResult.data as SubscriptionDbRow[]) ?? []);
      setTenants((tenantsResult.data as TenantDbRow[]) ?? []);
      setPlans((plansResult.data as PlanDbRow[]) ?? []);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t('error'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // Compute stats
  const stats = {
    active: subs.filter((s) => s.status === 'active').length,
    trialing: subs.filter((s) => s.status === 'trialing').length,
    pastDue: subs.filter((s) => s.status === 'past_due').length,
  };

  const mrrResult = loading ? null : computeApproxMrr(subs, plans);
  const { mrrMinor, currency } = mrrResult ?? { mrrMinor: 0, currency: 'egp' };

  // Build plan lookup (name_key → human label from i18n billing.plan keys)
  const planNameMap = new Map<string, string>(
    plans.map((p) => [p.key, p.name_key]),
  );

  // Merge subs + tenants into table rows
  const tenantMap = new Map<string, string>(tenants.map((t) => [t.id, t.name]));
  const planAmountMap = new Map<string, { amount: number | null; currency: string }>(
    plans.map((p) => [p.key, { amount: p.price_amount, currency: p.price_currency }]),
  );

  const tableRows: SubscriptionRow[] = subs.map((s): SubscriptionRow => {
    const planAmtInfo = planAmountMap.get(s.plan);
    return {
      tenantId: s.tenant_id,
      tenantName: tenantMap.get(s.tenant_id) ?? s.tenant_id,
      plan: s.plan,
      status: s.status,
      comped: s.comped,
      trialEnd: s.trial_end,
      currentPeriodEnd: s.current_period_end,
      cancelAtPeriodEnd: s.cancel_at_period_end,
      amountMinor: planAmtInfo?.amount ?? null,
      currency: planAmtInfo?.currency ?? 'usd',
      stripeSubscriptionId: s.stripe_subscription_id,
    };
  });

  const planOptions = plans.map((p) => ({
    key: p.key,
    displayName: planNameMap.get(p.key) ?? p.key,
  }));

  // Comp handler — calls set-tenant-plan edge function
  const handleComp = useCallback(
    async (payload: { planKey: string; reason: string }) => {
      if (!compTarget) return;
      setCompSubmitting(true);
      setCompError(null);
      try {
        const supabase = getBrowserClient();
        const { error } = await supabase.functions.invoke('set-tenant-plan', {
          body: {
            tenant_id: compTarget.tenantId,
            plan_key: payload.planKey,
            reason: payload.reason,
            comped: true,
          },
        });
        if (error) throw error;
        setCompTarget(null);
        await loadData();
      } catch (err) {
        setCompError(err instanceof Error ? err.message : tAdmin('error.generic'));
      } finally {
        setCompSubmitting(false);
      }
    },
    [compTarget, loadData, tAdmin],
  );

  return (
    <AdminShell
      activeNav="subscriptions"
      pageTitle={t('title')}
    >
      <div className="flex flex-col gap-2xl">
        {/* Sub-heading */}
        <p className="text-body text-text-muted">{t('subtitle')}</p>

        {/* Stat strip */}
        <SubscriptionStatStrip
          active={loading ? null : stats.active}
          trialing={loading ? null : stats.trialing}
          pastDue={loading ? null : stats.pastDue}
          mrrMinor={loading ? null : (mrrResult?.hasAmounts ? mrrMinor : undefined)}
          currency={currency}
        />

        {/* Subscriptions table */}
        <SubscriptionsTable
          rows={tableRows}
          plans={planOptions}
          loading={loading}
          error={loadError}
          onComp={(row) => {
            setCompError(null);
            setCompTarget(row);
          }}
          onRetry={() => void loadData()}
        />
      </div>

      {/* Comp / override dialog — security: reason-gated + audited via edge fn */}
      {compTarget && (
        <CompOverrideDialog
          open={true}
          tenant={{ id: compTarget.tenantId, name: compTarget.tenantName }}
          plans={planOptions}
          currentPlanKey={compTarget.plan}
          onConfirm={(payload) => handleComp(payload)}
          submitting={compSubmitting}
          error={compError}
          onClose={() => {
            setCompTarget(null);
            setCompError(null);
          }}
        />
      )}
    </AdminShell>
  );
}
