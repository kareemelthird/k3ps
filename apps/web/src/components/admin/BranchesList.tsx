'use client';

/**
 * BranchesList — read-only list of branches in tenant detail (design §4 item 3, AC 7).
 * Count must equal M (AC 7).
 */

import { useTranslations } from 'next-intl';
import { toArabicDigits } from '@ps/core';
import { Skeleton } from '@/components/ui/Skeleton';

export interface BranchItem {
  id: string;
  name: string;
  isActive: boolean;
}

interface BranchesListProps {
  branches: BranchItem[];
  loading?: boolean;
}

export function BranchesList({ branches, loading = false }: BranchesListProps) {
  const t = useTranslations('admin');

  return (
    <div className="bg-surface rounded-md border border-border p-xl flex flex-col gap-md">
      <div className="flex items-center gap-sm">
        <h2 className="text-h3 text-text font-semibold">{t('detail.branches.title')}</h2>
        {branches.length > 0 && (
          <span className="text-caption text-text-faint">
            {toArabicDigits(String(branches.length))}
          </span>
        )}
      </div>

      {loading && (
        <div className="flex flex-col gap-sm">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      )}

      {!loading && branches.length === 0 && (
        <p className="text-label text-text-muted">{t('detail.branches.empty')}</p>
      )}

      {!loading && branches.length > 0 && (
        <ul className="flex flex-col gap-xs">
          {branches.map((b) => (
            <li
              key={b.id}
              className="flex items-center gap-sm px-sm py-xs bg-surface-2 rounded-xs"
            >
              <span
                className={`w-2 h-2 rounded-full flex-shrink-0 ${b.isActive ? 'bg-status-free' : 'bg-status-maint'}`}
                aria-hidden="true"
              />
              <span className="text-label text-text">{b.name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
