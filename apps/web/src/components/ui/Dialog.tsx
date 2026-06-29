'use client';

/**
 * Dialog — accessible modal dialog shell (WCAG 2.1 AA, ADR-0011 §Q5).
 *
 * Handles:
 *   - role="dialog" + aria-modal="true" (already set)
 *   - aria-labelledby / aria-label for screen-reader title announcement
 *   - Focus: moves into dialog on open (first focusable element)
 *   - Focus trap: Tab / Shift+Tab cycles within the dialog
 *   - Focus return: restores the triggering element's focus on close
 *   - Escape key: closes dialog
 *   - RTL-safe (logical spacing, no directional hardcoding)
 *
 * Usage:
 *   <Dialog labelledBy="my-dialog-title" onClose={closeDialog}>
 *     <h2 id="my-dialog-title">{title}</h2>
 *     {content}
 *   </Dialog>
 *
 * For confirm dialogs without a visible heading, pass ariaLabel instead:
 *   <Dialog ariaLabel={t('action.confirm')} onClose={closeDialog}>…</Dialog>
 */

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';

/** Selector for keyboard-focusable elements inside the dialog. */
const FOCUSABLE_SEL = [
  'a[href]:not([tabindex="-1"])',
  'button:not([disabled]):not([tabindex="-1"])',
  'input:not([disabled]):not([tabindex="-1"])',
  'select:not([disabled]):not([tabindex="-1"])',
  'textarea:not([disabled]):not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export interface DialogProps {
  /**
   * ID of the element inside the dialog that labels it (aria-labelledby).
   * Typically an h2's id. Preferred over ariaLabel when a heading exists.
   */
  labelledBy?: string;
  /**
   * Fallback aria-label string when no visible heading is present
   * (e.g. a confirm dialog). Ignored when labelledBy is set.
   */
  ariaLabel?: string;
  /** Called when the user closes the dialog (Escape, close button, backdrop). */
  onClose: () => void;
  children: React.ReactNode;
}

export function Dialog({ labelledBy, ariaLabel, onClose, children }: DialogProps) {
  const t = useTranslations();
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    // Capture the element that triggered this dialog so we can restore focus.
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // Move focus into the dialog (first focusable element, or the panel itself).
    const panel = panelRef.current;
    if (panel) {
      const focusables = panel.querySelectorAll<HTMLElement>(FOCUSABLE_SEL);
      if (focusables.length > 0) {
        focusables[0].focus();
      } else {
        panel.focus();
      }
    }

    return () => {
      // Restore focus to the trigger element when the dialog unmounts.
      previousFocusRef.current?.focus();
    };
  }, []);

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    // Escape closes the dialog.
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }

    // Tab traps focus within the dialog panel.
    if (e.key === 'Tab' && panelRef.current) {
      const focusables = panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SEL);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
  }

  return (
    // Outer container: backdrop scrim + keyboard handler. jsx-a11y flags role="dialog" +
    // onClick as non-interactive, but the WCAG pattern for a modal is correct here —
    // the outer div holds Escape/Tab trapping; screen readers find the dialog role.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-md"
      style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      aria-label={!labelledBy ? ariaLabel : undefined}
      onClick={onClose}
      onKeyDown={handleKeyDown}
    >
      {/* Dialog panel — stops propagation so panel clicks don't close dialog */}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events */}
      <div
        ref={panelRef}
        tabIndex={-1}
        className="relative z-10 w-full max-w-lg bg-surface rounded-lg border border-border shadow-e3 p-xl max-h-[90dvh] overflow-y-auto outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close button */}
        <button
          type="button"
          onClick={onClose}
          aria-label={t('action.close')}
          className="absolute top-md end-md text-text-muted hover:text-text transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-xs p-xs"
        >
          <svg
            aria-hidden="true"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        {children}
      </div>
    </div>
  );
}
