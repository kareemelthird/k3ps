'use client';

/**
 * BusinessDayRangePicker — date-range picker in business-day terms (AC 13, design §4.1).
 *
 * Emits `{ fromKey, toKey, preset }` pairs — NEVER raw UTC instants; the consumer
 * (ScopeBar / ReportsView) calls businessDayRange() to convert to the RPC window.
 *
 * Presets are computed from the current business day via `businessDayKey(nowIso(), …)`.
 * cutoverHour is passed in — never read from the clock inside @ps/core math (CLAUDE.md §4).
 *
 * An invalid custom range (from > to) blocks the Apply button and shows an inline error.
 *
 * All strings via i18n. RTL layout. Arabic-Indic digits in the active label.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  businessDayKey,
  nowIso,
  CAFE_TZ,
  DEFAULT_CUTOVER_HOUR,
  toArabicDigits,
} from '@ps/core';
import type { Scope, RangePreset } from './types';

// ── Pure date arithmetic on YYYY-MM-DD strings (no tz needed, calendar day only) ──

function addDays(key: string, n: number): string {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function monthStart(key: string): string {
  return `${key.slice(0, 7)}-01`;
}

function monthEnd(key: string): string {
  // Last day of the month: first day of next month minus 1
  const ym = key.slice(0, 7);
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const nextMonth = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return addDays(`${nextMonth}-01`, -1);
}

/** Compute all preset ranges from the current business-day key */
function computePresets(cutoverHour: number): Record<RangePreset, { fromKey: string; toKey: string }> {
  const today = businessDayKey(nowIso(), cutoverHour, CAFE_TZ);
  const yesterday = addDays(today, -1);

  const thisMonthStartKey = monthStart(today);

  // Last month: first day of previous month → last day of previous month
  const lastMonthEndKey = addDays(thisMonthStartKey, -1);
  const lastMonthStartKey = monthStart(lastMonthEndKey);

  return {
    today:     { fromKey: today,     toKey: today },
    yesterday: { fromKey: yesterday, toKey: yesterday },
    last7:     { fromKey: addDays(today, -6), toKey: today },
    thisMonth: { fromKey: thisMonthStartKey, toKey: today },
    lastMonth: { fromKey: lastMonthStartKey, toKey: lastMonthEndKey },
    custom:    { fromKey: today, toKey: today }, // placeholder; overridden by user input
  };
}

/** Format a YYYY-MM-DD key as a human-readable Arabic date "١٢ يونيو" */
function formatDateKeyAr(key: string): string {
  const d = new Date(`${key}T00:00:00Z`);
  return new Intl.DateTimeFormat('ar-EG', { day: 'numeric', month: 'long' }).format(d);
}

interface BusinessDayRangePickerProps {
  value: Pick<Scope, 'fromKey' | 'toKey' | 'preset'>;
  cutoverHour?: number;
  onChange: (next: Pick<Scope, 'fromKey' | 'toKey' | 'preset'>) => void;
  disabled?: boolean;
}

const PRESET_ORDER: RangePreset[] = ['today', 'yesterday', 'last7', 'thisMonth', 'lastMonth', 'custom'];

