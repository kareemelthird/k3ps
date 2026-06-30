/**
 * Device grid — Slice 1 additions on top of Phase 4 (ACs 33–35, 39, 44–46).
 *
 * New in Slice 1:
 *   4. Search by device name.
 *   5. Filter chips: by type (All/PS4/PS5/VIP/…) and status.
 *   6. Triage sort: prepaid-ending-soon first (≤5 min), then busy, free, maintenance.
 *   7. "Ending soon" attention strip (tappable to filter).
 *   8. Quick-Start: ⚡ button on free cards uses last-used billing+play mode;
 *      falls back to the full start sheet if no saved prefs or no rule resolves.
 *   9. Busy cards show live remaining time + prepaid usage bar via DeviceCard.
 *
 * Start session: tap free card → StartSessionSheet (unchanged from Phase 4).
 * All strings via t('key'). No hardcoded Arabic. RTL via I18nManager (set at root).
 * Money via formatEgp + toArabicDigits. No inline math.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';

import {
  egpToPiastres,
  elapsedMinutes,
  formatEgp,
  nowIso,
  resolveRule,
  toArabicDigits,
  type BillingMode,
  type RateRule,
} from '@ps/core';
import type { Device, Session } from '@ps/core';

import { useDevices, useActiveSessions, useStartSession } from '../../src/features/devices/api';
import { useBranches, fetchAndResolveRule } from '../../src/features/auth/api';
import { useOpenShift } from '../../src/features/shifts/api';
import { useAuth } from '../../src/stores/useAuth';
import { useRateRules } from '../../src/features/session/api';
import {
  loadStartPrefs,
  saveStartPrefs,
  type StartPrefs,
} from '../../src/stores/useLastStartPrefs';
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

// Threshold for "ending soon" attention (minutes).
const ENDING_SOON_THRESHOLD = 5;

// ─── Helper: remaining prepaid minutes ────────────────────────────────────────

function remainingPrepaidMinutes(session: Session): number | null {
  if (session.billing_mode !== 'prepaid' || !session.prepaid_minutes) return null;
  const elapsed = elapsedMinutes(session.started_at);
  return Math.max(0, session.prepaid_minutes - elapsed);
}

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
  const { data: openShift } = useOpenShift(tenantId, branchId);
  const { data: rateRules = [] } = useRateRules(tenantId);

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

  // ── Slice 1: search + filter state ───────────────────────────────────────

  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'free' | 'busy' | 'maintenance'>('all');
  const [showEndingSoonOnly, setShowEndingSoonOnly] = useState(false);

  // Saved last-used prefs for quick-start
  const [savedPrefs, setSavedPrefs] = useState<StartPrefs | null>(null);

  useEffect(() => {
    void loadStartPrefs().then(setSavedPrefs);
  }, []);

  // ── Build a map: deviceId → active session ────────────────────────────────

  const sessionByDevice = useMemo(() => {
    const map = new Map<string, Session>();
    activeSessions?.forEach((s) => map.set(s.device_id, s));
    return map;
  }, [activeSessions]);

  // ── Derive unique device types from the device list ───────────────────────

  const deviceTypes = useMemo(() => {
    const types = new Set<string>();
    (devices ?? []).forEach((d) => types.add(d.device_type));
    return Array.from(types).sort();
  }, [devices]);

  // ── Compute ending-soon count ─────────────────────────────────────────────

  const endingSoonCount = useMemo(() => {
    let count = 0;
    activeSessions?.forEach((s) => {
      const rem = remainingPrepaidMinutes(s);
      if (rem !== null && rem <= ENDING_SOON_THRESHOLD) count++;
    });
    return count;
  }, [activeSessions]);

  // ── Filtered + sorted device list ─────────────────────────────────────────

  const processedDevices = useMemo(() => {
    let list = devices ?? [];

    // Text search
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      list = list.filter((d) => d.name.toLowerCase().includes(q));
    }

    // Type filter
    if (typeFilter) {
      list = list.filter((d) => d.device_type === typeFilter);
    }

    // Status filter
    if (statusFilter !== 'all') {
      list = list.filter((d) => d.status === statusFilter);
    }

    // Ending-soon filter
    if (showEndingSoonOnly) {
      list = list.filter((d) => {
        const session = sessionByDevice.get(d.id);
        if (!session) return false;
        const rem = remainingPrepaidMinutes(session);
        return rem !== null && rem <= ENDING_SOON_THRESHOLD;
      });
    }

    // Triage sort: ending-soon prepaid → other busy → free → maintenance
    list = [...list].sort((a, b) => {
      const priority = (dev: Device): number => {
        if (dev.status === 'maintenance') return 30;
        if (dev.status === 'free') return 20;
        // busy
        const session = sessionByDevice.get(dev.id);
        if (!session) return 15;
        const rem = remainingPrepaidMinutes(session);
        if (rem !== null && rem <= ENDING_SOON_THRESHOLD) return 0; // highest
        return 10; // other busy
      };
      return priority(a) - priority(b);
    });

    return list;
  }, [devices, searchQuery, typeFilter, statusFilter, showEndingSoonOnly, sessionByDevice]);

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

  /**
   * Quick-start: uses savedPrefs to start the session without opening the sheet.
   * Falls back to the full sheet if no prefs or no rule resolves.
   */
  const handleQuickStart = async (device: Device) => {
    if (!savedPrefs || !tenantId || !branchId || !user) {
      // No saved prefs → open the full sheet
      handleCardPress(device);
      return;
    }

    setStartLoading(true);
    setStartError(null);
    try {
      const atIso = nowIso();
      const rateInfo = await fetchAndResolveRule(
        tenantId,
        device.device_type,
        savedPrefs.playMode,
        savedPrefs.billingMode,
        atIso,
      );

      // If no rule resolved for the saved prefs, fall back to the full sheet.
      if (!rateInfo.rule && savedPrefs.billingMode !== 'open') {
        handleCardPress(device);
        return;
      }

      const pricePerHourSnapshot =
        savedPrefs.billingMode === 'fixed_match'
          ? (rateInfo.rule?.fixed_match_price ?? 0)
          : (rateInfo.pricePerHour ?? 0);

      await startSession({
        deviceId: device.id,
        playMode: savedPrefs.playMode,
        billingMode: savedPrefs.billingMode,
        tenantId,
        branchId,
        managerId: user.id,
        pricePerHourSnapshot,
        rateRuleId: rateInfo.ruleId,
        shiftId: openShift?.id ?? null,
      });
    } catch {
      // Fall through to open the full sheet on error
      handleCardPress(device);
    } finally {
      setStartLoading(false);
    }
  };

  const handleStartConfirm = async () => {
    if (!selectedDevice || !tenantId || !branchId || !user) return;
    setStartLoading(true);
    setStartError(null);

    try {
      const atIso = nowIso();

      const rateInfo = await fetchAndResolveRule(
        tenantId,
        selectedDevice.device_type,
        playMode,
        billingMode,
        atIso,
      );

      let prepaidTotal: number | null = null;
      let prepaidMinutesNum: number | null = null;

      if (billingMode === 'prepaid') {
        const egp = parseFloat(prepaidEgp.replace(',', '.'));
        if (!isNaN(egp) && egp > 0) {
          prepaidTotal = egpToPiastres(egp);
        } else {
          prepaidTotal = rateInfo.rule?.block_price ?? 0;
        }
        const mins = parseInt(prepaidMinutes, 10);
        prepaidMinutesNum = isNaN(mins) ? (rateInfo.rule?.block_minutes ?? null) : mins;
      }

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
        shiftId: openShift?.id ?? null,
      });

      // Save prefs for quick-start
      await saveStartPrefs({ billingMode, playMode });
      setSavedPrefs({ billingMode, playMode });

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

  const statusFilterOptions: { value: typeof statusFilter; label: string }[] = [
    { value: 'all', label: t('devices.filter.all') },
    { value: 'free', label: t('devices.filter.free') },
    { value: 'busy', label: t('devices.filter.busy') },
    { value: 'maintenance', label: t('devices.filter.maintenance') },
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

      {/* Search input */}
      <View style={styles.searchRow}>
        <TextInput
          style={styles.searchInput}
          value={searchQuery}
          onChangeText={setSearchQuery}
          placeholder={t('devices.search.placeholder')}
          placeholderTextColor={colors.textFaint}
          accessibilityLabel={t('devices.search.placeholder')}
          returnKeyType="search"
          clearButtonMode="while-editing"
        />
      </View>

      {/* Ending-soon attention strip */}
      {endingSoonCount > 0 && (
        <Pressable
          style={[
            styles.endingSoonStrip,
            showEndingSoonOnly && styles.endingSoonStripActive,
          ]}
          onPress={() => setShowEndingSoonOnly((v) => !v)}
          accessibilityRole="button"
          accessibilityLabel={t('devices.endingSoon.strip', {
            countDisplay: toArabicDigits(String(endingSoonCount)),
          })}
          accessibilityState={{ selected: showEndingSoonOnly }}
        >
          <AppText role="label" color={colors.danger}>
            {'⚠ '}
            {t('devices.endingSoon.strip', {
              countDisplay: toArabicDigits(String(endingSoonCount)),
            })}
          </AppText>
          <AppText role="micro" color={showEndingSoonOnly ? colors.primary : colors.textMuted}>
            {showEndingSoonOnly ? t('devices.filter.all') : t('devices.endingSoon.show')}
          </AppText>
        </Pressable>
      )}

      {/* Status filter chips */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filterRow}
      >
        {statusFilterOptions.map((opt) => (
          <Pressable
            key={opt.value}
            onPress={() => setStatusFilter(opt.value)}
            style={[
              styles.chip,
              statusFilter === opt.value && styles.chipActive,
            ]}
            accessibilityRole="button"
            accessibilityLabel={opt.label}
            accessibilityState={{ selected: statusFilter === opt.value }}
          >
            <AppText
              role="caption"
              color={statusFilter === opt.value ? colors.onPrimary : colors.textMuted}
            >
              {opt.label}
            </AppText>
          </Pressable>
        ))}

        {/* Type filter chips (only when >1 type present) */}
        {deviceTypes.length > 1 && (
          <>
            <View style={styles.chipDivider} />
            {deviceTypes.map((type) => (
              <Pressable
                key={type}
                onPress={() => setTypeFilter(typeFilter === type ? '' : type)}
                style={[
                  styles.chip,
                  typeFilter === type && styles.chipActive,
                ]}
                accessibilityRole="button"
                accessibilityLabel={type}
                accessibilityState={{ selected: typeFilter === type }}
              >
                <AppText
                  role="caption"
                  color={typeFilter === type ? colors.onPrimary : colors.textMuted}
                >
                  {type}
                </AppText>
              </Pressable>
            ))}
          </>
        )}
      </ScrollView>

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
          data={processedDevices}
          keyExtractor={(d) => d.id}
          numColumns={2}
          contentContainerStyle={styles.grid}
          columnWrapperStyle={styles.row}
          ListEmptyComponent={
            <EmptyState
              title={t('devices.empty.title')}
              body={t('devices.empty.body')}
            />
          }
          renderItem={({ item }) => {
            const session = sessionByDevice.get(item.id);
            const isFree = item.status === 'free';
            return (
              <View style={styles.gridItem}>
                <DeviceCard
                  device={item}
                  session={
                    session
                      ? {
                          startedAt: session.started_at,
                          billingMode: session.billing_mode,
                          prepaidMinutes: session.prepaid_minutes,
                        }
                      : undefined
                  }
                  onPress={() => handleCardPress(item)}
                  onQuickStart={isFree ? () => void handleQuickStart(item) : undefined}
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

        {/* Play mode picker — not applicable for fixed_match */}
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
  searchRow: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },
  searchInput: {
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
  endingSoonStrip: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginHorizontal: spacing.xl,
    marginBottom: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    backgroundColor: colors.surface,
    borderRadius: radius.xs,
    borderWidth: 1,
    borderColor: colors.danger,
  },
  endingSoonStripActive: {
    borderColor: colors.primary,
  },
  filterRow: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.sm,
    gap: spacing.xs,
    flexDirection: 'row',
  },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
    backgroundColor: colors.surface3,
    minHeight: 36,
    justifyContent: 'center',
  },
  chipActive: {
    backgroundColor: colors.primary,
  },
  chipDivider: {
    width: 1,
    backgroundColor: colors.border,
    marginHorizontal: spacing['2xs'],
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
