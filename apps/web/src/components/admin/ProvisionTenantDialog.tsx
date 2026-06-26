'use client';

/**
 * ProvisionTenantDialog — two-step wizard to create a tenant + first owner (AC 16, 17, 20).
 *
 * Step 1: Business name (→ tenant_name).
 * Step 2: Owner email (required) + owner full name (optional).
 *
 * Payload matches the locked edge-function contract:
 *   { tenant_name: string, owner_email: string, owner_full_name?: string }
 *
 * Response may include { tenant_id, owner_user_id, owner_temp_password? }.
 * If owner_temp_password is present the parent surfaces it to the super-admin.
 */

import { useState, useCallback, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { TextField } from '@/components/ui/TextField';
import { Button } from '@/components/ui/Button';

/** Locked edge-function contract for provision-tenant. */
export interface ProvisionPayload {
  tenant_name: string;
  owner_email: string;
  owner_full_name?: string;
}

interface ProvisionTenantDialogProps {
  open: boolean;
  submitting?: boolean;
  error?: string | null;
  onSubmit: (payload: ProvisionPayload) => void;
  onClose: () => void;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ProvisionTenantDialog({
  open,
  submitting = false,
  error,
  onSubmit,
  onClose,
}: ProvisionTenantDialogProps) {
  const t = useTranslations('admin.provision');
  const tAction = useTranslations('action');

  const [step, setStep] = useState<1 | 2>(1);
  const [tenantName, setTenantName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [ownerFullName, setOwnerFullName] = useState('');

  // Per-field errors
  const [nameError, setNameError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);

  // Reset all form state when the dialog re-opens (fixes stale state between opens).
  // handleClose already resets on cancel; this covers successful-submit re-opens
  // where the parent closes via onClose() directly without calling handleClose.
  useEffect(() => {
    if (open) {
      setStep(1);
      setTenantName('');
      setOwnerEmail('');
      setOwnerFullName('');
      setNameError(null);
      setEmailError(null);
    }
  }, [open]);

  const validateStep1 = useCallback(() => {
    if (!tenantName.trim()) {
      setNameError(t('validation.nameRequired'));
      return false;
    }
    setNameError(null);
    return true;
  }, [tenantName, t]);

  const validateStep2 = useCallback(() => {
    if (!ownerEmail.trim()) {
      setEmailError(t('validation.emailRequired'));
      return false;
    }
    if (!EMAIL_RE.test(ownerEmail)) {
      setEmailError(t('validation.emailInvalid'));
      return false;
    }
    setEmailError(null);
    return true;
  }, [ownerEmail, t]);

  const handleNext = useCallback(() => {
    if (!validateStep1()) return;
    setStep(2);
  }, [validateStep1]);

  const handleSubmit = useCallback(() => {
    if (!validateStep2()) return;
    const payload: ProvisionPayload = {
      tenant_name: tenantName.trim(),
      owner_email: ownerEmail.trim().toLowerCase(),
    };
    if (ownerFullName.trim()) {
      payload.owner_full_name = ownerFullName.trim();
    }
    onSubmit(payload);
  }, [validateStep2, tenantName, ownerEmail, ownerFullName, onSubmit]);

  const handleClose = useCallback(() => {
    setStep(1);
    setTenantName('');
    setOwnerEmail('');
    setOwnerFullName('');
    setNameError(null);
    setEmailError(null);
    onClose();
  }, [onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="prov-title"
      className="fixed inset-0 z-[10000] flex items-center justify-center p-xl"
    >
      <div className="absolute inset-0 bg-scrim" aria-hidden="true" onClick={handleClose} />

      <div className="relative z-10 bg-surface rounded-md shadow-e3 p-2xl max-w-lg w-full border border-border flex flex-col gap-lg">
        {/* Title + step indicator */}
        <div className="flex items-center justify-between">
          <h2 id="prov-title" className="text-h3 text-text font-semibold">{t('title')}</h2>
          <div className="flex items-center gap-xs">
            {([1, 2] as const).map((s) => (
              <span
                key={s}
                className={`w-2 h-2 rounded-full transition-colors ${
                  s === step ? 'bg-primary' : 'bg-surface-3'
                }`}
                aria-hidden="true"
              />
            ))}
          </div>
        </div>

        {/* Step label */}
        <p className="text-caption text-text-faint">
          {step === 1 ? t('step.business') : t('step.owner')}
        </p>

        {/* ── Step 1: Business name ─────────────────────────────────────── */}
        {step === 1 && (
          <div className="flex flex-col gap-md">
            <TextField
              label={t('field.name')}
              required
              value={tenantName}
              onChange={(e) => setTenantName(e.target.value)}
              onBlur={() => {
                if (!tenantName.trim()) setNameError(t('validation.nameRequired'));
                else setNameError(null);
              }}
              error={nameError ?? undefined}
              disabled={submitting}
            />
            <p className="text-caption text-text-faint">{t('field.region')}</p>
          </div>
        )}

        {/* ── Step 2: Owner email + optional full name ─────────────────── */}
        {step === 2 && (
          <div className="flex flex-col gap-md">
            <TextField
              label={t('field.ownerEmail')}
              required
              type="email"
              autoComplete="email"
              /* LTR-isolated: email is a Latin token */
              dir="ltr"
              value={ownerEmail}
              onChange={(e) => setOwnerEmail(e.target.value)}
              onBlur={() => {
                if (!ownerEmail.trim()) setEmailError(t('validation.emailRequired'));
                else if (!EMAIL_RE.test(ownerEmail)) setEmailError(t('validation.emailInvalid'));
                else setEmailError(null);
              }}
              error={emailError ?? undefined}
              disabled={submitting}
            />
            <TextField
              label={t('field.ownerFullName')}
              helper={t('field.ownerFullNameHelper')}
              value={ownerFullName}
              onChange={(e) => setOwnerFullName(e.target.value)}
              disabled={submitting}
            />
            <p className="text-caption text-text-faint bg-surface-2 rounded-xs px-sm py-xs">
              {t('summary')}
            </p>
          </div>
        )}

        {/* Server error */}
        {error && (
          <p role="alert" className="text-caption text-danger bg-danger/10 rounded-xs px-sm py-xs">
            {error}
          </p>
        )}

        {/* Actions */}
        <div className="flex items-center gap-sm justify-between">
          <div>
            {step === 2 && (
              <Button variant="ghost" size="md" onClick={() => setStep(1)} disabled={submitting}>
                {t('back')}
              </Button>
            )}
          </div>
          <div className="flex gap-sm">
            <Button variant="secondary" size="md" onClick={handleClose} disabled={submitting}>
              {tAction('cancel')}
            </Button>
            {step === 1 && (
              <Button variant="primary" size="md" onClick={handleNext} disabled={submitting}>
                {t('next')}
              </Button>
            )}
            {step === 2 && (
              <Button variant="primary" size="md" onClick={handleSubmit} loading={submitting}>
                {t('submit')}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