export function BusinessDayRangePicker({
  value,
  cutoverHour = DEFAULT_CUTOVER_HOUR,
  onChange,
  disabled = false,
}: BusinessDayRangePickerProps) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);

  // Local state for the popover — staged before Apply is pressed
  const [staged, setStaged] = useState(value);
  const [customFrom, setCustomFrom] = useState(value.fromKey);
  const [customTo, setCustomTo]     = useState(value.toKey);
  const [rangeError, setRangeError] = useState<string | null>(null);

  const presets = computePresets(cutoverHour);

  function openPicker() {
    setStaged(value);
    setCustomFrom(value.fromKey);
    setCustomTo(value.toKey);
    setRangeError(null);
    setOpen(true);
  }

  function closePicker() {
    setOpen(false);
    setRangeError(null);
  }

  function selectPreset(preset: RangePreset) {
    if (preset === 'custom') {
      setStaged({ preset: 'custom', fromKey: customFrom, toKey: customTo });
    } else {
      const range = presets[preset];
      setStaged({ preset, fromKey: range.fromKey, toKey: range.toKey });
      setCustomFrom(range.fromKey);
      setCustomTo(range.toKey);
      setRangeError(null);
    }
  }

  function handleCustomFromBlur() {
    validateCustom(customFrom, customTo);
  }

  function handleCustomToBlur() {
    validateCustom(customFrom, customTo);
  }

  function validateCustom(from: string, to: string): boolean {
    if (from > to) {
      setRangeError(t('range.error.invalid'));
      return false;
    }
    setRangeError(null);
    return true;
  }

  function handleApply() {
    const fromKey = staged.preset === 'custom' ? customFrom : staged.fromKey;
    const toKey   = staged.preset === 'custom' ? customTo   : staged.toKey;

    if (staged.preset === 'custom' && !validateCustom(fromKey, toKey)) return;

    onChange({ preset: staged.preset, fromKey, toKey });
    setOpen(false);
  }

  // Active label shown in the trigger button
  const presetLabel = t(`range.preset.${value.preset}`);
  const triggerLabel = `${presetLabel}: ${toArabicDigits(formatDateKeyAr(value.fromKey))} – ${toArabicDigits(formatDateKeyAr(value.toKey))}`;

  const applyDisabled = staged.preset === 'custom' && (
    !customFrom || !customTo || customFrom > customTo
  );

  return (
    <div className="relative">
      {/* Trigger button */}
      <button
        type="button"
        onClick={openPicker}
        disabled={disabled}
        aria-expanded={open}
        aria-label={t('range.label')}
        className="flex items-center gap-xs h-[36px] px-sm rounded-xs bg-surface-3 border border-border text-label text-text hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-45 disabled:cursor-not-allowed"
      >
        {/* Calendar icon — start */}
        <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
        <span className="max-w-[220px] truncate">{triggerLabel}</span>
        {/* Chevron — end, mirrored in RTL */}
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="rtl:scale-x-[-1]">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {/* Popover */}
      {open && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40"
            aria-hidden="true"
            onClick={closePicker}
          />
          <div
            role="dialog"
            aria-label={t('range.label')}
            className="absolute z-50 start-0 top-full mt-xs w-72 rounded-md bg-surface border border-border shadow-e2 p-md space-y-sm"
          >
            {/* Presets */}
            <div role="radiogroup" aria-label={t('range.label')} className="space-y-1">
              {PRESET_ORDER.map((preset) => {
                const isSelected = staged.preset === preset;
                return (
                  <button
                    key={preset}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    onClick={() => selectPreset(preset)}
                    className={`w-full text-start px-sm py-xs rounded-xs text-label transition-colors
                      ${isSelected
                        ? 'bg-primary/10 text-primary font-medium'
                        : 'text-text hover:bg-surface-3'}`}
                  >
                    {t(`range.preset.${preset}`)}
                  </button>
                );
              })}
            </div>

            {/* Custom date inputs (shown when custom is selected) */}
            {staged.preset === 'custom' && (
              <div className="space-y-xs pt-xs border-t border-border">
                <div className="space-y-2xs">
                  <label htmlFor="range-from" className="text-caption text-text-muted">
                    {t('range.from')}
                  </label>
                  <input
                    id="range-from"
                    type="date"
                    value={customFrom}
                    onChange={(e) => setCustomFrom(e.target.value)}
                    onBlur={handleCustomFromBlur}
                    className="w-full h-[36px] px-sm rounded-xs bg-surface-3 border border-border text-label text-text focus:outline-none focus:ring-2 focus:ring-primary focus:border-border-strong"
                  />
                </div>
                <div className="space-y-2xs">
                  <label htmlFor="range-to" className="text-caption text-text-muted">
                    {t('range.to')}
                  </label>
                  <input
                    id="range-to"
                    type="date"
                    value={customTo}
                    onChange={(e) => setCustomTo(e.target.value)}
                    onBlur={handleCustomToBlur}
                    className="w-full h-[36px] px-sm rounded-xs bg-surface-3 border border-border text-label text-text focus:outline-none focus:ring-2 focus:ring-primary focus:border-border-strong"
                  />
                </div>
                {rangeError && (
                  <p className="text-caption text-danger" role="alert">
                    {rangeError}
                  </p>
                )}
              </div>
            )}

            {/* Apply / Cancel */}
            <div className="flex gap-xs pt-xs border-t border-border">
              <button
                type="button"
                onClick={handleApply}
                disabled={applyDisabled}
                className="flex-1 h-9 rounded-xs bg-primary text-on-primary text-label font-medium transition-colors hover:bg-primary-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-45 disabled:cursor-not-allowed"
              >
                {t('range.apply')}
              </button>
              <button
                type="button"
                onClick={closePicker}
                className="h-9 px-sm rounded-xs text-label text-text-muted hover:bg-surface-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                {t('range.cancel')}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
