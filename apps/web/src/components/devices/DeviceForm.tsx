'use client';

/**
 * DeviceForm — create / edit a device (owner-only write).
 *
 * HARD RULES:
 *  - No money math here (devices have no price fields).
 *  - All strings from i18n — no hardcoded user-facing text.
 *  - RTL: logical spacing (start/end), labels align to start.
 *  - Validation: name required; sort_order integer ≥ 0; device_type from allowed set.
 *  - Client-generated UUID for idempotent upsert (CLAUDE.md §2.8).
 *  - tenant_id from JWT claim; RLS WITH CHECK validates server-side (ADR-0003 / CLAUDE.md §5).
 *  - branch_id from prop (selected branch context, not from user input as security boundary).
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { uuidv4 } from '@ps/core';
import type { Device } from '@ps/core';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { getBrowserClient } from '@/lib/supabase/client';
import { useAuth } from '@/lib/auth/AuthContext';

// ─── Types ────────────────────────────────────────────────────────────────────

type FormErrors = Partial<Record<string, string>>;

interface DeviceFormProps {
  /** Existing device to edit; undefined = create new. */
  initial?: Device;
  /** Branch this device belongs to (required for create). */
  branchId: string;
  onSuccess: (device: Device) => void;
  onCancel: () => void;
}

// ─── Allowed device types ─────────────────────────────────────────────────────

/** Canonical device_type values — match the values used in rate_rules and the seed. */
const DEVICE_TYPES = ['PS4', 'PS5', 'VIP'] as const;

/**
 * Display labels for device types are the same in Arabic (model names).
 * Keeping this as a direct map avoids template-literal key lookups in t().
 */
const DEVICE_TYPE_LABELS: Record<string, string> = {
  PS4: 'PS4',
  PS5: 'PS5',
  VIP: 'VIP',
};

// ─── Form state ───────────────────────────────────────────────────────────────

interface FormState {
  name: string;
  device_type: string;
  sort_order: string;
  is_active: boolean;
}

function toFormState(device?: Device): FormState {
  if (!device) {
    return {
      name: '',
      device_type: 'PS5',
      sort_order: '1',
      is_active: true,
    };
  }
  return {
    name: device.name,
    device_type: device.device_type,
    sort_order: String(device.sort_order),
    is_active: device.is_active,
  };
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validate(
  f: FormState,
  t: ReturnType<typeof useTranslations>,
): FormErrors {
  const errors: FormErrors = {};

  if (!f.name.trim()) {
    errors['name'] = t('devices.validation.nameRequired');
  }

  const order = parseInt(f.sort_order.trim(), 10);
  if (isNaN(order) || order < 0) {
    errors['sort_order'] = t('devices.validation.sortOrderInvalid');
  }

  return errors;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function DeviceForm({ initial, branchId, onSuccess, onCancel }: DeviceFormProps) {
  const t = useTranslations();
  const { claim } = useAuth();
  const [form, setForm] = useState<FormState>(toFormState(initial));
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: undefined }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const errs = validate(form, t);
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      // Focus the first error field
      const firstKey = Object.keys(errs)[0];
      if (firstKey) {
        const el = document.getElementById(firstKey);
        if (el) (el as HTMLElement).focus();
      }
      return;
    }

    setSaving(true);
    setSaveError(null);

    try {
      const supabase = getBrowserClient();

      // tenant_id comes from the signed JWT claim (app_metadata.tenant_id).
      // The client sends its own claim value; RLS WITH CHECK validates server-side.
      // An attacker sending a different tenant_id is rejected by the policy.
      // (CLAUDE.md §5, ADR-0003 — never bypass RLS or scope with service role.)
      const tenantId = claim?.tenant_id;
      if (!tenantId) throw new Error('Not authenticated');

      const id = initial?.id ?? uuidv4();
      const now = new Date().toISOString();

      const row = {
        id,
        // tenant_id from JWT claim: RLS WITH CHECK validates server-side.
        tenant_id: tenantId,
        branch_id: branchId,
        name: form.name.trim(),
        device_type: form.device_type.trim(),
        sort_order: parseInt(form.sort_order.trim(), 10),
        // Preserve existing status on edit; default 'free' on create.
        // Never override to 'busy' — that is set exclusively by session lifecycle.
        status: initial?.status ?? 'free',
        is_active: form.is_active,
        updated_at: now,
        ...(initial == null ? { created_at: now } : {}),
      };

      // Upsert (idempotent — client-generated UUID, CLAUDE.md §2.8)
      const { data, error } = await supabase
        .from('devices')
        .upsert(row, { onConflict: 'id' })
        .select()
        .single();

      if (error) throw error;

      onSuccess(data as Device);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} noValidate className="space-y-lg">
      {/* Name — required */}
      <TextField
        id="name"
        label={t('devices.field.name')}
        value={form.name}
        onChange={(e) => set('name', e.target.value)}
        helper={t('devices.field.nameHelper')}
        required
        error={errors['name']}
        autoComplete="off"
      />

      {/* Device type — select */}
      <div className="flex flex-col gap-xs">
        <label
          htmlFor="device_type"
          className="text-label font-medium text-text-muted text-start"
        >
          {t('devices.field.deviceType')}
        </label>
        <select
          id="device_type"
          value={form.device_type}
          onChange={(e) => set('device_type', e.target.value)}
          className="w-full h-[52px] px-md rounded-sm text-body text-text bg-surface-3 border border-border
            transition-colors duration-fast focus:outline-none focus:ring-2 focus:ring-primary
            focus:border-border-strong"
        >
          {DEVICE_TYPES.map((dt) => (
            <option key={dt} value={dt}>
              {DEVICE_TYPE_LABELS[dt] ?? dt}
            </option>
          ))}
        </select>
      </div>

      {/* Sort order — integer */}
      <TextField
        id="sort_order"
        label={t('devices.field.sortOrder')}
        type="number"
        inputMode="numeric"
        min="0"
        step="1"
        value={form.sort_order}
        onChange={(e) => set('sort_order', e.target.value)}
        helper={t('devices.field.sortOrderHelper')}
        error={errors['sort_order']}
      />

      {/* is_active toggle */}
      <div className="flex flex-col gap-xs">
        <div className="flex items-center gap-sm">
          <button
            id="is-active-toggle"
            type="button"
            role="switch"
            aria-checked={form.is_active}
            onClick={() => set('is_active', !form.is_active)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary
              ${form.is_active ? 'bg-primary' : 'bg-surface-3 border border-border'}`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-fast
                ${form.is_active ? 'translate-x-6' : 'translate-x-1'}`}
              aria-hidden="true"
            />
          </button>
          <label
            htmlFor="is-active-toggle"
            className="text-label font-medium text-text-muted cursor-pointer select-none"
          >
            {t('devices.field.isActive')}
          </label>
        </div>
      </div>

      {/* Save error */}
      {saveError && (
        <p role="alert" aria-live="assertive" className="text-caption text-danger text-start">
          {saveError}
        </p>
      )}

      {/* Actions */}
      <div className="flex gap-md justify-end pt-sm">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={saving}>
          {t('devices.action.cancel')}
        </Button>
        <Button type="submit" variant="primary" loading={saving}>
          {t('devices.action.save')}
        </Button>
      </div>
    </form>
  );
}
