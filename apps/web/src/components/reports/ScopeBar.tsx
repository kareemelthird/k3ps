'use client';

/**
 * ScopeBar — scope controls for the reports page (design §4).
 * Combines BusinessDayRangePicker + BranchSelect + the aria-live range header.
 * Every change triggers re-query in the parent. All strings via i18n. RTL layout.
 */

import { useTranslations } from 'next-intl';
import { toArabicDigits, DEFAULT_CUTOVER_HOUR } from '@ps/core';
import { BranchSelect } from '@/components/devices/BranchSelect';
import { BusinessDayRangePicker } from './BusinessDayRangePicker';
import type { Branch } from '@ps/core';
import type { Scope } from './types';

/** Format a YYYY-MM-DD key as a short Arabic date "١٢ يونيو" */
function formatDateKeyAr(key: string): string {
  const d = new Date(`${key}T00:00:00Z`);
  return toArabicDigits(
    new Intl.DateTimeFormat('ar-EG', { day: 'numeric', month: 'long' }).format(d),
  );
}

interface ScopeBarProps {
  scope: Scope;
  branches: Branch[];
  cutoverHour?: number;
  onScopeChange: (next: Scope) => void;
  loading?: boolean;
}

export function ScopeBar({
  scope,
  branches,
  cutoverHour = DEFAULT_CUTOVER_HOUR,
  onScopeChange,
  loading = false,
}: ScopeBarProps) {
  const t = useTranslations();

  const activeBranch = scope.branchId
    ? (branches.find((b) => b.id === scope.branchId)?.name ?? scope.branchId)
    : t('branch.all');

  const scopeHeaderText = t('range.scopeHeader', {
    preset: t(`range.preset.${scope.preset}`),
    branch: activeBranch,
    from: formatDateKeyAr(scope.fromKey),
    to: formatDateKeyAr(scope.toKey),
  });

  return (
    <div className="space-y-xs">
      {/* Controls row */}
      <div className="flex flex-wrap items-center gap-sm">
        {/* Date-range picker */}
        <BusinessDayRangePicker
          value={scope}
          cutoverHour={cutoverHour}
          onChange={(next) =>
            onScopeChange({ ...scope, ...next })
          }
          disabled={loading}
        />

        {/* Branch filter — "All branches" sentinel = null */}
        {branches.length > 0 && (
          <BranchSelect
            branches={branches}
            activeId={scope.branchId}
            onSelect={(branchId) => onScopeChange({ ...scope, branchId })}
            allowAll
            loading={false}
          />
        )}
      </div>

      {/* Range + scope header — announced by screen reader on change (AC 13) */}
      <p
        aria-live="polite"
        aria-atomic="true"
        className="text-caption text-text-faint"
      >
        {scopeHeaderText}
      </p>
    </div>
  );
}
