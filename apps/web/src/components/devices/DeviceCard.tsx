'use client';

/**
 * DeviceCard (web — read-only) — design-system §9.11, design-uplift.
 *
 * Additions vs. previous version:
 *   - Device-type chip: PS4 = info blue, PS5 = primary teal, VIP = amber.
 *   - Status-tinted card background (~6% alpha over surface).
 *   - e1 elevation (shadow-e1) on hover retained + static border.
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
    price_per_hour_snapshot?: number | null;
  } | null;
}

// ── Status border classes ─────────────────────────────────────────────────────

const BORDER_STYLES: Record<string, string> = {
  free:        'border-status-free',
  busy:        'border-status-busy',
  maintenance: 'border-status-maint',
};

// ── Status-tinted background (6% color overlay on surface #0D131D) ────────────
// Pre-computed: rgb(surface) mixed with status color at ~6% opacity.
// free  (#10B981): (13*0.94+16*0.06, 19*0.94+185*0.06, 29*0.94+129*0.06) → #0D1D23
// busy  (#3B82F6): (13*0.94+59*0.06, 19*0.94+130*0.06, 29*0.94+246*0.06) → #101A2A
// maint (#64748B): (13*0.95+100*0.05, 19*0.95+116*0.05, 29*0.95+139*0.05) → #111823

const STATUS_BG: Record<string, string> = {
  free:        '#0D1D23',
  busy:        '#101A2A',
  maintenance: '#111823',
};

// ── Device-type chip tokens (design-system §2.1 primitives) ──────────────────
// PS4  = info blue B400/B500  | PS5 = primary teal T400/T500 | VIP = amber A400/A500

const DEVICE_TYPE_CHIP: Record<string, { bg: string; text: string }> = {
  ps4: { bg: 'rgba(59,130,246,0.15)',  text: '#60A5FA' },  // B400 tint / B400 text
  ps5: { bg: 'rgba(20,184,166,0.15)',  text: '#2DD4BF' },  // T400 tint / T400 text
  vip: { bg: 'rgba(245,158,11,0.15)',  text: '#FBBF24' },  // A400 tint / A400 text
};

function getTypeChip(deviceType: string) {
  return DEVICE_TYPE_CHIP[deviceType.toLowerCase()] ?? { bg: 'rgba(100,116,139,0.12)', text: '#94A3B8' };
}

// ── DeviceCard ─────────────────────────────────────────────────────────────────

export function DeviceCard({ device, session }: DeviceCardProps) {
  const t = useTranslations();
  const borderColor = BORDER_STYLES[device.status] ?? 'border-border';
  const bgColor = STATUS_BG[device.status] ?? '#0D131D';
  const typeChip = getTypeChip(device.device_type);

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
      className={`relative rounded-md border ${borderColor} p-md flex flex-col gap-sm min-h-[120px] transition-shadow duration-base shadow-e1`}
      style={{ backgroundColor: bgColor }}
    >
      {/* Name + status pill */}
      <div className="flex items-start justify-between gap-xs">
        <h3 className="text-h3 text-text flex-1">{device.name}</h3>
        <StatusPill
          status={device.status}
          pulse={device.status === 'busy'}
        />
      </div>

      {/* Device-type chip (PS4 = blue, PS5 = teal, VIP = amber) */}
      <span
        className="self-start text-micro font-semibold uppercase tracking-wider px-xs py-[2px] rounded-xs"
        style={{ backgroundColor: typeChip.bg, color: typeChip.text }}
      >
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
