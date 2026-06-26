'use client';

/**
 * ImpersonationBanner — safety-critical persistent banner (AC 24, design §7.2).
 *
 * HARD RULES:
 *  - NEVER hidden or dismissible while impersonation is active.
 *  - Countdown derived from impersonation_exp timestamp (CLAUDE.md §2.2:
 *    timers derive from timestamps, never setInterval counters).
 *  - Solid impersonation-surface violet; white text; ≥4.5:1 contrast.
 *  - Wraps the whole app shell with a 3px impersonation-frame inset border.
 *  - End-now is always reachable (skip-link / keyboard target).
 *  - Arabic-Indic digits for the countdown (design-system §6).
 *  - Transitions to warning (amber) under 2 min, critical (red) under 30s.
 *    Both modes are color + weight only — reduced-motion-safe (no animation).
 */

import { useEffect, useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { formatClock, toArabicDigits } from '@ps/core';

interface ImpersonationBannerProps {
  tenantName: string;
  expiresAtIso: string;
  onEndNow: () => void;
  /** Whether "End now" is submitting (shows spinner, disables button). */
  endNowSubmitting?: boolean;
}

function useCountdown(expiresAtIso: string) {
  const getRemaining = useCallback(() => {
    const ms = new Date(expiresAtIso).getTime() - Date.now();
    return Math.max(0, Math.floor(ms / 1000));
  }, [expiresAtIso]);

  const [remainingSecs, setRemainingSecs] = useState(getRemaining);

  useEffect(() => {
    // CLAUDE.md §2.2: tick forces re-render; value always re-derived from timestamp.
    const interval = setInterval(() => {
      setRemainingSecs(getRemaining());
    }, 1000);
    return () => clearInterval(interval);
  }, [getRemaining]);

  return remainingSecs;
}

export function ImpersonationBanner({
  tenantName,
  expiresAtIso,
  onEndNow,
  endNowSubmitting = false,
}: ImpersonationBannerProps) {
  const t = useTranslations('admin.impersonate');
  const remainingSecs = useCountdown(expiresAtIso);

  // Color/weight state based on remaining time (never color alone — color + weight)
  const isWarning = remainingSecs <= 120 && remainingSecs > 30;
  const isCritical = remainingSecs <= 30;

  // Clock display — direction-neutral (not RTL-mirrored, design §6)
  const clockStr = formatClock(remainingSecs);
  const displayClock = toArabicDigits(clockStr);

  const countdownColorClass = isCritical
    ? 'text-danger font-bold'
    : isWarning
    ? 'text-warning font-semibold'
    : 'text-on-impersonation font-medium';

  const a11yLabel = t('banner.a11y', { tenant: tenantName, time: clockStr });

  return (
    <>
      {/* 3px inset frame around the whole app while impersonating (design §7.2) */}
      <div
        aria-hidden="true"
        className="fixed inset-0 pointer-events-none z-[9999] rounded-none"
        style={{ boxShadow: 'inset 0 0 0 3px #8B5CF6' }}
      />

      {/* Persistent top banner */}
      <div
        role="status"
        aria-live="polite"
        aria-label={a11yLabel}
        className="w-full bg-impersonation-surface text-on-impersonation px-xl py-sm flex items-center gap-md shadow-e3 sticky top-0 z-[9998]"
      >
        {/* Skip-link target for keyboard users — End now is always the first tab stop */}
        <a
          id="impersonation-end-skip"
          href="#impersonation-end-btn"
          className="sr-only focus:not-sr-only focus:px-sm focus:py-xs focus:rounded-xs focus:bg-white/20 focus:text-white"
        >
          {t('end.title')}
        </a>

        {/* START: identity label + tenant name */}
        <div className="flex items-center gap-sm flex-1 min-w-0">
          {/* Shield icon — platform identity signal */}
          <svg
            aria-hidden="true"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="flex-shrink-0"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"
            />
          </svg>
          <span className="text-label font-medium truncate">
            {t('banner.label', { tenant: tenantName })}
          </span>
        </div>

        {/* CENTER: remaining time countdown */}
        <div className="flex items-center gap-xs flex-shrink-0">
          <span className="text-caption text-on-impersonation/80">
            {t('banner.remaining')}
          </span>
          {/* dir="ltr": clock is not directional — never mirrored in RTL (design §6) */}
          <time
            dateTime={`PT${remainingSecs}S`}
            dir="ltr"
            className={`font-mono tabular-nums text-label ${countdownColorClass}`}
            aria-label={t('banner.countdownA11y', {
              minutes: toArabicDigits(String(Math.floor(remainingSecs / 60))),
              seconds: toArabicDigits(String(remainingSecs % 60)),
            })}
          >
            {displayClock}
          </time>
        </div>

        {/* END: End now button (always reachable — escape-routes, §7.2) */}
        <button
          id="impersonation-end-btn"
          type="button"
          onClick={onEndNow}
          disabled={endNowSubmitting}
          aria-label={t('banner.endNow')}
          className="flex-shrink-0 flex items-center gap-xs px-sm py-xs rounded-xs bg-white/20 hover:bg-white/30 text-on-impersonation text-label font-medium border border-white/30 transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {endNowSubmitting ? (
            <svg
              aria-hidden="true"
              className="w-4 h-4 animate-spin"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : null}
          {t('banner.endNow')}
        </button>
      </div>
    </>
  );
}
