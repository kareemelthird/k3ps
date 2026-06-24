'use client';

/**
 * RateRulePreview — resolved-rate preview panel (AC 31).
 *
 * Given a sample (device_type, play_mode, billing_mode, Cairo instant),
 * calls the SAME @ps/core resolveRule the counter uses and shows:
 *   - which rule wins (id + price), or
 *   - "no matching rule (fallback: 0)".
 *
 * This widget can NEVER disagree with what the counter charges, because it
 * uses the identical resolveRule function (not a re-derivation). Money is
 * formatted via formatEgp and displayed as Arabic-Indic via toArabicDigits.
 *
 * HARD RULES:
 *  - No inline currency math — all money via @ps/core.
 *  - No hardcoded strings — all from i18n.
 *  - RTL layout — logical spacing only.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  resolveRule,
  formatEgp,
  toArabicDigits,
  nowIso,
} from '@ps/core';
import type { RateRule, BillingMode, PlayMode } from '@ps/core';
import { Button } from '@/components/ui/Button';

interface RateRulePreviewProps {
  /** The current tenant's rate rules (all — resolveRule filters active ones internally). */
  rules: RateRule[];
}

interface ResolvedResult {
  rule: RateRule | null;
  at_iso: string;
}

export function RateRulePreview({ rules }: RateRulePreviewProps) {
  const t = useTranslations();

  // Default sample values for the preview form
  const [deviceType, setDeviceType] = useState('any');
  const [playMode, setPlayMode] = useState<PlayMode>('single');
  const [billingMode, setBillingMode] = useState<BillingMode>('open');
  // Cairo local time string (YYYY-MM-DDTHH:mm), defaulting to "now"
  const [sampleLocalTime, setSampleLocalTime] = useState(() => {
    // Build local Cairo time for the default input value (display only — stored UTC in resolveRule)
    const now = new Date();
    // Format as YYYY-MM-DDTHH:mm in Cairo (Africa/Cairo = UTC+2 or UTC+3 during DST)
    const cairoStr = now.toLocaleString('sv-SE', { timeZone: 'Africa/Cairo' }).slice(0, 16);
    return cairoStr;
  });
  const [result, setResult] = useState<ResolvedResult | null>(null);

  function handleResolve() {
    // Convert the Cairo local time input to a UTC ISO string.
    // The input type="datetime-local" yields "YYYY-MM-DDTHH:mm" in Cairo local.
    // We treat it as Cairo time and convert to UTC by calling Intl.
    // We do NOT compute money here — only call resolveRule to pick the rule.
    const atIso = localCairoToUtcIso(sampleLocalTime);
    const rule = resolveRule(rules, {
      device_type: deviceType.trim() || 'any',
      play_mode: playMode,
      billing_mode: billingMode,
      at_iso: atIso,
    });
    setResult({ rule, at_iso: atIso });
  }

  return (
    <section
      aria-labelledby="preview-heading"
      className="rounded-md bg-surface border border-border p-lg space-y-md"
    >
      <div>
        <h2 id="preview-heading" className="text-h2 text-text">
          {t('rateRules.preview.title')}
        </h2>
        <p className="text-label text-text-muted mt-xs">
          {t('rateRules.preview.description')}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-md">
        {/* Device type */}
        <div className="flex flex-col gap-xs">
          <label className="text-label font-medium text-text-muted text-start" htmlFor="preview-device-type">
            {t('rateRules.preview.deviceType')}
          </label>
          <input
            id="preview-device-type"
            type="text"
            value={deviceType}
            onChange={(e) => setDeviceType(e.target.value)}
            className="w-full h-[52px] px-md rounded-sm text-body text-text bg-surface-3 border border-border
              transition-colors duration-fast focus:outline-none focus:ring-2 focus:ring-primary focus:border-border-strong"
            placeholder="PS5"
            autoComplete="off"
          />
        </div>

        {/* Play mode */}
        <div className="flex flex-col gap-xs">
          <label className="text-label font-medium text-text-muted text-start" htmlFor="preview-play-mode">
            {t('rateRules.preview.playMode')}
          </label>
          <select
            id="preview-play-mode"
            value={playMode}
            onChange={(e) => setPlayMode(e.target.value as PlayMode)}
            className="w-full h-[52px] px-md rounded-sm text-body text-text bg-surface-3 border border-border
              transition-colors duration-fast focus:outline-none focus:ring-2 focus:ring-primary focus:border-border-strong"
          >
            <option value="single">{t('rateRules.playMode.single')}</option>
            <option value="multi">{t('rateRules.playMode.multi')}</option>
          </select>
        </div>

        {/* Billing mode */}
        <div className="flex flex-col gap-xs">
          <label className="text-label font-medium text-text-muted text-start" htmlFor="preview-billing-mode">
            {t('rateRules.preview.billingMode')}
          </label>
          <select
            id="preview-billing-mode"
            value={billingMode}
            onChange={(e) => setBillingMode(e.target.value as BillingMode)}
            className="w-full h-[52px] px-md rounded-sm text-body text-text bg-surface-3 border border-border
              transition-colors duration-fast focus:outline-none focus:ring-2 focus:ring-primary focus:border-border-strong"
          >
            <option value="open">{t('rateRules.billingMode.open')}</option>
            <option value="prepaid">{t('rateRules.billingMode.prepaid')}</option>
            <option value="fixed_match">{t('rateRules.billingMode.fixed_match')}</option>
          </select>
        </div>

        {/* Sample time — Cairo local datetime */}
        <div className="flex flex-col gap-xs">
          <label className="text-label font-medium text-text-muted text-start" htmlFor="preview-sample-time">
            {t('rateRules.preview.sampleTime')}
          </label>
          <input
            id="preview-sample-time"
            type="datetime-local"
            value={sampleLocalTime}
            onChange={(e) => setSampleLocalTime(e.target.value)}
            className="w-full h-[52px] px-md rounded-sm text-body text-text bg-surface-3 border border-border
              transition-colors duration-fast focus:outline-none focus:ring-2 focus:ring-primary focus:border-border-strong
              [color-scheme:dark]"
          />
        </div>
      </div>

      <Button variant="secondary" onClick={handleResolve}>
        {t('rateRules.preview.resolve')}
      </Button>

      {/* Result panel */}
      {result && (
        <div
          className="rounded-sm bg-surface-2 border border-border p-md space-y-sm"
          role="region"
          aria-label={t('rateRules.preview.title')}
          aria-live="polite"
          aria-atomic="true"
        >
          {result.rule === null ? (
            <p className="text-body text-text-muted">{t('rateRules.preview.result.noRule')}</p>
          ) : (
            <>
              <p className="text-label text-text-muted">
                {t('rateRules.preview.result.winningRule')}
              </p>

              {/* Resolved rate — money displayed via formatEgp + toArabicDigits */}
              <p className="text-h2 text-primary tabular-nums" dir="ltr">
                {result.rule.price_per_hour != null
                  ? formatEgp(result.rule.price_per_hour)
                  : result.rule.block_price != null
                    ? formatEgp(result.rule.block_price)
                    : result.rule.fixed_match_price != null
                      ? formatEgp(result.rule.fixed_match_price)
                      : '—'}
              </p>

              <dl className="grid grid-cols-2 gap-xs text-caption text-text-muted">
                <dt className="font-medium">{t('rateRules.preview.result.ruleId')}</dt>
                <dd className="text-text font-mono text-xs truncate" dir="ltr">
                  {result.rule.id}
                </dd>

                <dt className="font-medium">{t('rateRules.preview.result.priority')}</dt>
                <dd className="text-text" dir="ltr">
                  {toArabicDigits(String(result.rule.priority))}
                </dd>

                <dt className="font-medium">{t('rateRules.field.billingMode')}</dt>
                <dd className="text-text">
                  {t(`rateRules.billingMode.${result.rule.billing_mode}`)}
                </dd>

                <dt className="font-medium">{t('rateRules.field.deviceType')}</dt>
                <dd className="text-text" dir="ltr">
                  {result.rule.device_type}
                </dd>
              </dl>
            </>
          )}
        </div>
      )}
    </section>
  );
}

