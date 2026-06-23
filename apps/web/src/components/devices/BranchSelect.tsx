'use client';

/**
 * BranchSelect — web form of BranchPicker (design-system §9.12)
 * A <select> in the topbar for branch switching within the active tenant.
 * The tenant is always from the signed JWT claim — never client-supplied.
 */
import { useTranslations } from 'next-intl';
import type { Branch } from '@ps/core';

interface BranchSelectProps {
  branches: Branch[];
  activeId: string | null;
  onSelect: (branchId: string) => void;
  loading?: boolean;
}

export function BranchSelect({
  branches,
  activeId,
  onSelect,
  loading = false,
}: BranchSelectProps) {
  const t = useTranslations('branch');

  if (loading) {
    return (
      <div className="h-[36px] w-40 rounded-xs bg-surface-3 animate-pulse motion-reduce:animate-none" />
    );
  }

  return (
    <div className="flex items-center gap-xs">
      <label htmlFor="branch-select" className="text-label text-text-muted sr-only">
        {t('label')}
      </label>
      <select
        id="branch-select"
        value={activeId ?? ''}
        onChange={(e) => onSelect(e.target.value)}
        aria-label={t('label')}
        className="h-[36px] px-sm pe-8 rounded-xs bg-surface-3 border border-border text-label text-text focus:outline-none focus:ring-2 focus:ring-primary focus:border-border-strong transition-colors cursor-pointer appearance-none"
      >
        {!activeId && (
          <option value="" disabled>
            {t('choose.title')}
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
