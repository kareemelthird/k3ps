'use client';

/**
 * EmptyState — design-system §9.9
 * Icon + cause + optional primary action. Never a blank panel.
 */

interface EmptyStateProps {
  title: string;
  body?: string;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({ title, body, action, className = '' }: EmptyStateProps) {
  return (
    <div
      role="status"
      className={`flex flex-col items-center justify-center gap-md text-center py-3xl px-xl ${className}`}
    >
      {/* Generic "inbox" icon — no emojis (design-system §4) */}
      <svg
        aria-hidden="true"
        width="48"
        height="48"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="text-text-faint"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
        />
      </svg>
      <div className="space-y-xs">
        <p className="text-h3 text-text">{title}</p>
        {body && <p className="text-label text-text-muted max-w-xs">{body}</p>}
      </div>
      {action}
    </div>
  );
}
