'use client';

/**
 * DeviceCard (web — read-only) — design-system §9.11
 *
 * Web variant: no onPress/start affordance. Live timer ticks from started_at.
 * Status conveyed by pill + dot + border — never color alone (a11y).
 */
import { useTranslations } from 'next-intl';
import { formatEgp } from '@ps/core';
import type { Device } from '@ps/core';
import { StatusPill } from '@/components/ui/StatusPill';
import { LiveTimer } from '@/components/ui/LiveTimer';
import { LiveCost } from '@/components/ui/LiveCost';

interface DeviceCardProps {
  device: Device;
  /** Active session for this device (if busy) */
  session?: {
    id: string;
    started_at: string;
    grand_total: number;
    /** Rate snapshot from the first segment — used for live cost display. */
    price_per_hour_snapshot?: number | null;
  } | null;
}

const BORDER_STYLES: Record<string, string> = {
  free: 'border-status-free',
  busy: 'border-status-busy',
  maintenance: 'border-status-maint',
};

export function DeviceCard({ device, session }: DeviceCardProps) {
  const t = useTranslations();
  const borderColor = BORDER_STYLES[device.status] ?? 'border-border';

  const accessibilityLabel = [
    device.name,
    t(`device.status.${device.status}`),
    device.status === 'busy' && session
      ? `${t('session.startedAt')} ${session.started_at}`
      : '',
  ]
    .filter(Boolean)
    .join(' — ');

  return (
    <article
      aria-label={accessibilityLabel}
      className={`relative rounded-md bg-surface border ${borderColor} border p-md flex flex-col gap-sm min-h-[120px] transition-shadow duration-base hover:shadow-e1`}
    >
      {/* Device name */}
      <div className="flex items-start justify-between gap-xs">
        <h3 className="text-h3 text-text flex-1">{device.name}</h3>
        <StatusPill
          status={device.status}
          pulse={device.status === 'busy'}
        />
      </div>

      {/* Device type badge */}
      <span className="text-micro font-medium text-text-faint uppercase tracking-wider">
        {device.device_type}
      </span>

      {/* Busy state: live timer + running total */}
      {device.status === 'busy' && session && (
        <div className="mt-auto flex flex-col gap-2xs">
          <LiveTimer
            startedAt={session.started_at}
            tickMs={15000}
            size="md"
          />
          {session.price_per_hour_snapshot != null ? (
            <LiveCost
              startedAt={session.started_at}
              ratePerHourPiastres={session.price_per_hour_snapshot}
              tickMs={15000}
              className="text-money"
            />
          ) : (
            <span
              className="text-money tabular-nums text-primary"
              // Money is not directional — keep LTR layout for tabular numerals
              dir="ltr"
            >
              {formatEgp(session.grand_total)}
            </span>
          )}
        </div>
      )}

      {/* Maintenance: non-interactive explanation */}
      {device.status === 'maintenance' && (
        <p className="text-caption text-text-faint mt-auto">
          {t('device.status.maintenance')}
        </p>
      )}

      {/* Free state: subtle affordance hint (read-only on web) */}
      {device.status === 'free' && (
        <p className="text-caption text-status-free mt-auto">{t('device.status.free')}</p>
      )}
    </article>
  );
}
