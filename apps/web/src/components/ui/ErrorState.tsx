'use client';

/**
 * ErrorState — design-system §9.9
 * Human cause + recovery path (Retry). role="alert" for screen readers.
 */
import { useTranslations } from 'next-intl';

interface ErrorStateProps {
  message?: string;
  onRetry?: () => void;
  className?: string;
}

export function ErrorState({ message, onRetry, className = '' }: ErrorStateProps) {
  const t = useTranslations();
  return (
    <div
      role="alert"
      aria-live="assertive"
      className={`flex flex-col items-center justify-center gap-md text-center py-2xl px-xl ${className}`}
    >
      <svg
        aria-hidden="true"
        width="40"
        height="40"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="text-danger"
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <div className="space-y-xs">
        <p className="text-h3 text-text">{t('state.error.generic')}</p>
        {message && (
          <p className="text-label text-text-muted max-w-sm font-mono text-xs">{message}</p>
        )}
      </div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="px-md py-xs rounded-sm bg-surface-3 text-text text-label font-medium hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          {t('action.retry')}
        </button>
      )}
    </div>
  );
}
