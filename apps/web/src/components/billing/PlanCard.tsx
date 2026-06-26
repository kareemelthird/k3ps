'use client';

/**
 * PlanCard / PlanComparison — tier picker leading to Checkout (design §3.4, AC 26).
 *
 * - Each buyable plan renders as a card with name, price, limits, feature flags.
 * - The current tier shows "خطتك الحالية" ribbon + disabled CTA.
 * - Tiers above current → "الترقية" primary → calls create-checkout-session.
 * - Tiers below current (downgrade) → "إدارة عبر البوابة" secondary → Portal.
 * - The trial plan is never a buyable card.
 * - Plan price via formatMoneyMinor (platform currency axis, NOT formatEgp).
 * - RTL. Arabic-Indic numerals. a11y: focus ring, disabled state.
 */

import { useTranslations } from 'next-intl';
import { formatMoneyMinor, toArabicDigits } from '@ps/core';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { ErrorState } from '@/components/ui/ErrorState';

const PLAN_ORDER: Record<string, number> = { trial: 0, basic: 1, pro: 2 };

export interface PlanInfo {
  key: string;
  nameKey: string;
  amountMinor: number | null;
  currency: string;
  interval: string;
  maxBranches: number;
  maxDevices: number;
  maxStaff: number;
  features: Record<string, boolean>;
  sortOrder?: number;
}

type PlanRelation = 'current' | 'upgrade' | 'downgrade';

interface PlanCardProps {
  plan: PlanInfo;
  relation: PlanRelation;
  onUpgrade: (planKey: string) => void;
  onManage: () => void;
  pending?: boolean;
  recommended?: boolean;
}

function PlanLimitRow({ label, value }: { label: string; value: number }) {
  return (
    <li className="flex items-center gap-xs text-body text-text">
      <svg aria-hidden="true" className="w-4 h-4 text-status-free flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
      </svg>
      {`${label}: ${toArabicDigits(String(value))}`}
    </li>
  );
}

export function PlanCard({ plan, relation, onUpgrade, onManage, pending = false, recommended = false }: PlanCardProps) {
  const t = useTranslations('billing.plan');
  const tUsage = useTranslations('billing.usage');
  const isCurrent = relation === 'current';
  const isUpgrade = relation === 'upgrade';

  const displayName = (() => {
    if (plan.key === 'trial') return t('trial');
    if (plan.key === 'basic') return t('basic');
    if (plan.key === 'pro') return t('pro');
    return plan.nameKey;
  })();

  const hasAmount = plan.amountMinor != null && plan.amountMinor > 0;

  return (
    <div
      className={`bg-surface rounded-md border p-xl flex flex-col gap-md shadow-e0 relative
        ${recommended && !isCurrent ? 'border-primary' : 'border-border'}`}
    >
      {/* Recommended ribbon */}
      {recommended && !isCurrent && (
        <div className="absolute -top-3 start-1/2 -translate-x-1/2 rtl:translate-x-1/2">
          <span className="bg-primary text-on-primary text-caption font-semibold px-sm py-1 rounded-pill">
            {t('recommended')}
          </span>
        </div>
      )}

      {/* Current badge */}
      {isCurrent && (
        <div className="absolute -top-3 start-1/2 -translate-x-1/2 rtl:translate-x-1/2">
          <span className="bg-surface-3 text-text-muted text-caption font-semibold px-sm py-1 rounded-pill border border-border">
            {t('current')}
          </span>
        </div>
      )}

      {/* Plan name + price */}
      <div className="flex flex-col gap-2xs pt-xs">
        <h3 className="text-h3 text-text font-bold">{displayName}</h3>
        {hasAmount ? (
          <p className="text-label text-text-muted tabular-nums">
            {t('amountPerMonth', {
              amount: formatMoneyMinor(plan.amountMinor!, plan.currency, { arabicDigits: true }),
              currency: plan.currency.toUpperCase(),
            })}
          </p>
        ) : (
          <p className="text-label text-status-free font-medium">{t('freeTrial')}</p>
        )}
      </div>

      {/* Limits list */}
      <ul className="flex flex-col gap-xs">
        <PlanLimitRow label={tUsage('branches')} value={plan.maxBranches} />
        <PlanLimitRow label={tUsage('devices')} value={plan.maxDevices} />
        <PlanLimitRow label={tUsage('staff')} value={plan.maxStaff} />
      </ul>

      {/* CTA */}
      <div className="mt-auto pt-sm">
        {isCurrent ? (
          <Button variant="secondary" size="md" fullWidth disabled>
            {t('current')}
          </Button>
        ) : isUpgrade ? (
          <Button
            variant="primary"
            size="md"
            fullWidth
            onClick={() => onUpgrade(plan.key)}
            loading={pending}
          >
            {t('upgrade')}
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="md"
            fullWidth
            onClick={onManage}
            loading={pending}
          >
            {t('manageViaPortal')}
          </Button>
        )}
      </div>
    </div>
  );
}

// ── PlanComparison ──────────────────────────────────────────────────────────

interface PlanComparisonProps {
  plans: PlanInfo[];
  currentPlanKey: string;
  onUpgrade: (planKey: string) => void;
  onManage: () => void;
  pendingPlanKey?: string | null;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}

export function PlanComparison({
  plans,
  currentPlanKey,
  onUpgrade,
  onManage,
  pendingPlanKey,
  loading = false,
  error,
  onRetry,
}: PlanComparisonProps) {
  if (loading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-md">
        {[0, 1, 2].map((i) => (
          <div key={i} className="bg-surface rounded-md border border-border p-xl flex flex-col gap-md h-48">
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-[52px] w-full mt-auto" />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return <ErrorState message={error} onRetry={onRetry} />;
  }

  // Sort by plan order; filter out the trial plan from buyable cards
  const buyablePlans = plans
    .filter((p) => p.key !== 'trial')
    .sort((a, b) => (PLAN_ORDER[a.key] ?? a.sortOrder ?? 0) - (PLAN_ORDER[b.key] ?? b.sortOrder ?? 0));

  const currentOrder = PLAN_ORDER[currentPlanKey] ?? 0;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-md">
      {buyablePlans.map((plan) => {
        const planOrder = PLAN_ORDER[plan.key] ?? 0;
        let relation: PlanRelation;
        if (plan.key === currentPlanKey) {
          relation = 'current';
        } else if (planOrder > currentOrder) {
          relation = 'upgrade';
        } else {
          relation = 'downgrade';
        }

        // Mark the next tier up as recommended
        const isRecommended = planOrder === currentOrder + 1;

        return (
          <PlanCard
            key={plan.key}
            plan={plan}
            relation={relation}
            onUpgrade={onUpgrade}
            onManage={onManage}
            pending={pendingPlanKey === plan.key}
            recommended={isRecommended}
          />
        );
      })}
    </div>
  );
}
