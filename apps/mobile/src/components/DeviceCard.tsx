/**
 * DeviceCard — design system §9.11.
 * Glanceable grid cell: free / busy / maintenance.
 * - Free: status-free border + dot + "tap to start" affordance.
 * - Busy: status-busy border + LiveTimer (grid tickMs) + running total.
 * - Maintenance: muted, non-interactive.
 *
 * Status is conveyed by pill + dot + border, NEVER color alone.
 * Money is via formatEgp (integer piastres). Timer from started_at.
 * Tap target ≥52 (the whole card).
 */
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { formatEgp } from '@ps/core';
import type { Device } from '@ps/core';

import { colors, radius, spacing, TAP_TARGET } from '../design/tokens';
import { AppText } from './AppText';
import { LiveTimer } from './LiveTimer';
import { StatusPill } from './StatusPill';

interface SessionInfo {
  startedAt: string;
  runningTotalPiastres?: number;
}

interface Props {
  device: Device;
  session?: SessionInfo;
  onPress?: () => void;
  /** Grid tick interval; null disables live timer (off-screen). */
  gridTickMs?: number;
}

export function DeviceCard({
  device,
  session,
  onPress,
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
          opacity: isMaintenance ? 0.6 : pressed ? 0.9 : 1,
          transform: [{ scale: pressed && !isMaintenance ? 0.97 : 1 }],
        },
      ]}
    >
      {/* Header row: name + type */}
      <View style={styles.header}>
        <AppText role="h3" numberOfLines={1} style={styles.name}>
          {device.name}
        </AppText>
        <AppText role="caption" color={colors.textMuted}>
          {device.device_type}
        </AppText>
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
          <AppText role="caption" color={colors.textFaint}>
            {t('session.start.confirm')}
          </AppText>
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
    gap: spacing.sm,
    minHeight: TAP_TARGET * 2.2,
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
    marginTop: spacing.xs,
  },
  busyContent: {
    gap: spacing.xs,
  },
});
