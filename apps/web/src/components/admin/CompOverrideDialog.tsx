'use client';

/**
 * CompOverrideDialog — super-admin plan grant/override (design §7.3, AC 34).
 *
 * Reason-gated (≥5 chars), audited, calls the set-tenant-plan edge function.
 * Not type-to-confirm (granting a plan is restorative), but is reason-gated.
 * On success: refetch + toast. On failure: inline error, form preserved.
 *
 * a11y: focus trapped; first invalid field focused on submit error; Esc/Cancel close.
 * RTL: labels align start; errors inline below field.
 * All strings via i18n.
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';

interface PlanOption {
  key: string;
  displayName: string;
}

interface CompOverrideDialogProps {
  open: boolean;
  tenant: { id: string; name: string };
  plans: PlanOption[];
  currentPlanKey: string;
  onConfirm: (payload: { planKey: string; reason: string }) => Promise<void>;
  submitting?: boolean;
  error?: string | null;
  onClose: () => void;
}

export function CompOverrideDialog({
  open,
  tenant,
  plans,
  currentPlanKey,
  onConfirm,
  submitting = false,
  error,
  onClose,
}: CompOverrideDialogProps) {
  const t = useTranslations('admin.subs.comp');
  const tAction = useTranslations('action');
  const dialogRef = useRef<HTMLDivElement>(null);
  const reasonRef = useRef<HTMLInputElement>(null);
  const planRef = useRef<HTMLSelectElement>(null);

  const [selectedPlan, setSelectedPlan] = useState(currentPlanKey);
  const [reason, setReason] = useState('');
  const [planError, setPlanError] = useState<string | null>(null);
  const [reasonError, setReasonError] = useState<string | null>(null);

  // Reset on open
  useEffect(() => {
    if (open) {
      setSelectedPlan(currentPlanKey);
      setReason('');
      setPlanError(null);
      setReasonError(null);
    }
  }, [open, currentPlanKey]);

  // Focus trap + Esc
  useEffect(() => {
    if (!open) return;
    const el = dialogRef.current;
    if (!el) return;
    const focusable = el.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length > 0) focusable[0]?.focus();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, submitting, onClose]);

  if (!open) return null;

  function validate(): boolean {
    let ok = true;
    if (!selectedPlan) {
      setPlanError(t('validation.planRequired'));
      planRef.current?.focus();
      ok = false;
    } else {
      setPlanError(null);
    }
    if (!reason || reason.trim().length < 5) {
      setReasonError(t('validation.reasonRequired'));
      if (ok) reasonRef.current?.focus();
      ok = false;
    } else {
      setReasonError(null);
    }
    return ok;
  }

  async function handleSubmit() {
    if (!validate()) return;
    await onConfirm({ planKey: selectedPlan, reason: reason.trim() });
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-xl"
      onClick={(e) => e.target === e.currentTarget && !submitting && onClose()}
    >
      <div className="absolute inset-0 bg-scrim" aria-hidden="true" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="comp-dialog-title"
        className="relative z-10 bg-surface rounded-md shadow-e3 p-2xl max-w-md w-full border border-border flex flex-col gap-lg"
      >
        {/* Title */}
        <h2 id="comp-dialog-title" className="text-h3 text-text font-semibold">
          {t('title', { tenant: tenant.name })}
        </h2>

        {/* Plan select */}
        <div className="flex flex-col gap-xs">
          <label htmlFor="comp-plan" className="text-label font-medium text-text">
            {t('plan')}
          </label>
          {planError && (
            <p className="text-caption text-danger" role="alert">{planError}</p>
          )}
          <select
            id="comp-plan"
            ref={planRef}
            value={selectedPlan}
            onChange={(e) => {
              setSelectedPlan(e.target.value);
              setPlanError(null);
            }}
            disabled={submitting}
            className="rounded-sm border border-border bg-surface-3 text-text px-sm py-xs text-body h-[52px] w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            {plans.map((p) => (
              <option key={p.key} value={p.key}>{p.displayName}</option>
            ))}
          </select>
          <p className="text-caption text-text-muted">{t('planHelper')}</p>
        </div>

        {/* Reason */}
        <div className="flex flex-col gap-xs">
          <label htmlFor="comp-reason" className="text-label font-medium text-text">
            {t('reason')}
          </label>
          <div className="flex flex-col gap-2xs">

            <input
              id="comp-reason"
              ref={reasonRef}
              type="text"
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                if (e.target.value.trim().length >= 5) setReasonError(null);
              }}
              onBlur={() => {
                if (reason.trim().length < 5) setReasonError(t('validation.reasonRequired'));
              }}
              disabled={submitting}
              placeholder={t('reasonHelper')}
              className="rounded-sm border border-border bg-surface-3 text-text px-sm py-xs text-body h-[52px] w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60"
              aria-describedby={reasonError ? 'comp-reason-error' : undefined}
            />
            {reasonError && (
              <p id="comp-reason-error" className="text-caption text-danger" role="alert">{reasonError}</p>
            )}
          </div>
        </div>

        {/* Consequence line */}
        <p className="text-caption text-text-muted bg-surface-2 rounded-xs px-sm py-xs border border-border">
          {t('consequence')}
        </p>

        {/* Server error */}
        {error && (
          <p className="text-caption text-danger" role="alert">{error}</p>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-sm">
          <Button variant="secondary" size="md" onClick={onClose} disabled={submitting}>
            {tAction('cancel')}
          </Button>
          <Button variant="primary" size="md" onClick={() => void handleSubmit()} loading={submitting}>
            {t('submit')}
          </Button>
        </div>
      </div>
    </div>
  );
}
