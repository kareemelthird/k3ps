'use client';

/**
 * BranchSelect — web form of BranchPicker (design-system §9.12)
 * A <select> in the topbar for branch switching within the active tenant.
 * The tenant is always from the signed JWT claim — never client-supplied.
 *
 * Phase 6: added `allowAll` prop that prepends an "All branches" sentinel
 * (value='ALL') for the reports scope bar (design-system phase-6 §4.2).
 * Existing usages with `allowAll=false` (default) are unchanged.
 */
import { useTranslations } from 'next-intl';
import type { Branch } from '@ps/core';

interface BranchSelectProps {
  branches: Branch[];
  activeId: string | null;
  onSelect: (branchId: string | null) => void;
  loading?: boolean;
  /** When true, prepends an "All branches" option (value = null). Default false. */
  allowAll?: boolean;
}

export function BranchSelect({
  branches,
  activeId,
  onSelect,
  loading = false,
  allowAll = false,
}: BranchSelectProps) {
  const t = useTranslations();

  if (loading) {
    return (
      <div className="h-[36px] w-40 rounded-xs bg-surface-3 animate-pulse motion-reduce:animate-none" />
    );
  }

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    onSelect(val === 'ALL' ? null : val);
  };

  return (
    <div className="flex items-center gap-xs">
      <label htmlFor="branch-select" className="text-label text-text-muted sr-only">
        {t('branch.label')}
      </label>
      <select
        id="branch-select"
        value={activeId ?? (allowAll ? 'ALL' : '')}
        onChange={handleChange}
        aria-label={t('branch.label')}
        className="h-[36px] px-sm pe-8 rounded-xs bg-surface-3 border border-border text-label text-text focus:outline-none focus:ring-2 focus:ring-primary focus:border-border-strong transition-colors cursor-pointer appearance-none"
      >
        {allowAll && (
          <option value="ALL">{t('branch.all')}</option>
        )}
        {!allowAll && !activeId && (
          <option value="" disabled>
            {t('branch.choose.title')}
          </option>
        )}
        {branches.map((b) => (
          <option key={b.id} value={b.id} aria-current={b.id === activeId ? 'true' : undefined}>
            {b.name}
          </option>
        ))}
      </select>
    </div>
  );
}
