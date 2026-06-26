'use client';

/**
 * LimitReachedDialog — raised when a create action hits the plan cap (design §4.1, AC 30).
 *
 * Calm, actionable, non-punitive: explains the limit and offers the upgrade path.
 * Owner → "ترقية" CTA (routes to /dashboard/billing#plans).
 * Manager/staff → "أبلغ المالك" (no upgrade control).
 *
 * a11y: role="alertdialog", focus trapped, Esc/Cancel close.
 * RTL: numerals Arabic-Indic.
 * All strings via i18n.
 */

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { toArabicDigits } from '@ps/core';
import type { CapResource } from '@ps/core';
import { Button } from '@/components/ui/Button';
import Link from 'next/link';

interface LimitReachedDialogProps {
  open: boolean;
  resourceKey: CapResource;
  used: number;
  limit: number;
  isOwner: boolean;
  onClose: () => void;
}

export function LimitReachedDialog({
  open,
  resourceKey,
  used,
  limit,
  isOwner,
  onClose,
}: LimitReachedDialogProps) {
  const t = useTranslations('billing.limit');
  const tAction = useTranslations('action');
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus trap + Esc close
  useEffect(() => {
    if (!open) return;
    const el = dialogRef.current;
    if (!el) return;
    const focusable = el.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length > 0) {
      focusable[0]?.focus();
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  if (!open) return null;

  const resourceLabel = t(`resource.${resourceKey}`);

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-xl"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="absolute inset-0 bg-scrim" aria-hidden="true" />
      {/* Dialog */}
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="limit-dialog-title"
        aria-describedby="limit-dialog-body"
        className="relative z-10 bg-surface rounded-md shadow-e3 p-2xl max-w-md w-full border border-border flex flex-col gap-lg"
      >
        {/* Icon + Title */}
        <div className="flex items-center gap-sm">
          <span className="flex-shrink-0 w-10 h-10 flex items-center justify-center rounded-xs bg-warning/15">
            <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-warning">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </span>
          <h2 id="limit-dialog-title" className="text-h3 text-text font-semibold">
            {t('title')}
          </h2>
        </div>

        {/* Body */}
        <p id="limit-dialog-body" className="text-body text-text-muted">
          {t('body', {
            limit: toArabicDigits(String(limit)),
            resource: resourceLabel,
            used: toArabicDigits(String(used)),
          })}
        </p>

        {/* Actions */}
        <div className="flex items-center justify-end gap-sm flex-wrap">
          <Button variant="secondary" size="md" onClick={onClose}>
            {tAction('cancel')}
          </Button>
          {isOwner ? (
            <Link
              href="/dashboard/billing#plans"
              className="inline-flex items-center justify-center gap-2 rounded-sm font-medium text-label transition-all duration-fast bg-primary text-on-primary hover:bg-primary-press h-[52px] px-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              onClick={onClose}
            >
              {t('upgrade')}
            </Link>
          ) : (
            <span className="text-label text-text-muted px-sm py-xs">
              {t('tellOwner')}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
