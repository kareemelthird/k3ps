/**
 * Device grid — M3 (design spec §M3). The home screen of the counter app.
 * Glanceable: free/busy/maintenance at a glance, live timers from started_at.
 * Start session: tap free card → StartSessionSheet (bottom sheet).
 * Open detail: tap busy card → session/[id].
 * Grid refresh: 20s. Busy-card timer ticks 30s on grid (1s on detail screen).
 */
import React, { useMemo, useState } from 'react';
import {
  FlatList,
  Pressable,
  SafeAreaView,
  StyleSheet,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { nowIso } from '@ps/core';
import type { Device, Session } from '@ps/core';

import { useDevices, useActiveSessions, useStartSession } from '../../src/features/devices/api';
import { useBranches, resolveOpenRate } from '../../src/features/auth/api';
import { useAuth } from '../../src/stores/useAuth';
import { colors, spacing, radius, TAP_TARGET } from '../../src/design/tokens';
import { AppText } from '../../src/components/AppText';
import { Button } from '../../src/components/Button';
import { ConfirmDialog } from '../../src/components/ConfirmDialog';
import { DeviceCard } from '../../src/components/DeviceCard';
import { DeviceCardSkeleton } from '../../src/components/Skeleton';
import { EmptyState } from '../../src/components/EmptyState';
import { ErrorState } from '../../src/components/ErrorState';
import { OfflineBanner } from '../../src/components/OfflineBanner';
import { SegmentedControl } from '../../src/components/SegmentedControl';
import { Sheet } from '../../src/components/Sheet';

export default function DevicesScreen() {
  const { t } = useTranslation();
  const { claim, user, activeBranchId, setActiveBranch } = useAuth();
  const tenantId = claim?.tenant_id ?? null;
  const branchId = activeBranchId;

  const {
    data: devices,
    isLoading: devicesLoading,
    error: devicesError,
    refetch: refetchDevices,
  } = useDevices(tenantId, branchId);

  const {
    data: activeSessions,
    isLoading: sessionsLoading,
    refetch: refetchSessions,
  } = useActiveSessions(tenantId, branchId);

  const { mutateAsync: startSession } = useStartSession();
  const { data: branches } = useBranches(tenantId);

  // Start session sheet state
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null);
  const [playMode, setPlayMode] = useState<'single' | 'multi'>('single');
  const [startLoading, setStartLoading] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  // Branch switcher sheet
  const [branchSheetVisible, setBranchSheetVisible] = useState(false);

  // Build a map: deviceId → active session
  const sessionByDevice = useMemo(() => {
    const map = new Map<string, Session>();
    activeSessions?.forEach((s) => map.set(s.device_id, s));
    return map;
  }, [activeSessions]);

  const handleCardPress = (device: Device) => {
    if (device.status === 'free') {
      setSelectedDevice(device);
      setPlayMode('single');
      setStartError(null);
    } else if (device.status === 'busy') {
      const session = sessionByDevice.get(device.id);
      if (session) {
        router.push(`/(operate)/session/${session.id}`);
      }
    }
  };

  const handleStartConfirm = async () => {
    if (!selectedDevice || !tenantId || !branchId || !user) return;
    setStartLoading(true);
    setStartError(null);

    try {
      const rateInfo = await resolveOpenRate(
        tenantId,
        selectedDevice.device_type,
        playMode,
        nowIso(),
      );

      await startSession({
        deviceId: selectedDevice.id,
        playMode,
        tenantId,
        branchId,
        managerId: user.id,
        pricePerHourSnapshot: rateInfo.pricePerHour,
        rateRuleId: rateInfo.ruleId,
      });

      setSelectedDevice(null);
    } catch {
      setStartError(t('session.start.error.busy'));
    } finally {
      setStartLoading(false);
    }
  };

  const busyCount = devices?.filter((d) => d.status === 'busy').length ?? 0;
  const freeCount = devices?.filter((d) => d.status === 'free').length ?? 0;
  const isLoading = devicesLoading || sessionsLoading;

  return (
    <SafeAreaView style={styles.screen}>
      <OfflineBanner />

      {/* Header */}
      <View style={styles.header}>
        <Pressable
          onPress={() => setBranchSheetVisible(true)}
          accessibilityLabel={t('branch.choose.title')}
          accessibilityRole="button"
          hitSlop={8}
        >
          <AppText role="h3" color={colors.primary}>
            {branches?.find((b) => b.id === branchId)?.name ?? '...'}
          </AppText>
        </Pressable>

        <Button
          variant="ghost"
          size="md"
          onPress={async () => {
            const { supabase: sb } = await import('../../src/lib/supabase');
            await sb.auth.signOut();
          }}
          accessibilityLabel={t('auth.signOut')}
        >
          {t('auth.signOut')}
        </Button>
      </View>

      {/* Summary strip */}
      {!isLoading && (devices?.length ?? 0) > 0 && (
        <View style={styles.summary}>
          <AppText role="label" color={colors.statusBusy}>
            {busyCount} {t('device.status.busy')}
          </AppText>
          <AppText role="label" color={colors.textFaint}>
            {' · '}
          </AppText>
          <AppText role="label" color={colors.statusFree}>
            {freeCount} {t('device.status.free')}
          </AppText>
        </View>
      )}

      {/* Content */}
      {isLoading && (
        <View style={styles.grid}>
          {[1, 2, 3, 4].map((i) => (
            <View key={i} style={styles.gridItem}>
              <DeviceCardSkeleton />
            </View>
          ))}
        </View>
      )}

      {devicesError && !isLoading && (
        <ErrorState
          message={t('state.error.generic')}
          onRetry={() => { void refetchDevices(); void refetchSessions(); }}
          retryLabel={t('action.retry')}
        />
      )}

      {!isLoading && !devicesError && (devices?.length ?? 0) === 0 && (
        <EmptyState
          title={t('devices.empty.title')}
          body={t('devices.empty.body')}
        />
      )}

      {!isLoading && !devicesError && (devices?.length ?? 0) > 0 && (
        <FlatList
          data={devices}
          keyExtractor={(d) => d.id}
          numColumns={2}
          contentContainerStyle={styles.grid}
          columnWrapperStyle={styles.row}
          renderItem={({ item }) => {
            const session = sessionByDevice.get(item.id);
            return (
              <View style={styles.gridItem}>
                <DeviceCard
                  device={item}
                  session={
                    session
                      ? { startedAt: session.started_at }
                      : undefined
                  }
                  onPress={() => handleCardPress(item)}
                  gridTickMs={30_000}
                />
              </View>
            );
          }}
        />
      )}

      {/* Start Session Sheet */}
      <Sheet
        visible={Boolean(selectedDevice)}
        onClose={() => setSelectedDevice(null)}
        title={`${t('session.start.title')} — ${selectedDevice?.name ?? ''}`}
      >
        <SegmentedControl
          options={[
            { value: 'open', label: t('billingMode.open'), disabled: false },
          ]}
          value="open"
          onChange={() => {}}
        />

        <SegmentedControl
          options={[
            { value: 'single', label: t('playMode.single') },
            { value: 'multi', label: t('playMode.multi') },
          ]}
          value={playMode}
          onChange={(v) => setPlayMode(v as 'single' | 'multi')}
        />

        {startError && (
          <View accessibilityRole="alert" accessible>
            <AppText role="caption" color={colors.danger}>
              {startError}
            </AppText>
          </View>
        )}

        <Button
          variant="primary"
          size="lg"
          fullWidth
          loading={startLoading}
          onPress={handleStartConfirm}
          accessibilityLabel={t('session.start.confirm')}
        >
          {t('session.start.confirm')}
        </Button>
      </Sheet>

      {/* Branch switcher sheet */}
      <Sheet
        visible={branchSheetVisible}
        onClose={() => setBranchSheetVisible(false)}
        title={t('branch.choose.title')}
      >
        {branches?.map((branch) => (
          <Pressable
            key={branch.id}
            onPress={async () => {
              await setActiveBranch(branch.id);
              setBranchSheetVisible(false);
            }}
            style={[
              styles.branchRow,
              branch.id === branchId && styles.branchRowActive,
            ]}
            accessibilityRole="button"
            accessibilityLabel={branch.name}
            accessibilityState={{ selected: branch.id === branchId }}
          >
            <AppText role="h3">{branch.name}</AppText>
            {branch.id === branchId && (
              <AppText role="caption" color={colors.primary}>
                ✓
              </AppText>
            )}
          </Pressable>
        ))}
      </Sheet>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
  },
  grid: {
    padding: spacing.md,
    gap: spacing.sm,
  },
  row: {
    gap: spacing.sm,
  },
  gridItem: {
    flex: 1,
  },
  branchRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface2,
    minHeight: TAP_TARGET,
  },
  branchRowActive: {
    borderWidth: 1.5,
    borderColor: colors.primary,
  },
});
