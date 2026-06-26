'use client';

/**
 * ImpersonationEndDialog — confirm before ending active impersonation (AC 26, design §7.3).
 *
 * On confirm: ends the session, writes the impersonation.stop audit row,
 * reverts claim to the super-admin's own context (refreshSession).
 * On error: banner STAYS (fail-safe — never leave the operator silently still-impersonating).
 */

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';

interface ImpersonationEndDialogProps {
  open: boolean;
  tenantName: string;
  submitting?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ImpersonationEndDialog({
  open,
  tenantName,
  submitting = false,
  error,
  onConfirm,
  onCancel,
}: ImpersonationEndDialogProps) {
  const tEnd = useTranslations('admin.impersonate.end');
  const tAction = useTranslations('action');

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="imp-end-title"
      className="fixed inset-0 z-[10000] flex items-center justify-center p-xl"
    >
      {/* Scrim */}
      <div
        className="absolute inset-0 bg-scrim"
        aria-hidden="true"
        onClick={onCancel}
      />

      {/* Dialog panel */}
      <div className="relative z-10 bg-surface rounded-md shadow-e3 p-2xl max-w-md w-full border border-border flex flex-col gap-lg">
        {/* Title */}
        <div className="flex items-center gap-sm">
          <span className="flex-shrink-0 w-8 h-8 rounded-xs bg-impersonation/15 flex items-center justify-center">
            <svg
              aria-hidden="true"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#8B5CF6"
              strokeWidth="1.5"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
          </span>
          <h2 id="imp-end-title" className="text-h3 text-text font-semibold">
            {tEnd('title')}
          </h2>
        </div>

        {/* Body */}
        <p className="text-body text-text-muted">
          {tEnd('body')}
          {tenantName && (
            <> — <bdi className="font-medium text-text">{tenantName}</bdi></>
          )}
        </p>

        {/* Error (banner stays on error — AC design §7.4) */}
        {error && (
          <p role="alert" className="text-caption text-danger bg-danger/10 rounded-xs px-sm py-xs">
            {error}
          </p>
        )}

        {/* Actions: cancel (start) · confirm (end) */}
        <div className="flex items-center gap-sm justify-end">
          <Button variant="ghost" size="md" onClick={onCancel} disabled={submitting}>
            {tAction('cancel')}
          </Button>
          <Button
            variant="danger"
            size="md"
            onClick={onConfirm}
            loading={submitting}
            className="bg-impersonation hover:bg-[#7C3AED]"
          >
            {tEnd('submit')}
          </Button>
        </div>
      </div>
    </div>
  );
}
