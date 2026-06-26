'use client';

/**
 * ImpersonationStartDialog — high-friction entry to impersonation (AC 21–23, design §7.1).
 *
 * Never a one-click jump: requires reason + TTL selection; shows consequences.
 * The confirm button uses the impersonation violet fill — even the confirm signals the mode.
 *
 * On confirm:
 *  1. Calls the impersonate-tenant edge function (server mints the session).
 *  2. Client calls refreshSession() so the hook re-stamps claims (AC 21, 29).
 *  3. Routes into the tenant context. No service-role key in the browser (AC 29).
 *
 * Suspended-tenant guard: the target's status is checked before render (AC 22).
 * TTL cap: presets are clamped to maxTtlSec from platform_settings (AC 23).
 */

import { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { toArabicDigits } from '@ps/core';
import { TextField } from '@/components/ui/TextField';
import { Button } from '@/components/ui/Button';

interface ImpersonationStartDialogProps {
  open: boolean;
  tenant: { id: string; name: string; status: string };
  /** Max TTL in seconds from platform_settings (default cap 3600). */
  maxTtlSec?: number;
  submitting?: boolean;
  error?: string | null;
  onConfirm: (payload: { reason: string; ttlSec: number }) => void;
  onCancel: () => void;
}

const PRESETS = [
  { key: 'd15', label_key: 'duration.d15', value: 15 * 60 },
  { key: 'd30', label_key: 'duration.d30', value: 30 * 60 },
  { key: 'd60', label_key: 'duration.d60', value: 60 * 60 },
];

export function ImpersonationStartDialog({
  open,
  tenant,
  maxTtlSec = 3600,
  submitting = false,
  error,
  onConfirm,
  onCancel,
}: ImpersonationStartDialogProps) {
  const t = useTranslations('admin.impersonate');
  const tAction = useTranslations('action');

  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [selectedTtl, setSelectedTtl] = useState(PRESETS[0]!.value);

  // Filter presets to those within maxTtlSec cap (AC 23)
  const availablePresets = PRESETS.filter((p) => p.value <= maxTtlSec);

  const validateReason = useCallback(() => {
    if (reason.trim().length < 5) {
      setReasonError(t('start.validation.reasonRequired'));
      return false;
    }
    setReasonError(null);
    return true;
  }, [reason, t]);

  const handleConfirm = useCallback(() => {
    if (!validateReason()) return;
    onConfirm({ reason: reason.trim(), ttlSec: selectedTtl });
  }, [validateReason, reason, selectedTtl, onConfirm]);

  if (!open) return null;

  const isSuspended = tenant.status === 'suspended';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="imp-start-title"
      className="fixed inset-0 z-[10000] flex items-center justify-center p-xl"
    >
      {/* Scrim */}
      <div className="absolute inset-0 bg-scrim" aria-hidden="true" onClick={onCancel} />

      {/* Dialog panel */}
      <div className="relative z-10 bg-surface rounded-md shadow-e3 p-2xl max-w-lg w-full border border-border flex flex-col gap-lg">
        {/* Title with violet shield icon */}
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
          <h2 id="imp-start-title" className="text-h3 text-text font-semibold">
            {t('start.title', { tenant: tenant.name })}
          </h2>
        </div>

        {/* Suspended guard (AC 22) */}
        {isSuspended && (
          <p
            role="alert"
            className="text-caption text-warning bg-warning/10 rounded-xs px-sm py-xs border border-warning/30"
          >
            {t('start.error.suspended')}
          </p>
        )}

        {/* Consequences — three clear lines (design §7.1) */}
        {!isSuspended && (
          <ul className="flex flex-col gap-xs">
            {(['consequence1', 'consequence2', 'consequence3'] as const).map((key) => (
              <li key={key} className="flex items-start gap-xs text-body text-text-muted">
                <span className="mt-1 flex-shrink-0 w-1.5 h-1.5 rounded-full bg-impersonation" aria-hidden="true" />
                {key === 'consequence2'
                  ? t('start.consequence2', {
                      duration: toArabicDigits(String(Math.floor(selectedTtl / 60))),
                    })
                  : t(`start.${key}`)}
              </li>
            ))}
          </ul>
        )}

        {/* Duration selector (AC 23: server clamps; dialog never offers above cap) */}
        {!isSuspended && (
          <div className="flex flex-col gap-xs">
            <p className="text-label font-medium text-text-muted">{t('start.duration')}</p>
            <div className="flex gap-xs">
              {availablePresets.map(({ key, label_key, value }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSelectedTtl(value)}
                  className={`flex-1 px-sm py-xs rounded-xs text-label font-medium border transition-colors duration-fast
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-impersonation
                    ${selectedTtl === value
                      ? 'bg-impersonation/15 border-impersonation text-impersonation'
                      : 'border-border text-text-muted hover:bg-surface-3'
                    }`}
                >
                  {t(label_key)}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Reason field (required) */}
        {!isSuspended && (
          <TextField
            label={t('start.reason')}
            helper={t('start.reasonHelper')}
            error={reasonError ?? undefined}
            required
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onBlur={validateReason}
            disabled={submitting}
          />
        )}

        {/* Server error */}
        {error && (
          <p role="alert" className="text-caption text-danger bg-danger/10 rounded-xs px-sm py-xs">
            {error}
          </p>
        )}

        {/* Actions */}
        <div className="flex items-center gap-sm justify-end">
          <Button variant="ghost" size="md" onClick={onCancel} disabled={submitting}>
            {tAction('cancel')}
          </Button>
          {!isSuspended && (
            <Button
              size="md"
              onClick={handleConfirm}
              loading={submitting}
              className="bg-impersonation hover:bg-[#7C3AED] text-white border-0"
            >
              {t('start.submit')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
