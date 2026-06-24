/**
 * Device grid — Phase 4 (ACs 33–35, 39, 44–46).
 *
 * Start session: tap free card → StartSessionSheet.
 *   - Billing mode picker: open / prepaid / fixed_match (AC 33, 34).
 *   - Play-mode picker: single / multi.
 *   - Prepaid: lock prepaid_total at purchase, advisory prepaid_minutes (Decision 6).
 *   - Fixed-match: record initial match_count=0, locked price snapshot (Decision 7).
 *   - Busy-device guard: the DB partial-unique index prevents double-session (AC 39).
 *
 * All strings via t('key'). No hardcoded Arabic. RTL via I18nManager (set at root).
 * Money via formatEgp + toArabicDigits. No inline math.
 */
import React, { useMemo, useState } from 'react';
import {
  FlatList,
  Pressable,
  SafeAreaView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';

import {
  egpToPiastres,
  formatEgp,
  nowIso,
  toArabicDigits,
  type BillingMode,
} from '@ps/core';
import type { Device, Session } from '@ps/core';

import { useDevices, useActiveSessions, useStartSession } from '../../src/features/devices/api';
import { useBranches, fetchAndResolveRule } from '../../src/features/auth/api';
import { useAuth } from '../../src/stores/useAuth';
import { colors, spacing, radius, TAP_TARGET, fontSize } from '../../src/design/tokens';
import { AppText } from '../../src/components/AppText';
import { Button } from '../../src/components/Button';
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

  // ── Start session sheet state ─────────────────────────────────────────────

  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null);
  const [billingMode, setBillingMode] = useState<BillingMode>('open');
  const [playMode, setPlayMode] = useState<'single' | 'multi'>('single');

  // Prepaid fields
  const [prepaidEgp, setPrepaidEgp] = useState<string>('');
  const [prepaidMinutes, setPrepaidMinutes] = useState<string>('');

  const [startLoading, setStartLoading] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  // Branch switcher sheet
  const [branchSheetVisible, setBranchSheetVisible] = useState(false);

  // ── Build a map: deviceId → active session ────────────────────────────────

  const sessionByDevice = useMemo(() => {
    const map = new Map<string, Session>();
    activeSessions?.forEach((s) => map.set(s.device_id, s));
    return map;
  }, [activeSessions]);

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleCardPress = (device: Device) => {
    if (device.status === 'free') {
      setSelectedDevice(device);
      setBillingMode('open');
      setPlayMode('single');
      setPrepaidEgp('');
      setPrepaidMinutes('');
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
      const atIso = nowIso();

      // Resolve the rate rule for this billing mode + play mode + device type.
      const rateInfo = await fetchAndResolveRule(
        tenantId,
        selectedDevice.device_type,
        playMode,
        billingMode,
        atIso,
      );

      // Build billing-mode-specific extras.
      let prepaidTotal: number | null = null;
      let prepaidMinutesNum: number | null = null;

      if (billingMode === 'prepaid') {
        // Lock prepaid_total at purchase in piastres (AC 34 / Decision 6).
        const egp = parseFloat(prepaidEgp.replace(',', '.'));
        if (!isNaN(egp) && egp > 0) {
          prepaidTotal = egpToPiastres(egp);
        } else {
          // If user didn't enter a price, use the resolved rule's block_price.
          prepaidTotal = rateInfo.rule?.block_price ?? 0;
        }
        const mins = parseInt(prepaidMinutes, 10);
        prepaidMinutesNum = isNaN(mins) ? (rateInfo.rule?.block_minutes ?? null) : mins;
      }

      // For fixed_match the locked unit price comes from the resolved rule's
      // fixed_match_price, stored on the first segment as price_per_hour_snapshot
      // (ADR-0005 Decision 7).
      const pricePerHourSnapshot =
        billingMode === 'fixed_match'
          ? (rateInfo.rule?.fixed_match_price ?? 0)
          : billingMode === 'prepaid'
            ? (prepaidTotal ?? 0)
            : (rateInfo.pricePerHour ?? 0);

      await startSession({
        deviceId: selectedDevice.id,
        playMode,
        billingMode,
        tenantId,
        branchId,
        managerId: user.id,
        pricePerHourSnapshot,
        rateRuleId: rateInfo.ruleId,
        prepaidTotal: billingMode === 'prepaid' ? prepaidTotal : undefined,
        prepaidMinutes: billingMode === 'prepaid' ? prepaidMinutesNum : undefined,
        matchCount: billingMode === 'fixed_match' ? 0 : undefined,
      });

      setSelectedDevice(null);
    } catch {
      setStartError(t('session.start.error.generic'));
    } finally {
      setStartLoading(false);
    }
  };

  const busyCount = devices?.filter((d) => d.status === 'busy').length ?? 0;
  const freeCount = devices?.filter((d) => d.status === 'free').length ?? 0;
  const isLoading = devicesLoading || sessionsLoading;

  // ── Billing mode options ──────────────────────────────────────────────────

  const billingModeOptions = [
    { value: 'open', label: t('billingMode.open') },
    { value: 'prepaid', label: t('billingMode.prepaid') },
    { value: 'fixed_match', label: t('billingMode.fixed_match') },
  ];

  const playModeOptions = [
    { value: 'single', label: t('playMode.single') },
    { value: 'multi', label: t('playMode.multi') },
  ];

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
            {toArabicDigits(String(busyCount))} {t('device.status.busy')}
          </AppText>
          <AppText role="label" color={colors.textFaint}>
            {' · '}
          </AppText>
          <AppText role="label" color={colors.statusFree}>
            {toArabicDigits(String(freeCount))} {t('device.status.free')}
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

      {/* ── Start Session Sheet ─────────────────────────────────────────────── */}
      <Sheet
        visible={Boolean(selectedDevice)}
        onClose={() => setSelectedDevice(null)}
        title={`${t('session.start.title')} — ${selectedDevice?.name ?? ''}`}
      >
        {/* Billing mode picker */}
        <SegmentedControl
          options={billingModeOptions}
          value={billingMode}
          onChange={(v) => setBillingMode(v as BillingMode)}
        />

        {/* Play mode picker — not applicable for fixed_match or prepaid (optional) */}
        {billingMode !== 'fixed_match' && (
          <SegmentedControl
            options={playModeOptions}
            value={playMode}
            onChange={(v) => setPlayMode(v as 'single' | 'multi')}
          />
        )}

        {/* Prepaid extra fields */}
        {billingMode === 'prepaid' && (
          <View style={styles.extraFields}>
            <AppText role="label" color={colors.textMuted}>
              {t('session.start.prepaid.label')}
            </AppText>
            <TextInput
              style={styles.input}
              value={prepaidEgp}
              onChangeText={setPrepaidEgp}
              placeholder={t('session.start.prepaid.placeholder')}
              placeholderTextColor={colors.textFaint}
              keyboardType="decimal-pad"
              accessibilityLabel={t('session.start.prepaid.label')}
            />
            <AppText role="caption" color={colors.textFaint}>
              {t('session.start.prepaid.minutes')}
            </AppText>
            <TextInput
              style={styles.input}
              value={prepaidMinutes}
              onChangeText={setPrepaidMinutes}
              placeholder="٦٠"
              placeholderTextColor={colors.textFaint}
              keyboardType="number-pad"
              accessibilityLabel={t('session.start.prepaid.minutes')}
            />
          </View>
        )}

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
          onPress={() => void handleStartConfirm()}
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
                {'✓'}
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
  extraFields: {
    gap: spacing.sm,
  },
  input: {
    backgroundColor: colors.surface3,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.text,
    fontSize: fontSize.body,
    minHeight: TAP_TARGET,
    textAlign: 'right',
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
