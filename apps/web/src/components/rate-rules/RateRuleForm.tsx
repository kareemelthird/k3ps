'use client';

/**
 * RateRuleForm — create / edit a rate rule (owner-only write).
 *
 * HARD RULES:
 *  - Money entered in EGP, converted to integer piastres via @ps/core egpToPiastres.
 *  - Rendered back via formatEgp. Never stores or computes floats.
 *  - All strings from i18n — no hardcoded user-facing text.
 *  - RTL: logical spacing (start/end), labels align to start.
 *  - Validation per AC 28 (spec §F): required fields per billing_mode,
 *    time_start/time_end both-or-none, non-negative integers.
 *  - Client-generated UUID for idempotent upsert (CLAUDE.md §2.8).
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { egpToPiastres, piastresToEgp, uuidv4 } from '@ps/core';
import type { RateRule, BillingMode, PlayModeRule, DayTypeRule } from '@ps/core';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { getBrowserClient } from '@/lib/supabase/client';

// ─── Types ────────────────────────────────────────────────────────────────────

type FormErrors = Partial<Record<string, string>>;

interface RateRuleFormProps {
  /** Existing rule to edit; undefined = create new. */
  initial?: RateRule;
  onSuccess: (rule: RateRule) => void;
  onCancel: () => void;
}

// ─── Helper: EGP display ↔ piastres storage ──────────────────────────────────

/** Piastres → EGP display string (never raw piastres in the UI). */
function toEgpStr(piastres: number | null | undefined): string {
  if (piastres == null) return '';
  return String(piastresToEgp(piastres));
}

/** EGP string → integer piastres. Returns null if blank, NaN → null. */
function fromEgpStr(s: string): number | null {
  if (s.trim() === '') return null;
  const egp = parseFloat(s);
  if (isNaN(egp)) return null;
  return egpToPiastres(egp);
}

// ─── Validation ───────────────────────────────────────────────────────────────

const HM_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

function validate(
  f: FormState,
  t: ReturnType<typeof useTranslations>,
): FormErrors {
  const errors: FormErrors = {};

  if (!f.billing_mode) {
    errors['billing_mode'] = t('rateRules.validation.billingModeRequired');
  }

  if (f.billing_mode === 'open') {
    const p = fromEgpStr(f.price_per_hour_egp);
    if (p == null) {
      errors['price_per_hour_egp'] = t('rateRules.validation.pricePerHourRequired');
    } else if (p <= 0) {
      errors['price_per_hour_egp'] = t('rateRules.validation.pricePerHourPositive');
    }
  }

  if (f.billing_mode === 'prepaid') {
    const bm = parseInt(f.block_minutes, 10);
    if (isNaN(bm) || f.block_minutes.trim() === '') {
      errors['block_minutes'] = t('rateRules.validation.blockMinutesRequired');
    } else if (bm <= 0) {
      errors['block_minutes'] = t('rateRules.validation.blockMinutesPositive');
    }
    const bp = fromEgpStr(f.block_price_egp);
    if (bp == null) {
      errors['block_price_egp'] = t('rateRules.validation.blockPriceRequired');
    } else if (bp < 0) {
      errors['block_price_egp'] = t('rateRules.validation.blockPriceNonNegative');
    }
  }

  if (f.billing_mode === 'fixed_match') {
    const fmp = fromEgpStr(f.fixed_match_price_egp);
    if (fmp == null) {
      errors['fixed_match_price_egp'] = t('rateRules.validation.fixedMatchPriceRequired');
    } else if (fmp < 0) {
      errors['fixed_match_price_egp'] = t('rateRules.validation.fixedMatchPriceNonNegative');
    }
  }

  // Time window: both-or-none
  const hasStart = f.time_start.trim() !== '';
  const hasEnd = f.time_end.trim() !== '';
  if (hasStart !== hasEnd) {
    errors['time_start'] = t('rateRules.validation.timeBothOrNone');
  }
  if (hasStart && !HM_REGEX.test(f.time_start)) {
    errors['time_start'] = t('rateRules.validation.timeFormat');
  }
  if (hasEnd && !HM_REGEX.test(f.time_end)) {
    errors['time_end'] = t('rateRules.validation.timeFormat');
  }

  const rm = parseInt(f.rounding_minutes, 10);
  if (!isNaN(rm) && rm < 0) {
    errors['rounding_minutes'] = t('rateRules.validation.roundingMinutesNonNegative');
  }

  const mcm = parseInt(f.min_charge_minutes, 10);
  if (!isNaN(mcm) && mcm < 0) {
    errors['min_charge_minutes'] = t('rateRules.validation.minChargeMinutesNonNegative');
  }

  return errors;
}

