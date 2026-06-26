'use client';

/**
 * SuspendTenantDialog — high-friction destructive ConfirmDialog (AC 18, 20, design §5.2).
 *
 * High-friction: reason (≥5 chars) + type-to-confirm (tenant name must match).
 * Body states the immediate-effect expectation (AC 18: no token-expiry wait).
 * Submit uses danger fill and is spatially separated from cancel.
 */

import { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { TextField } from '@/components/ui/TextField';
import { Button } from '@/components/ui/Button';

interface SuspendTenantDialogProps {
  open: boolean;
  tenant: { id: string; name: string };
  submitting?: boolean;
  error?: string | null;
  onConfirm: (payload: { reason: string }) => void;
  onCancel: () => void;
}

export function SuspendTenantDialog({
  open,
  tenant,
  submitting = false,
  error,
  onConfirm,
  onCancel,
}: SuspendTenantDialogProps) {
  const t = useTranslations('admin.suspend');
  const tAction = useTranslations('action');

  const [reason, setReason] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);

  const validate = useCallback(() => {
    let ok = true;
    if (reason.trim().length < 5) {
      setReasonError(t('validation.reasonRequired'));
      ok = false;
    } else {
      setReasonError(null);
    }
    if (confirmName.trim() !== tenant.name.trim()) {
      setNameError(t('validation.nameMismatch'));
      ok = false;
    } else {
      setNameError(null);
    }
    return ok;
  }, [reason, confirmName, tenant.name, t]);

  const handleConfirm = useCallback(() => {
    if (!validate()) return;
    onConfirm({ reason: reason.trim() });
  }, [validate, reason, onConfirm]);

  const handleClose = useCallback(() => {
    setReason('');
    setConfirmName('');
    setReasonError(null);
    setNameError(null);
    onCancel();
  }, [onCancel]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="suspend-title"
      className="fixed inset-0 z-[10000] flex items-center justify-center p-xl"
    >
      <div className="absolute inset-0 bg-scrim" aria-hidden="true" onClick={handleClose} />

      <div className="relative z-10 bg-surface rounded-md shadow-e3 p-2xl max-w-lg w-full border border-danger/30 flex flex-col gap-lg">
        {/* Title */}
        <div className="flex items-center gap-sm">
          <span className="flex-shrink-0 w-8 h-8 rounded-xs bg-danger/15 flex items-center justify-center">
            <svg
              aria-hidden="true"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="text-danger"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.998L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.35 16.002c-.77 1.331.192 2.998 1.732 2.998z" />
            </svg>
          </span>
          <h2 id="suspend-title" className="text-h3 text-text font-semibold">
            {t('title')}
          </h2>
        </div>

        {/* Body: immediate-effect warning */}
        <p className="text-body text-text-muted">{t('body')}</p>

        {/* Reason */}
        <TextField
          label={t('reason')}
          helper={t('reasonHelper')}
          required
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          onBlur={() => {
            if (reason.trim().length < 5) setReasonError(t('validation.reasonRequired'));
            else setReasonError(null);
          }}
          error={reasonError ?? undefined}
          disabled={submitting}
        />

        {/* Type-to-confirm */}
        <div className="flex flex-col gap-xs">
          <p className="text-label text-text-muted">
            {t('confirmLabel')}:{' '}
            <span className="font-semibold text-text">
              <bdi>{tenant.name}</bdi>
            </span>
          </p>
          <TextField
            label={t('confirmLabel')}
            required
            value={confirmName}
            onChange={(e) => setConfirmName(e.target.value)}
            onBlur={() => {
              if (confirmName.trim() !== tenant.name.trim())
                setNameError(t('validation.nameMismatch'));
              else setNameError(null);
            }}
            error={nameError ?? undefined}
            disabled={submitting}
          />
        </div>

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
          <Button variant="danger" size="md" onClick={handleConfirm} loading={submitting}>
            {t('submit')}
          </Button>
        </div>
      </div>
    </div>
  );
}