// ─── Cairo local → UTC ISO conversion (display only — not cost math) ─────────

/**
 * Convert a Cairo local datetime string "YYYY-MM-DDTHH:mm" to a UTC ISO string.
 * Used only to translate the preview form's local-time input into a UTC instant
 * for resolveRule — no money computation happens here.
 *
 * Cairo is UTC+2 (standard) or UTC+3 (DST in summer). We use Intl.DateTimeFormat
 * to find the Cairo UTC offset at the given local time so the conversion is DST-safe.
 */
function localCairoToUtcIso(localStr: string): string {
  if (!localStr) return nowIso();
  try {
    // Parse as if UTC first, then determine the Cairo offset at that approximate instant.
    const asUtc = new Date(`${localStr}:00Z`);
    if (isNaN(asUtc.getTime())) return nowIso();

    // Get Cairo offset (in minutes, negative = behind UTC) at this instant.
    // Intl.DateTimeFormat with timeZone gives us the Cairo repr; we compute the diff.
    const cairoFormatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Cairo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = cairoFormatter.formatToParts(asUtc);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0';
    const cairoYear = parseInt(get('year'), 10);
    const cairoMonth = parseInt(get('month'), 10) - 1;
    const cairoDay = parseInt(get('day'), 10);
    const cairoHour = parseInt(get('hour'), 10);
    const cairoMinute = parseInt(get('minute'), 10);

    // The asUtc date as displayed in Cairo: build a reference Date.
    const cairoRefMs = Date.UTC(cairoYear, cairoMonth, cairoDay, cairoHour, cairoMinute, 0);
    // Offset = cairoRefMs - asUtc.getTime() (positive = Cairo is ahead of UTC, as expected)
    const offsetMs = cairoRefMs - asUtc.getTime();

    // The desired Cairo local time is localStr; subtract the offset to get UTC.
    const [datePart, timePart] = localStr.split('T');
    const [yyyy, mm, dd] = (datePart ?? '').split('-').map(Number);
    const [hh, mi] = (timePart ?? '').split(':').map(Number);
    const localMs = Date.UTC(yyyy ?? 0, (mm ?? 1) - 1, dd ?? 1, hh ?? 0, mi ?? 0, 0);
    const utcMs = localMs - offsetMs;
    return new Date(utcMs).toISOString();
  } catch {
    return nowIso();
  }
}