// ─── Form state ───────────────────────────────────────────────────────────────

interface FormState {
  device_type: string;
  play_mode: PlayModeRule;
  billing_mode: BillingMode | '';
  day_type: DayTypeRule;
  time_start: string;
  time_end: string;
  price_per_hour_egp: string;
  block_minutes: string;
  block_price_egp: string;
  fixed_match_price_egp: string;
  rounding_minutes: string;
  min_charge_minutes: string;
  priority: string;
  is_active: boolean;
}

function toFormState(rule?: RateRule): FormState {
  if (!rule) {
    return {
      device_type: 'any',
      play_mode: 'any',
      billing_mode: '',
      day_type: 'any',
      time_start: '',
      time_end: '',
      price_per_hour_egp: '',
      block_minutes: '',
      block_price_egp: '',
      fixed_match_price_egp: '',
      rounding_minutes: '5',
      min_charge_minutes: '0',
      priority: '0',
      is_active: true,
    };
  }
  return {
    device_type: rule.device_type,
    play_mode: rule.play_mode,
    billing_mode: rule.billing_mode,
    day_type: rule.day_type,
    time_start: rule.time_start ?? '',
    time_end: rule.time_end ?? '',
    price_per_hour_egp: toEgpStr(rule.price_per_hour),
    block_minutes: rule.block_minutes != null ? String(rule.block_minutes) : '',
    block_price_egp: toEgpStr(rule.block_price),
    fixed_match_price_egp: toEgpStr(rule.fixed_match_price),
    rounding_minutes: String(rule.rounding_minutes),
    min_charge_minutes: String(rule.min_charge_minutes),
    priority: String(rule.priority),
    is_active: rule.is_active,
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function RateRuleForm({ initial, onSuccess, onCancel }: RateRuleFormProps) {
  const t = useTranslations();
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
        const el = document.getElementById(`field-${firstKey}`);
        if (el) (el as HTMLElement).focus();
      }
      return;
    }

    setSaving(true);
    setSaveError(null);

    try {
      const supabase = getBrowserClient();

      // Build the row to upsert (AC 32 — tenant_id comes from RLS, not client body)
      const id = initial?.id ?? uuidv4();
      const now = new Date().toISOString();

      // Convert EGP → piastres for storage (CLAUDE.md §2.1, AC 29)
      const price_per_hour =
        form.billing_mode === 'open' ? fromEgpStr(form.price_per_hour_egp) : null;
      const block_price =
        form.billing_mode === 'prepaid' ? fromEgpStr(form.block_price_egp) : null;
      const block_minutes =
        form.billing_mode === 'prepaid'
          ? parseInt(form.block_minutes, 10) || null
          : null;
      const fixed_match_price =
        form.billing_mode === 'fixed_match' ? fromEgpStr(form.fixed_match_price_egp) : null;

      const row = {
        id,
        device_type: form.device_type.trim() || 'any',
        play_mode: form.play_mode,
        billing_mode: form.billing_mode as BillingMode,
        day_type: form.day_type,
        time_start: form.time_start.trim() || null,
        time_end: form.time_end.trim() || null,
        price_per_hour,
        block_minutes,
        block_price,
        fixed_match_price,
        rounding_minutes: parseInt(form.rounding_minutes, 10) || 5,
        min_charge_minutes: parseInt(form.min_charge_minutes, 10) || 0,
        priority: parseInt(form.priority, 10) || 0,
        is_active: form.is_active,
        updated_at: now,
        // created_at only on insert — upsert will ignore it if row exists
        ...(initial == null ? { created_at: now } : {}),
      };

      // Upsert (idempotent — client-generated UUID, AC 41 / CLAUDE.md §2.8)
      // tenant_id is NOT sent — RLS WITH CHECK enforces it from the JWT claim (AC 32)
      const { data, error } = await supabase
        .from('rate_rules')
        .upsert(row, { onConflict: 'id' })
        .select()
        .single();

      if (error) throw error;

      // Write audit_log row (ADR-0005 Decision 5; action taxonomy locked)
      const action = initial == null ? 'rate_rule.create' : 'rate_rule.update';
      const auditMeta =
        initial == null
          ? { snapshot: row }
          : {
              before: {
                device_type: initial.device_type,
                billing_mode: initial.billing_mode,
                price_per_hour: initial.price_per_hour,
                is_active: initial.is_active,
              },
              after: {
                device_type: row.device_type,
                billing_mode: row.billing_mode,
                price_per_hour: row.price_per_hour,
                is_active: row.is_active,
              },
            };

      // Audit write is a follow-on idempotent insert (see ADR-0005 Decision 5).
      // No error thrown if this fails — the mutation is already committed.
      await supabase.from('audit_log').insert({
        id: uuidv4(),
        action,
        entity: 'rate_rule',
        entity_id: id,
        amount: null,
        meta: auditMeta,
        created_at: now,
      });

      onSuccess(data as RateRule);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setSaving(false);
    }
  }

  const isEdit = initial != null;

  return (
    <form onSubmit={(e) => void handleSubmit(e)} noValidate className="space-y-lg">
      {/* Billing mode — required (progressive disclosure of mode-specific fields) */}
      <div className="flex flex-col gap-xs">
        <label className="text-label font-medium text-text-muted text-start" htmlFor="billing_mode">
          {t('rateRules.field.billingMode')}
          <span className="text-danger ms-1" aria-hidden="true">*</span>
        </label>
        <select
          id="billing_mode"
          value={form.billing_mode}
          onChange={(e) => set('billing_mode', e.target.value as BillingMode | '')}
          disabled={isEdit}
          className={`w-full h-[52px] px-md rounded-sm text-body text-text bg-surface-3 border transition-colors duration-fast
            focus:outline-none focus:ring-2 focus:ring-primary focus:border-border-strong
            disabled:opacity-45 disabled:cursor-not-allowed
            ${errors['billing_mode'] ? 'border-danger' : 'border-border'}`}
        >
          <option value="">{t('rateRules.field.billingMode')}</option>
          <option value="open">{t('rateRules.billingMode.open')}</option>
          <option value="prepaid">{t('rateRules.billingMode.prepaid')}</option>
          <option value="fixed_match">{t('rateRules.billingMode.fixed_match')}</option>
        </select>
        {errors['billing_mode'] && (
          <p role="alert" aria-live="polite" className="text-caption text-danger text-start">
            {errors['billing_mode']}
          </p>
        )}
        {isEdit && (
          <p className="text-caption text-text-faint text-start">
            {/* Billing mode is immutable after creation */}
            {t('rateRules.field.billingMode')}
          </p>
        )}
      </div>

      {/* Device type */}
      <TextField
        id="device_type"
        label={t('rateRules.field.deviceType')}
        value={form.device_type}
        onChange={(e) => set('device_type', e.target.value)}
        helper={t('rateRules.field.deviceTypeHelper')}
        error={errors['device_type']}
      />

      {/* Play mode */}
      <div className="flex flex-col gap-xs">
        <label className="text-label font-medium text-text-muted text-start" htmlFor="play_mode">
          {t('rateRules.field.playMode')}
        </label>
        <select
          id="play_mode"
          value={form.play_mode}
          onChange={(e) => set('play_mode', e.target.value as PlayModeRule)}
          className="w-full h-[52px] px-md rounded-sm text-body text-text bg-surface-3 border border-border
            transition-colors duration-fast focus:outline-none focus:ring-2 focus:ring-primary focus:border-border-strong"
        >
          <option value="any">{t('rateRules.playMode.any')}</option>
          <option value="single">{t('rateRules.playMode.single')}</option>
          <option value="multi">{t('rateRules.playMode.multi')}</option>
        </select>
      </div>

      {/* Day type */}
      <div className="flex flex-col gap-xs">
        <label className="text-label font-medium text-text-muted text-start" htmlFor="day_type">
          {t('rateRules.field.dayType')}
        </label>
        <select
          id="day_type"
          value={form.day_type}
          onChange={(e) => set('day_type', e.target.value as DayTypeRule)}
          className="w-full h-[52px] px-md rounded-sm text-body text-text bg-surface-3 border border-border
            transition-colors duration-fast focus:outline-none focus:ring-2 focus:ring-primary focus:border-border-strong"
        >
          <option value="any">{t('rateRules.dayType.any')}</option>
          <option value="weekday">{t('rateRules.dayType.weekday')}</option>
          <option value="weekend">{t('rateRules.dayType.weekend')}</option>
        </select>
      </div>

      {/* Time window */}
      <div className="grid grid-cols-2 gap-md">
        <TextField
          id="time_start"
          label={t('rateRules.field.timeStart')}
          value={form.time_start}
          onChange={(e) => set('time_start', e.target.value)}
          placeholder="18:00"
          error={errors['time_start']}
          helper={!errors['time_start'] ? t('rateRules.field.timeHelper') : undefined}
          autoComplete="off"
        />
        <TextField
          id="time_end"
          label={t('rateRules.field.timeEnd')}
          value={form.time_end}
          onChange={(e) => set('time_end', e.target.value)}
          placeholder="02:00"
          error={errors['time_end']}
          autoComplete="off"
        />
      </div>

      {/* Mode-conditional price fields */}
      {form.billing_mode === 'open' && (
        <TextField
          id="price_per_hour_egp"
          label={t('rateRules.field.pricePerHour')}
          type="number"
          inputMode="decimal"
          min="0"
          step="0.01"
          value={form.price_per_hour_egp}
          onChange={(e) => set('price_per_hour_egp', e.target.value)}
          required
          error={errors['price_per_hour_egp']}
        />
      )}

      {form.billing_mode === 'prepaid' && (
        <>
          <TextField
            id="block_minutes"
            label={t('rateRules.field.blockMinutes')}
            type="number"
            inputMode="numeric"
            min="1"
            step="1"
            value={form.block_minutes}
            onChange={(e) => set('block_minutes', e.target.value)}
            required
            error={errors['block_minutes']}
          />
          <TextField
            id="block_price_egp"
            label={t('rateRules.field.blockPrice')}
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={form.block_price_egp}
            onChange={(e) => set('block_price_egp', e.target.value)}
            required
            error={errors['block_price_egp']}
          />
        </>
      )}

      {form.billing_mode === 'fixed_match' && (
        <TextField
          id="fixed_match_price_egp"
          label={t('rateRules.field.fixedMatchPrice')}
          type="number"
          inputMode="decimal"
          min="0"
          step="0.01"
          value={form.fixed_match_price_egp}
          onChange={(e) => set('fixed_match_price_egp', e.target.value)}
          required
          error={errors['fixed_match_price_egp']}
        />
      )}

      {/* Modifiers */}
      <div className="grid grid-cols-2 gap-md">
        <TextField
          id="rounding_minutes"
          label={t('rateRules.field.roundingMinutes')}
          type="number"
          inputMode="numeric"
          min="0"
          step="1"
          value={form.rounding_minutes}
          onChange={(e) => set('rounding_minutes', e.target.value)}
          error={errors['rounding_minutes']}
        />
        <TextField
          id="min_charge_minutes"
          label={t('rateRules.field.minChargeMinutes')}
          type="number"
          inputMode="numeric"
          min="0"
          step="1"
          value={form.min_charge_minutes}
          onChange={(e) => set('min_charge_minutes', e.target.value)}
          error={errors['min_charge_minutes']}
        />
      </div>

      {/* Priority */}
      <TextField
        id="priority"
        label={t('rateRules.field.priority')}
        type="number"
        inputMode="numeric"
        step="1"
        value={form.priority}
        onChange={(e) => set('priority', e.target.value)}
        error={errors['priority']}
      />

      {/* Save error */}
      {saveError && (
        <p role="alert" aria-live="assertive" className="text-caption text-danger text-start">
          {saveError}
        </p>
      )}

      {/* Actions */}
      <div className="flex gap-md justify-end pt-sm">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={saving}>
          {t('rateRules.action.cancel')}
        </Button>
        <Button type="submit" variant="primary" loading={saving}>
          {t('rateRules.action.save')}
        </Button>
      </div>
    </form>
  );
}
