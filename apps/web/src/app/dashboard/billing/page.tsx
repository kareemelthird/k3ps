'use client';

/**
 * /dashboard/billing — Owner billing page (design §3, AC 25–29).
 *
 * Fetches:
 *  - subscriptions row (via RLS — tenant staff reads own)
 *  - plans catalog (authenticated read)
 *  - current usage counts (branches/devices/tenant_members)
 *
 * Resolves entitlement via @ps/core resolveEntitlement (pure, now injected).
 * Checkout/Portal: calls server-minted edge functions then redirects.
 * CheckoutReturnState: handles ?checkout=success|cancel and ?portal=return.
 *
 * Owner-only: manager/staff gets BillingDeniedState.
 * The billing page is ALWAYS reachable even in read-only mode (AC 28, binding).
 *
 * RTL. Arabic-Indic numerals. All strings via i18n. No Stripe secret in client.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  resolveEntitlement,
  canCreate,
  type SubscriptionSnapshot,
  type PlanDef,
  type Entitlement,
  DEFAULT_GRACE_DAYS,
} from '@ps/core';
import { useAuth } from '@/lib/auth/AuthContext';
import { getBrowserClient } from '@/lib/supabase/client';
import { DashboardPageShell } from '@/components/shell/DashboardPageShell';
import { BillingDeniedState } from '@/components/billing/BillingDeniedState';
import { PaywallBanner, type PaywallVariant } from '@/components/billing/PaywallBanner';
import { CurrentPlanCard } from '@/components/billing/CurrentPlanCard';
import { UsageMeterGroup } from '@/components/billing/UsageMeter';
import { PlanComparison, type PlanInfo } from '@/components/billing/PlanCard';
import { ErrorState } from '@/components/ui/ErrorState';

// ── DB row shapes ───────────────────────────────────────────────────────────

interface SubscriptionRow {
  tenant_id: string;
  plan: string;
  status: 'trialing' | 'active' | 'past_due' | 'canceled' | 'incomplete';
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  comped: boolean;
  trial_end: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
}

interface PlanRow {
  key: string;
  name_key: string;
  stripe_price_id: string | null;
  interval: string;
  max_branches: number;
  max_devices: number;
  max_staff: number;
  price_amount: number | null;
  price_currency: string;
  features: Record<string, boolean>;
  sort_order: number;
  is_active: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function daysBetween(aIso: string, bIso: string): number {
  return Math.max(0, Math.ceil((new Date(aIso).getTime() - new Date(bIso).getTime()) / 86_400_000));
}

function planRowToDef(row: PlanRow): PlanDef {
  return {
    key: row.key as PlanDef['key'],
    limits: {
      maxBranches: row.max_branches,
      maxDevices: row.max_devices,
      maxStaff: row.max_staff,
    },
    features: row.features ?? {},
  };
}

function planRowToInfo(row: PlanRow): PlanInfo {
  return {
    key: row.key,
    nameKey: row.name_key,
    amountMinor: row.price_amount,
    currency: row.price_currency ?? 'egp',
    interval: row.interval ?? 'month',
    maxBranches: row.max_branches,
    maxDevices: row.max_devices,
    maxStaff: row.max_staff,
    features: row.features ?? {},
    sortOrder: row.sort_order,
  };
}

function subRowToSnapshot(row: SubscriptionRow): SubscriptionSnapshot {
  return {
    status: row.status,
    planKey: row.plan as SubscriptionSnapshot['planKey'],
    comped: row.comped,
    trialEnd: row.trial_end,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: row.cancel_at_period_end,
  };
}

// ── Component ────────────────────────────────────────────────────────────────

function BillingContent() {
  const t = useTranslations('billing');
  const { claim } = useAuth();
  const searchParams = useSearchParams();
  const router = useRouter();

  // Owner gate (ADR-0008 scalar role check, fail-closed)
  const isOwner = claim?.roles === 'owner' || (claim?.is_super_admin ?? false);

  const [sub, setSub] = useState<SubscriptionRow | null>(null);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [usageCounts, setUsageCounts] = useState<{ branches: number; devices: number; staff: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);

  const [checkoutPending, setCheckoutPending] = useState(false);
  const [portalPending, setPortalPending] = useState(false);
  const [pendingPlanKey, setPendingPlanKey] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  const [returnToast, setReturnToast] = useState<'success' | 'cancel' | 'portal' | null>(null);
  const [finalizing, setFinalizing] = useState(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Handle Checkout/Portal return flags
  useEffect(() => {
    const checkout = searchParams.get('checkout');
    const portal = searchParams.get('portal');
    if (checkout === 'success') {
      setReturnToast('success');
      setFinalizing(true);
    } else if (checkout === 'cancel') {
      setReturnToast('cancel');
    } else if (portal === 'return') {
      setReturnToast('portal');
    }
    // Clear query string after handling
    if (checkout || portal) {
      router.replace('/dashboard/billing', { scroll: false });
    }
    // Auto-dismiss toast after 5s
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setReturnToast(null), 5000);
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadData = useCallback(async (): Promise<SubscriptionRow | null> => {
    if (!claim?.tenant_id) return null;
    setLoading(true);
    setLoadError(null);
    try {
      const supabase = getBrowserClient();
      const [subResult, plansResult] = await Promise.all([
        supabase.from('subscriptions').select('*').eq('tenant_id', claim.tenant_id).single(),
        supabase.from('plans').select('*').eq('is_active', true).order('sort_order', { ascending: true }),
      ]);
      if (subResult.error && subResult.error.code !== 'PGRST116') throw subResult.error;
      if (plansResult.error) throw plansResult.error;
      const freshSub = (subResult.data as SubscriptionRow) ?? null;
      setSub(freshSub);
      setPlans((plansResult.data as PlanRow[]) ?? []);
      return freshSub;
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t('error.load'));
      return null;
    } finally {
      setLoading(false);
    }
  }, [claim?.tenant_id, t]);

  const loadUsage = useCallback(async () => {
    if (!claim?.tenant_id) return;
    setUsageError(null);
    try {
      const supabase = getBrowserClient();
      const [branchRes, deviceRes, staffRes] = await Promise.all([
        supabase.from('branches').select('id', { count: 'exact', head: true }).eq('tenant_id', claim.tenant_id).eq('is_active', true),
        supabase.from('devices').select('id', { count: 'exact', head: true }).eq('tenant_id', claim.tenant_id).eq('is_active', true),
        supabase.from('tenant_members').select('profile_id', { count: 'exact', head: true }).eq('tenant_id', claim.tenant_id).eq('is_active', true),
      ]);
      setUsageCounts({
        branches: branchRes.count ?? 0,
        devices: deviceRes.count ?? 0,
        staff: staffRes.count ?? 0,
      });
    } catch (err) {
      setUsageError(err instanceof Error ? err.message : t('error.load'));
    }
  }, [claim?.tenant_id, t]);

  useEffect(() => {
    void loadData();
    void loadUsage();
  }, [loadData, loadUsage]);

  // Poll for finalizing state (webhook may take a moment).
  // loadData() returns the fresh sub row so we never read stale state.
  // MAX_ATTEMPTS caps the poll at 30 s (10 × 3 s) to prevent infinite loops.
  useEffect(() => {
    if (!finalizing) return;
    let attempts = 0;
    const MAX_ATTEMPTS = 10;
    const timer = setInterval(async () => {
      attempts += 1;
      const freshSub = await loadData();
      if (freshSub?.status === 'active' || attempts >= MAX_ATTEMPTS) {
        setFinalizing(false);
        clearInterval(timer);
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [finalizing, loadData]);

  // Resolve entitlement
  const nowIso = new Date().toISOString();
  const currentPlanRow = plans.find((p) => p.key === (sub?.plan ?? 'trial'));
  const currentPlanDef = currentPlanRow ? planRowToDef(currentPlanRow) : null;
  const subSnapshot = sub ? subRowToSnapshot(sub) : null;
  const entitlement: Entitlement = resolveEntitlement(
    subSnapshot,
    currentPlanDef,
    { graceDays: DEFAULT_GRACE_DAYS },
    nowIso,
  );

  // Paywall variant
  const paywallVariant = (() => {
    if (entitlement.status === 'trialing' && entitlement.trialEnd) {
      const daysLeft = daysBetween(entitlement.trialEnd, nowIso);
      if (daysLeft <= 7) return { variant: 'trialEnding' as PaywallVariant, daysLeft };
    }
    if (entitlement.graceUntil) {
      const daysLeft = daysBetween(entitlement.graceUntil, nowIso);
      return { variant: 'pastDueGrace' as PaywallVariant, daysLeft };
    }
    if (entitlement.isReadOnly) {
      return { variant: 'readOnly' as PaywallVariant, daysLeft: null };
    }
    if (entitlement.status === 'active' && sub?.comped) {
      return { variant: 'comped' as PaywallVariant, daysLeft: null };
    }
    return null;
  })();

  // Trial days left
  const trialDaysLeft = (() => {
    if (entitlement.status === 'trialing' && entitlement.trialEnd) {
      return daysBetween(entitlement.trialEnd, nowIso);
    }
    return null;
  })();

  // Grace elapsed
  const graceElapsed = entitlement.status === 'past_due' && !entitlement.graceUntil;

  // Checkout handler
  const handleUpgrade = useCallback(async (planKey: string) => {
    setCheckoutError(null);
    setPendingPlanKey(planKey);
    setCheckoutPending(true);
    try {
      const supabase = getBrowserClient();
      const { data, error } = await supabase.functions.invoke('create-checkout-session', {
        body: { plan_key: planKey },
      });
      if (error) throw error;
      const url = (data as { url?: string })?.url;
      if (!url) throw new Error(t('error.checkout'));
      window.location.href = url;
    } catch (err) {
      setCheckoutError(err instanceof Error ? err.message : t('error.checkout'));
    } finally {
      setCheckoutPending(false);
      setPendingPlanKey(null);
    }
  }, [t]);

  // Portal handler
  const handleManageBilling = useCallback(async () => {
    setCheckoutError(null);
    setPortalPending(true);
    try {
      const supabase = getBrowserClient();
      const { data, error } = await supabase.functions.invoke('create-portal-session', {
        body: {},
      });
      if (error) throw error;
      const url = (data as { url?: string })?.url;
      if (!url) throw new Error(t('error.portal'));
      window.location.href = url;
    } catch (err) {
      setCheckoutError(err instanceof Error ? err.message : t('error.portal'));
    } finally {
      setPortalPending(false);
    }
  }, [t]);

  // Subscribe CTA (for trial/no sub)
  const handleSubscribe = useCallback(async () => {
    // Default to basic plan for initial subscribe
    const basicPlan = plans.find((p) => p.key === 'basic');
    if (basicPlan) {
      await handleUpgrade('basic');
    }
  }, [plans, handleUpgrade]);

  if (!isOwner) {
    return <BillingDeniedState />;
  }

  if (loadError) {
    return <ErrorState message={loadError} onRetry={() => void loadData()} />;
  }

  // Usage meters
  const meters = [
    {
      labelKey: 'branches' as const,
      used: usageCounts?.branches ?? 0,
      limit: entitlement.limits.maxBranches < Number.MAX_SAFE_INTEGER ? entitlement.limits.maxBranches : null,
    },
    {
      labelKey: 'devices' as const,
      used: usageCounts?.devices ?? 0,
      limit: entitlement.limits.maxDevices < Number.MAX_SAFE_INTEGER ? entitlement.limits.maxDevices : null,
    },
    {
      labelKey: 'staff' as const,
      used: usageCounts?.staff ?? 0,
      limit: entitlement.limits.maxStaff < Number.MAX_SAFE_INTEGER ? entitlement.limits.maxStaff : null,
    },
  ];

  // canCreate pre-check (for UX hints)
  const _canCreateBranch = canCreate(entitlement, 'branch', usageCounts?.branches ?? 0);
  const _canCreateDevice = canCreate(entitlement, 'device', usageCounts?.devices ?? 0);
  const _canCreateStaff = canCreate(entitlement, 'staff', usageCounts?.staff ?? 0);

  const currentPlanInfo = currentPlanRow ? planRowToInfo(currentPlanRow) : null;
  const allPlanInfos = plans.map(planRowToInfo);

  return (
    <div className="flex flex-col gap-2xl">
      {/* Page header */}
      <div className="flex flex-col gap-xs">
        <h1 className="text-h1 text-text font-bold">{t('title')}</h1>
        <p className="text-body text-text-muted">{t('subtitle')}</p>
      </div>

      {/* Return-from-Checkout/Portal toast */}
      {returnToast && (
        <div
          role="status"
          aria-live="polite"
          className={`rounded-md border px-md py-sm text-body flex items-center gap-sm
            ${returnToast === 'success' || returnToast === 'portal' ? 'bg-status-free/10 border-status-free/30 text-status-free' : 'bg-info/10 border-info/30 text-info'}`}
        >
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            {returnToast === 'cancel'
              ? <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              : <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            }
          </svg>
          {returnToast === 'success' ? t('return.success')
            : returnToast === 'cancel' ? t('return.cancel')
            : t('return.portalUpdated')}
          {finalizing && (
            <span className="text-caption text-text-muted ms-sm">{t('return.finalizing')}</span>
          )}
        </div>
      )}

      {/* Checkout error */}
      {checkoutError && (
        <div role="alert" className="rounded-md border bg-danger/10 border-danger/30 px-md py-sm text-body text-danger">
          {checkoutError}
        </div>
      )}

      {/* Paywall banner (always-recoverable — billing page itself is never gated) */}
      {paywallVariant && (
        <PaywallBanner
          variant={paywallVariant.variant}
          daysLeft={paywallVariant.daysLeft}
          graceUntilIso={entitlement.graceUntil}
          planName={currentPlanInfo?.nameKey}
          isOwner={isOwner}
          onAction={
            paywallVariant.variant === 'trialEnding' ? () => void handleSubscribe()
            : paywallVariant.variant === 'pastDueGrace' ? () => void handleManageBilling()
            : paywallVariant.variant === 'readOnly' ? () => void handleSubscribe()
            : undefined
          }
          actionPending={checkoutPending || portalPending}
        />
      )}

      {/* Current plan card */}
      <CurrentPlanCard
        plan={currentPlanInfo ?? {
          key: sub?.plan ?? 'trial',
          nameKey: sub?.plan ?? 'trial',
          amountMinor: null,
          currency: null,
          interval: null,
        }}
        status={entitlement.status}
        trialEndIso={sub?.trial_end}
        currentPeriodEndIso={sub?.current_period_end}
        cancelAtPeriodEnd={sub?.cancel_at_period_end ?? false}
        comped={sub?.comped ?? false}
        nowIso={nowIso}
        graceUntil={entitlement.graceUntil}
        graceElapsed={graceElapsed}
        trialDaysLeft={trialDaysLeft}
        onManageBilling={() => void handleManageBilling()}
        managePending={portalPending}
        hasStripeCustomer={!!sub?.stripe_customer_id}
        loading={loading}
        finalizing={finalizing}
      />

      {/* Usage meters */}
      <UsageMeterGroup
        meters={meters}
        loading={loading}
        error={usageError}
        onRetry={() => void loadUsage()}
      />

      {/* Plan comparison */}
      <div id="plans" className="flex flex-col gap-md">
        <h2 className="text-h2 text-text font-bold">{t('plan.upgrade')}</h2>
        <PlanComparison
          plans={allPlanInfos}
          currentPlanKey={sub?.plan ?? 'trial'}
          onUpgrade={(planKey) => void handleUpgrade(planKey)}
          onManage={() => void handleManageBilling()}
          pendingPlanKey={pendingPlanKey}
          loading={loading}
        />
      </div>
    </div>
  );
}

export default function BillingPage() {
  return (
    <DashboardPageShell>
      <BillingContent />
    </DashboardPageShell>
  );
}
