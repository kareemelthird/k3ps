/**
 * DeviceCard — design system §9.11.
 * Glanceable grid cell: free / busy / maintenance.
 * - Free: status-free border + dot + "tap to start" affordance + quick-start button.
 * - Busy: status-busy border + LiveTimer (grid tickMs) + running total.
 *   - Prepaid: live remaining time countdown + usage bar (turns red at ≤5 min).
 * - Maintenance: muted, non-interactive.
 *
 * Status is conveyed by pill + dot + border, NEVER color alone.
 * Money is via formatEgp (integer piastres). Timer from started_at.
 * Tap target ≥52 (the whole card).
 *
 * Slice 1 additions:
 *   - onQuickStart prop: rendered as an "⚡ بدء سريع" button on free cards.
 *   - session.prepaidMinutes + session.billingMode: drives prepaid countdown + bar.
 */
import React, { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { elapsedMinutes, formatEgp, toArabicDigits } from '@ps/core';
import type { Device } from '@ps/core';

import { colors, radius, spacing, TAP_TARGET } from '../design/tokens';
import { AppText } from './AppText';
import { LiveTimer } from './LiveTimer';
import { StatusPill } from './StatusPill';
import { useTick } from '../hooks/useTick';

interface SessionInfo {
  startedAt: string;
  runningTotalPiastres?: number;
  /** 'open' | 'prepaid' | 'fixed_match' — drives prepaid countdown visibility. */
  billingMode?: string;
  /** Advisory prepaid minutes (from session row). Drives the usage bar. */
  prepaidMinutes?: number | null;
}

interface Props {
  device: Device;
  session?: SessionInfo;
  onPress?: () => void;
  /** Called when the quick-start button is tapped on a free card. */
  onQuickStart?: () => void;
  /** Grid tick interval; null disables live timer (off-screen). */
  gridTickMs?: number;
}

// ─── Prepaid remaining display (countdown + usage bar) ───────────────────────

function PrepaidRemaining({
  startedAt,
  prepaidMinutes,
  tickMs,
}: {
  startedAt: string;
  prepaidMinutes: number;
  tickMs: number;
}) {
  const { t } = useTranslation();
  // Tick forces re-render — cost/time is always derived from timestamps.
  useTick(tickMs);

  const elapsed = elapsedMinutes(startedAt);
  const remaining = Math.max(0, prepaidMinutes - elapsed);
  const remainingRounded = Math.ceil(remaining);
  const isEndingSoon = remaining <= 5;
  const fraction = prepaidMinutes > 0
    ? Math.min(1, elapsed / prepaidMinutes)
    : 0;

  const barColor = isEndingSoon ? colors.danger : colors.statusBusy;

  return (
    <View style={prepStyles.container}>
      {/* Usage bar */}
      <View style={prepStyles.track}>
        <View
          style={[prepStyles.fill, { width: `${Math.round(fraction * 100)}%`, backgroundColor: barColor }]}
        />
      </View>
      {/* Remaining text */}
      <AppText
        role="micro"
        color={isEndingSoon ? colors.danger : colors.textMuted}
        accessibilityRole="text"
      >
        {isEndingSoon
          ? t('session.prepaid.endingSoon')
          : t('session.prepaid.remaining', {
              minutes: toArabicDigits(String(remainingRounded)),
            })}
      </AppText>
    </View>
  );
}

const prepStyles = StyleSheet.create({
  container: {
    gap: 4,
  },
  track: {
    height: 4,
    backgroundColor: colors.surface3,
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  fill: {
    height: 4,
    borderRadius: radius.pill,
  },
});

// ─── Device-type chip palette (mirrors apps/web device-type chips) ───────────
// A tinted pill makes the device class glanceable; color alone never conveys
// status (that is the pill + dot + border) — this is purely categorical.
const TYPE_CHIP: Record<string, { bg: string; fg: string }> = {
  PS4: { bg: 'rgba(59,130,246,0.16)', fg: '#60A5FA' }, // blue
  PS5: { bg: 'rgba(20,184,166,0.16)', fg: '#2DD4BF' }, // teal
  VIP: { bg: 'rgba(245,158,11,0.16)', fg: '#FBBF24' }, // amber
};
const TYPE_CHIP_DEFAULT = { bg: 'rgba(148,163,184,0.16)', fg: colors.textMuted };

function typeChip(deviceType: string) {
  return TYPE_CHIP[deviceType?.toUpperCase?.()] ?? TYPE_CHIP_DEFAULT;
}

// Status-tinted card fill — a calm wash so free/busy/maint read at a glance,
// reinforcing (never replacing) the pill + border. Mirrors the web uplift.
const STATUS_FILL: Record<'free' | 'busy' | 'maintenance', string> = {
  free: '#0C1A17',
  busy: '#0F1726',
  maintenance: '#12151C',
};

// ─── DeviceCard ───────────────────────────────────────────────────────────────

export function DeviceCard({
  device,
  session,
  onPress,
  onQuickStart,
  gridTickMs = 30_000,
}: Props) {
  const { t } = useTranslation();
  const isMaintenance = device.status === 'maintenance';
  const isBusy = device.status === 'busy';
  const isFree = device.status === 'free';

  const borderColor = isFree
    ? colors.statusFree
    : isBusy
      ? colors.statusBusy
      : colors.statusMaint;

  const statusLabel = isFree
    ? t('device.status.free')
    : isBusy
      ? t('device.status.busy')
      : t('device.status.maintenance');

  const statusKey: 'free' | 'busy' | 'maintenance' = device.status;

  const accessibilityLabel = [
    device.name,
    statusLabel,
    isBusy && session
      ? `${t('session.startedAt')} ${session.startedAt}`
      : null,
  ]
    .filter(Boolean)
    .join(' — ');

  const isPrepaid =
    isBusy && session?.billingMode === 'prepaid' && (session.prepaidMinutes ?? 0) > 0;

  return (
    <Pressable
      onPress={isMaintenance ? undefined : onPress}
      disabled={isMaintenance}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled: isMaintenance }}
      style={({ pressed }) => [
        styles.card,
        {
          borderColor,
          backgroundColor: STATUS_FILL[statusKey],
          opacity: isMaintenance ? 0.6 : pressed ? 0.9 : 1,
          transform: [{ scale: pressed && !isMaintenance ? 0.97 : 1 }],
        },
      ]}
    >
      {/* Header row: name + type chip */}
      <View style={styles.header}>
        <AppText role="h3" numberOfLines={1} style={styles.name}>
          {device.name}
        </AppText>
        <View style={[styles.typeChip, { backgroundColor: typeChip(device.device_type).bg }]}>
          <AppText role="micro" color={typeChip(device.device_type).fg}>
            {device.device_type}
          </AppText>
        </View>
      </View>

      {/* Status pill */}
      <StatusPill
        status={statusKey}
        label={statusLabel}
        dot
        pulse={isBusy}
      />

      {/* Content area: free hint / busy timer + total / maintenance note */}
      <View style={styles.content}>
        {isFree && (
          <View style={styles.freeContent}>
            <AppText role="caption" color={colors.textFaint}>
              {t('session.start.confirm')}
            </AppText>
            {/* Quick-start button — only shown when handler is provided */}
            {onQuickStart && (
              <Pressable
                onPress={(e) => {
                  // Stop propagation so the card's onPress doesn't fire too
                  e.stopPropagation?.();
                  onQuickStart();
                }}
                style={({ pressed }) => [
                  styles.quickBtn,
                  pressed && styles.quickBtnPressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel={t('session.quickStart.label')}
                hitSlop={4}
              >
                <AppText role="micro" color={colors.onPrimary}>
                  {'⚡ '}{t('session.quickStart.label')}
                </AppText>
              </Pressable>
            )}
          </View>
        )}

        {isBusy && session && (
          <View style={styles.busyContent}>
            <LiveTimer
              startedAt={session.startedAt}
              size="sm"
              tickMs={gridTickMs}
            />
            {session.runningTotalPiastres !== undefined && (
              <AppText role="money" color={colors.primary}>
                {formatEgp(session.runningTotalPiastres)}
              </AppText>
            )}
            {/* Prepaid countdown + usage bar */}
            {isPrepaid && session.prepaidMinutes != null && (
              <PrepaidRemaining
                startedAt={session.startedAt}
                prepaidMinutes={session.prepaidMinutes}
                tickMs={gridTickMs}
              />
            )}
          </View>
        )}

        {isMaintenance && (
          <AppText role="caption" color={colors.statusMaint}>
            {t('device.status.maintenance')}
          </AppText>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1.5,
    padding: spacing.md,
    gap: spacing.xs,
    minHeight: TAP_TARGET * 2.2,
    // Subtle elevation for depth (mirrors web e1); no-op where unsupported.
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
  typeChip: {
    borderRadius: radius.xs,
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  name: {
    flex: 1,
    marginEnd: spacing.xs,
  },
  content: {
    marginTop: spacing['2xs'],
  },
  freeContent: {
    gap: spacing.xs,
  },
  busyContent: {
    gap: spacing.xs,
  },
  quickBtn: {
    alignSelf: 'stretch',
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    minHeight: 40,
    justifyContent: 'center',
  },
  quickBtnPressed: {
    backgroundColor: colors.primaryPress,
  },
});
