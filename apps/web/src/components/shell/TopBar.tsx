'use client';

/**
 * TopBar — AppScaffold header for web (design-system §9.13)
 * Tenant name (start) · BranchSelect (center) · Sign-out (end).
 * RTL layout: logical start/end, never hardcoded left/right.
 */
import { useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth/AuthContext';
import { BranchSelect } from '@/components/devices/BranchSelect';
import { Button } from '@/components/ui/Button';
import type { Branch } from '@ps/core';

interface TopBarProps {
  tenantName?: string;
  branches: Branch[];
  activeBranchId: string | null;
  onBranchSelect: (id: string | null) => void;
  branchesLoading?: boolean;
}

export function TopBar({
  tenantName,
  branches,
  activeBranchId,
  onBranchSelect,
  branchesLoading = false,
}: TopBarProps) {
  const t = useTranslations();
  const { signOut } = useAuth();

  return (
    <header
      role="banner"
      className="sticky top-0 z-40 bg-surface border-b border-border px-xl py-sm flex items-center gap-md shadow-e1"
    >
      {/* Start: app name + tenant */}
      <div className="flex items-center gap-sm flex-1 min-w-0">
        <span className="text-h3 text-text font-bold truncate">
          {tenantName ?? t('app.name')}
        </span>
      </div>

      {/* Center: branch selector */}
      <div className="flex-shrink-0">
        <BranchSelect
          branches={branches}
          activeId={activeBranchId}
          onSelect={onBranchSelect}
          loading={branchesLoading}
        />
      </div>

      {/* End: sign out */}
      <div className="flex items-center flex-shrink-0">
        <Button
          variant="ghost"
          size="md"
          onClick={() => void signOut()}
          aria-label={t('action.signOut')}
          className="h-9 px-sm text-text-muted"
        >
          <svg
            aria-hidden="true"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
            />
          </svg>
          <span className="hidden sm:inline">{t('auth.signOut')}</span>
        </Button>
      </div>
    </header>
  );
}
