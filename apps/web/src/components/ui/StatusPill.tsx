'use client';

/**
 * StatusPill — design-system §9.2
 * Renders a colored dot + label pill. Status is NEVER conveyed by color alone
 * (dot + label + a11y). Pulse animates the dot only (reduced-motion-safe).
 */
import { useTranslations } from 'next-intl';
import type { DeviceStatus } from '@ps/core';

interface StatusPillProps {
  status: DeviceStatus;
  pulse?: boolean;
  className?: string;
}

const STATUS_STYLES: Record<DeviceStatus, { dot: string; bg: string; text: string }> = {
  free: {
    dot: 'bg-status-free',
    bg: 'bg-[#10B9811A]',
    text: 'text-[#10B981]',
  },
  busy: {
    dot: 'bg-status-busy',
    bg: 'bg-[#3B82F61A]',
    text: 'text-[#3B82F6]',
  },
  maintenance: {
    dot: 'bg-status-maint',
    bg: 'bg-[#64748B1A]',
    text: 'text-[#94A3B8]',
  },
};

export function StatusPill({ status, pulse = false, className = '' }: StatusPillProps) {
  const t = useTranslations('device.status');
  const styles = STATUS_STYLES[status];

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-pill text-caption font-medium ${styles.bg} ${styles.text} ${className}`}
      aria-label={t(status)}
    >
      <span
        className={`w-2 h-2 rounded-full flex-shrink-0 ${styles.dot} ${pulse ? 'animate-pulse' : ''}`}
        aria-hidden="true"
      />
      {t(status)}
    </span>
  );
}
