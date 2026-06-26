'use client';

/**
 * ReactivateTenantDialog — lighter ConfirmDialog with reason field (AC 19, design §5.3).
 *
 * The reactivate-tenant edge function requires reason >= 5 chars.
 * The dialog pre-fills a sensible default so the admin can confirm quickly,
 * but still validates >= 5 chars if the field is changed.
 *
 * onConfirm passes { reason } so the caller sends it to the edge function.
 */

import { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { TextField } from '@/components/ui/TextField';
import { Button } from '@/components/ui/Button';

interface ReactivateTenantDialogProps {
  open: boolean;
  tenant: { id: string; name: string };
  submitting?: boolean;
  error?: string | null;
  onConfirm: (payload: { reason: string }) => void;
  onCancel: () => void;
}

export function ReactivateTenantDialog({
  open,
  tenant,
  submitting = false,
  error,
  onConfirm,
  onCancel,
}: ReactivateTenantDialogProps) {
  const t = useTranslations('admin.reactivate');
  const tAction = useTranslations('action');

  // Pre-fill with the localized default so the admin can confirm in one click
  const defaultReason = t('reasonDefault');
  const [reason, setReason] = useState(defaultReason);
  const [reasonError, setReasonError] = useState<string | null>(null);

  const validate = useCallback(() => {
    if (reason.trim().length < 5) {
      setReasonError(t('validation.reasonTooShort'));
      return false;
    }
    setReasonError(null);
    return true;
  }, [reason, t]);

  const handleConfirm = useCallback(() => {
    if (!validate()) return;
    onConfirm({ reason: reason.trim() });
  }, [validate, reason, onConfirm]);

  const handleClose = useCallback(() => {
    setReason(defaultReason);
    setReasonError(null);
    onCancel();
  }, [defaultReason, onCancel]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="reactivate-title"
      className="fixed inset-0 z-[10000] flex items-center justify-center p-xl"
    >
      <div className="absolute inset-0 bg-scrim" aria-hidden="true" onClick={handleClose} />

      <div className="relative z-10 bg-surface rounded-md shadow-e3 p-2xl max-w-md w-full border border-border flex flex-col gap-lg">
        {/* Title */}
        <div className="flex items-center gap-sm">
          <span className="flex-shrink-0 w-8 h-8 rounded-xs bg-status-free/15 flex items-center justify-center">
            <svg
              aria-hidden="true"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="text-status-free"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </span>
          <h2 id="reactivate-title" className="text-h3 text-text font-semibold">
            {t('title')}
          </h2>
        </div>

        {/* Body */}
        <p className="text-body text-text-muted">
          {t('body')}
          {tenant.name && (
            <> — <bdi className="font-medium text-text">{tenant.name}</bdi></>
          )}
        </p>

        {/* Reason field (required by edge function — pre-filled with default) */}
        <TextField
          label={t('reason')}
          helper={t('reasonHelper')}
          required
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          onBlur={() => {
            if (reason.trim().length < 5) setReasonError(t('validation.reasonTooShort'));
            else setReasonError(null);
          }}
          error={reasonError ?? undefined}
          disabled={submitting}
        />

        {/* Server error */}
        {error && (
          <p role="alert" className="text-caption text-danger bg-danger/10 rounded-xs px-sm py-xs">
            {error}
          </p>
        )}

        {/* Actions */}
        <div className="flex items-center gap-sm justify-end">
          <Button variant="ghost" size="md" onClick={handleClose} disabled={submitting}>
            {tAction('cancel')}
          </Button>
          <Button variant="primary" size="md" onClick={handleConfirm} loading={submitting}>
            {t('submit')}
          </Button>
        </div>
      </div>
    </div>
  );
}
