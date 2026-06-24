/**
 * Session detail — Phase 4 (ACs 33–42, 44–46).
 *
 * LIVE COST CONTRACT (ADR-0005 Decision 1 — preview-splits, close-materializes):
 *   For open-meter, the live display calls planSegments(rules, ctx, openSeg.started_at, now)
 *   → aggregateOpenMeter over all sub-intervals. No DB write on boundary crossing.
 *   The tick only forces a re-render; cost is always re-derived from timestamps.
 *
 * CLOSE CONTRACT:
 *   planSegments materializes N segment rows at close time. aggregateOpenMeter
 *   sums them. The stored time_total provably equals reconstructTimeCost over
 *   those rows (AC 25, 37, 38).
 *
 * AUDIT (AC 40–42):
 *   One audit_log row per close, idempotent (client UUID + upsert).
 *   amount = grand_total.
 *
 * INVARIANTS (CLAUDE.md §2):
 *   - Integer piastres via @ps/core. No inline money math.
 *   - Timer = elapsedSeconds(startedAt, now), never a counter.
 *   - Cairo TZ via localHm/formatClock.
 *   - All strings via t('key'), Arabic-Indic numerals via toArabicDigits/formatEgp.
 */
import React, { useState } from 'react';
import {
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';

import {
  computeFixedMatchCost,
  computeGrandTotal,
  computePrepaidCost,
  elapsedMinutes,
  formatEgp,
  localHm,
  nowIso,
  reconstructTimeCost,
  toArabicDigits,
  type PlayMode,
  type SegmentPlan,
} from '@ps/core';

import {
  useSessionDetail,
  useRateRules,
  useSwitchPlayMode,
  useCloseSessionPhase4,
  useIncrementMatchCount,
  computeLiveOpenMeterWithType,
  type SegmentRow,
  type SessionRow,
} from '../../../src/features/session/api';
import { useAuth } from '../../../src/stores/useAuth';
import { supabase } from '../../../src/lib/supabase';
import { colors, spacing, radius, fontSize, fontWeight, TAP_TARGET } from '../../../src/design/tokens';
import { AppText } from '../../../src/components/AppText';
import { Button } from '../../../src/components/Button';
import { ConfirmDialog } from '../../../src/components/ConfirmDialog';
import { EmptyState } from '../../../src/components/EmptyState';
import { ErrorState } from '../../../src/components/ErrorState';
import { LiveTimer } from '../../../src/components/LiveTimer';
import { OfflineBanner } from '../../../src/components/OfflineBanner';
import { SegmentedControl } from '../../../src/components/SegmentedControl';
import { Sheet } from '../../../src/components/Sheet';
import { Skeleton } from '../../../src/components/Skeleton';
import { StatusPill } from '../../../src/components/StatusPill';
import { useTick } from '../../../src/hooks/useTick';

// ─── Sub-component: SegmentRow card ──────────────────────────────────────────

interface SegmentCardProps {
  plan: SegmentPlan;
  index: number;
  isLast: boolean;
}

function SegmentCard({ plan, index, isLast }: SegmentCardProps) {
  const { t } = useTranslation();
  const atIso = isLast ? nowIso() : plan.ended_at;

  // Cost for this sub-segment only (not aggregated with min-charge — that's session-level).
  // Display here is informational; grand total on the session card is authoritative.
  // Use @ps/core elapsedMinutes: clamps negative, reuses the same time math as billing
  // (NIT 7 — no inline Date.getTime() math in UI).
  const minutes = Math.round(elapsedMinutes(plan.started_at, atIso));

  return (
    <View style={segStyles.row} accessible accessibilityRole="text">
      <View style={segStyles.left}>
        <AppText role="label" color={colors.primary}>
          {t('session.segments.label', { index: toArabicDigits(String(index)) })}
        </AppText>
        <AppText role="caption" color={colors.textMuted}>
          {toArabicDigits(localHm(plan.started_at))}
          {' — '}
          {isLast ? '...' : toArabicDigits(localHm(plan.ended_at))}
        </AppText>
        <AppText role="micro" color={colors.textFaint}>
          {t('playMode.' + plan.play_mode)}
          {'  '}
          {toArabicDigits(String(minutes))} {t('minutes')}
        </AppText>
      </View>
      <View style={segStyles.right}>
        <AppText role="caption" color={colors.textMuted}>
          {plan.price_per_hour_snapshot > 0
            ? t('rate.perHour', {
                rate: toArabicDigits(
                  formatEgp(plan.price_per_hour_snapshot, false),
                ),
              })
            : t('rate.noRule')}
        </AppText>
      </View>
    </View>
  );
}

const segStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radius.xs,
    backgroundColor: colors.surface2,
  },
  left: { flex: 1, gap: spacing['2xs'] },
  right: { alignItems: 'flex-end' },
});

// ─── Sub-component: Match counter (fixed_match mode) ─────────────────────────

interface MatchCounterProps {
  sessionId: string;
  tenantId: string;
  matchCount: number;
  lockedPrice: number;
  disabled?: boolean;
}

function MatchCounter({ sessionId, tenantId, matchCount, lockedPrice, disabled }: MatchCounterProps) {
  const { t } = useTranslation();
  const { mutateAsync: increment } = useIncrementMatchCount();

  const cost = computeFixedMatchCost({ fixed_match_price: lockedPrice, match_count: matchCount });

  return (
    <View style={ctrStyles.container}>
      <AppText role="label" color={colors.textMuted}>
        {t('session.matchCount.label')}
      </AppText>
      <View style={ctrStyles.row}>
        <Pressable
          onPress={() =>
            void increment({ sessionId, tenantId, currentCount: matchCount, delta: -1 })
          }
          disabled={disabled || matchCount <= 0}
          style={[ctrStyles.btn, (disabled || matchCount <= 0) && ctrStyles.btnDisabled]}
          accessibilityLabel={t('session.matchCount.decrement')}
          accessibilityRole="button"
          hitSlop={8}
        >
          <AppText role="h2" color={disabled || matchCount <= 0 ? colors.textFaint : colors.text}>
            {'−'}
          </AppText>
        </Pressable>

        <View style={ctrStyles.count} accessible accessibilityRole="text">
          <AppText role="h1" color={colors.primary} style={ctrStyles.countText}>
            {toArabicDigits(String(matchCount))}
          </AppText>
        </View>

        <Pressable
          onPress={() =>
            void increment({ sessionId, tenantId, currentCount: matchCount, delta: 1 })
          }
          disabled={disabled}
          style={[ctrStyles.btn, disabled && ctrStyles.btnDisabled]}
          accessibilityLabel={t('session.matchCount.increment')}
          accessibilityRole="button"
          hitSlop={8}
        >
          <AppText role="h2" color={disabled ? colors.textFaint : colors.text}>
            {'+'}
          </AppText>
        </Pressable>
      </View>

      <AppText role="money" color={colors.primary} style={ctrStyles.cost}>
        {formatEgp(cost)}
      </AppText>
    </View>
  );
}

const ctrStyles = StyleSheet.create({
  container: { alignItems: 'center', gap: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.xl },
  btn: {
    width: TAP_TARGET,
    height: TAP_TARGET,
    borderRadius: radius.sm,
    backgroundColor: colors.surface3,
    justifyContent: 'center',
    alignItems: 'center',
  },
  btnDisabled: { opacity: 0.4 },
  count: {
    minWidth: 64,
    alignItems: 'center',
  },
  countText: {
    fontSize: 40,
    fontWeight: '800' as const,
  },
  cost: {
    fontSize: 28,
    fontWeight: '700' as const,
  },
});

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function SessionDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useTranslation();
  const { claim, user } = useAuth();

  const [confirmCloseVisible, setConfirmCloseVisible] = useState(false);
  const [confirmSwitchVisible, setConfirmSwitchVisible] = useState(false);
  const [pendingPlayMode, setPendingPlayMode] = useState<PlayMode | null>(null);
  const [closing, setClosing] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [closedAt, setClosedAt] = useState<string | null>(null);

  const tenantId = claim?.tenant_id ?? null;

  // ── Data ──────────────────────────────────────────────────────────────────

  const {
    data: sessionData,
    isLoading: sessionLoading,
    error: sessionError,
    refetch: refetchSession,
  } = useSessionDetail(id, tenantId);

  const { data: rateRules = [] } = useRateRules(tenantId);

  // Fetch the device row so we know device_type for planSegments resolution.
  // SHOULD-FIX 4: we must NOT coerce a missing device_type to 'any' (a billing
  // wildcard). Actions that call planSegments/resolveRule are disabled until
  // deviceData is confirmed loaded. If the device query errors, we surface an
  // error state rather than silently billing at the wrong rate.
  const deviceId = sessionData?.session.device_id;
  const {
    data: deviceData,
    isLoading: deviceLoading,
    error: deviceError,
  } = useQuery({
    queryKey: ['device', deviceId, tenantId],
    enabled: Boolean(deviceId && tenantId),
    staleTime: 300_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('devices')
        .select('id, device_type, name')
        .eq('id', deviceId)
        .eq('tenant_id', tenantId)
        .single();
      if (error) throw error;
      return data as { id: string; device_type: string; name: string };
    },
  });

  const session = sessionData?.session ?? null;
  const segments = sessionData?.segments ?? [];
  // deviceType is only set when the device row is confirmed loaded.
  // Never falls back to 'any' — callers check deviceReady before using it.
  const deviceType = deviceData?.device_type ?? null;
  // True when the device row is available and device_type is known.
  const deviceReady = Boolean(deviceType);

  // ── Tick to force re-render (never accumulates money — timer derives from timestamps) ──
  useTick(closedAt ? null : 1000);

  // ── Live cost (preview-splits, ADR-0005 Decision 1) ─────────────────────

  const atIso = closedAt ?? nowIso();
  const isClosed = session?.status === 'closed' || Boolean(closedAt);
  const billingMode = session?.billing_mode ?? 'open';

  // Derive live totals per billing mode:
  let liveTotalPiastres = 0;
  let liveSegmentPlans: SegmentPlan[] = [];

  if (session && !isClosed) {
    if (billingMode === 'open') {
      // Guard: only compute live cost when deviceType is known. If deviceData
      // is loading or errored we show 0 until it resolves (SHOULD-FIX 4).
      const { grandTotal, segmentPlans } = deviceType
        ? computeLiveOpenMeterWithType(
            session,
            segments,
            rateRules,
            deviceType,
            atIso,
          )
        : { grandTotal: 0, segmentPlans: [] };
      liveTotalPiastres = grandTotal;
      liveSegmentPlans = segmentPlans;
    } else if (billingMode === 'prepaid') {
      liveTotalPiastres = computePrepaidCost({
        prepaid_total: session.prepaid_total ?? null,
      });
    } else if (billingMode === 'fixed_match') {
      const firstSeg = segments[0];
      liveTotalPiastres = computeGrandTotal({
        time_total: computeFixedMatchCost({
          fixed_match_price: firstSeg?.price_per_hour_snapshot ?? 0,
          match_count: session.match_count ?? 0,
        }),
        orders_total: session.orders_total ?? 0,
        discount: session.discount ?? 0,
      });
    }
  }

  const displayTotal = isClosed
    ? (session?.grand_total ?? 0)
    : liveTotalPiastres;

  // The open segment (for mode-switch context).
  const openSegment = segments.find((s) => s.ended_at === null) ?? null;
  const currentPlayMode: PlayMode = openSegment?.play_mode ?? 'single';

  // ── Mutations ─────────────────────────────────────────────────────────────

  const { mutateAsync: switchPlayMode } = useSwitchPlayMode();
  const { mutateAsync: closeSessionPhase4 } = useCloseSessionPhase4();

  const handleSwitchRequest = (newMode: PlayMode) => {
    // SHOULD-FIX 4: do not allow mode-switch until deviceType is known — planSegments
    // needs the real device_type for correct rate-rule resolution.
    if (newMode === currentPlayMode || isClosed || billingMode !== 'open' || !deviceReady) return;
    setPendingPlayMode(newMode);
    setConfirmSwitchVisible(true);
  };

  const handleSwitchConfirm = async () => {
    // SHOULD-FIX 4: guard deviceType — never pass a null/wildcard to planSegments.
    if (!openSegment || !session || !tenantId || !pendingPlayMode || !deviceType) return;
    setSwitching(true);
    try {
      await switchPlayMode({
        sessionId: session.id,
        tenantId,
        openSegment,
        newPlayMode: pendingPlayMode,
        deviceType,
        rateRules,
      });
    } finally {
      setSwitching(false);
      setConfirmSwitchVisible(false);
      setPendingPlayMode(null);
    }
  };

  const handleCloseConfirm = async () => {
    // SHOULD-FIX 4: guard deviceType — never pass null/wildcard to planSegments.
    if (!session || !tenantId || !user || !deviceId || !deviceType) return;
    setClosing(true);
    const endedAt = nowIso();
    try {
      await closeSessionPhase4({
        sessionId: session.id,
        deviceId,
        tenantId,
        branchId: session.branch_id,
        managerId: user.id,
        session,
        segments,
        rateRules,
        deviceType,
      });
      setClosedAt(endedAt);
      setConfirmCloseVisible(false);
      router.back();
    } catch {
      setConfirmCloseVisible(false);
    } finally {
      setClosing(false);
    }
  };

  // ── Loading / error states ─────────────────────────────────────────────────

  if (sessionLoading) {
    return (
      <SafeAreaView style={styles.screen}>
        <OfflineBanner />
        <View style={styles.container}>
          <Skeleton height={40} width="60%" style={styles.skeleton} />
          <Skeleton height={80} width="80%" style={styles.skeleton} />
          <Skeleton height={30} width="50%" style={styles.skeleton} />
          <Skeleton height={30} width="50%" style={styles.skeleton} />
        </View>
      </SafeAreaView>
    );
  }

  if (sessionError) {
    return (
      <SafeAreaView style={styles.screen}>
        <OfflineBanner />
        <ErrorState
          message={t('state.error.generic')}
          onRetry={() => void refetchSession()}
          retryLabel={t('action.retry')}
        />
      </SafeAreaView>
    );
  }

  if (!session) {
    return (
      <SafeAreaView style={styles.screen}>
        <EmptyState
          title={t('session.closed.title')}
          actionLabel={t('action.back')}
          onAction={() => router.back()}
        />
      </SafeAreaView>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const billingModeLabel =
    billingMode === 'open'
      ? t('billingMode.open')
      : billingMode === 'prepaid'
        ? t('billingMode.prepaid')
        : t('billingMode.fixed_match');

  return (
    <SafeAreaView style={styles.screen}>
      <OfflineBanner />

      {/* Header */}
      <View style={styles.header}>
        <Button
          variant="ghost"
          onPress={() => router.back()}
          accessibilityLabel={t('action.back')}
        >
          {t('action.back')}
        </Button>
        <StatusPill
          status={isClosed ? 'free' : 'busy'}
          label={isClosed ? t('device.status.free') : t('device.status.busy')}
          dot
          pulse={!isClosed}
        />
      </View>

      <ScrollView contentContainerStyle={styles.content}>

        {/* Hero card: timer + billing-mode badge + total */}
        <View style={styles.hero}>
          {/* Billing mode pill */}
          <View style={styles.modeBadge}>
            <AppText role="micro" color={colors.primary}>
              {billingModeLabel}
            </AppText>
          </View>

          {/* Live timer — open and prepaid (fixed_match doesn't show elapsed time) */}
          {billingMode !== 'fixed_match' && (
            <LiveTimer
              startedAt={session.started_at}
              endedAt={isClosed ? (session.ended_at ?? closedAt ?? undefined) : undefined}
              size="lg"
              tickMs={1000}
            />
          )}

          {/* Running total — integer piastres via formatEgp + toArabicDigits */}
          <AppText
            role="money"
            style={styles.total}
            color={colors.primary}
            accessibilityRole="text"
            accessibilityLabel={`${t('session.close.grandTotal')}: ${formatEgp(displayTotal)}`}
          >
            {formatEgp(displayTotal)}
          </AppText>

          {/* Started at */}
          <View style={styles.startedRow}>
            <AppText role="caption" color={colors.textMuted}>
              {t('session.startedAt')}
            </AppText>
            <AppText role="caption" color={colors.textMuted}>
              {toArabicDigits(localHm(session.started_at))}
            </AppText>
          </View>
        </View>

        {/* ── Open-meter: play-mode switcher + live segment breakdown ── */}
        {billingMode === 'open' && !isClosed && (
          <>
            {/* Play-mode switch control (single ↔ multi) */}
            <View style={styles.section}>
              <AppText role="label" color={colors.textMuted} style={styles.sectionLabel}>
                {t('session.mode.switch.title')}
              </AppText>
              {/* SHOULD-FIX 4: mode-switch disabled until deviceType is confirmed.
                  handleSwitchRequest guards internally, but setting disabled per-option
                  makes the blocked state visually clear to the user. */}
              <SegmentedControl
                options={[
                  { value: 'single', label: t('playMode.single'), disabled: !deviceReady },
                  { value: 'multi', label: t('playMode.multi'), disabled: !deviceReady },
                ]}
                value={currentPlayMode}
                onChange={(v) => handleSwitchRequest(v as PlayMode)}
              />
            </View>

            {/* Live segment breakdown */}
            {liveSegmentPlans.length > 0 && (
              <View style={styles.section}>
                <AppText role="label" color={colors.textMuted} style={styles.sectionLabel}>
                  {t('session.segments.title')}
                </AppText>
                <View style={styles.segmentList}>
                  {liveSegmentPlans.map((plan, idx) => (
                    <SegmentCard
                      key={`${plan.started_at}-${idx}`}
                      plan={plan}
                      index={idx + 1}
                      isLast={idx === liveSegmentPlans.length - 1}
                    />
                  ))}
                </View>
              </View>
            )}
          </>
        )}

        {/* ── Open-meter closed: segment summary ── */}
        {billingMode === 'open' && isClosed && segments.length > 0 && (
          <View style={styles.section}>
            <AppText role="label" color={colors.textMuted} style={styles.sectionLabel}>
              {t('session.segments.title')}
            </AppText>
            <View style={styles.segmentList}>
              {segments.map((seg, idx) => (
                <View
                  key={seg.id}
                  style={segStyles.row}
                  accessible
                  accessibilityRole="text"
                >
                  <View style={segStyles.left}>
                    <AppText role="label" color={colors.textMuted}>
                      {t('session.segments.label', {
                        index: toArabicDigits(String(idx + 1)),
                      })}
                    </AppText>
                    <AppText role="caption" color={colors.textMuted}>
                      {toArabicDigits(localHm(seg.started_at))}
                      {seg.ended_at ? ` — ${toArabicDigits(localHm(seg.ended_at))}` : ''}
                    </AppText>
                    <AppText role="micro" color={colors.textFaint}>
                      {t('playMode.' + seg.play_mode)}
                    </AppText>
                  </View>
                  <View style={segStyles.right}>
                    <AppText role="caption" color={colors.textMuted}>
                      {seg.price_per_hour_snapshot > 0
                        ? t('rate.perHour', {
                            rate: toArabicDigits(
                              formatEgp(seg.price_per_hour_snapshot, false),
                            ),
                          })
                        : t('rate.noRule')}
                    </AppText>
                  </View>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* ── Fixed-match: match counter ── */}
        {billingMode === 'fixed_match' && (
          <View style={styles.section}>
            <MatchCounter
              sessionId={session.id}
              tenantId={session.tenant_id}
              matchCount={session.match_count ?? 0}
              lockedPrice={segments[0]?.price_per_hour_snapshot ?? 0}
              disabled={isClosed}
            />
          </View>
        )}

        {/* ── Prepaid: locked price reminder ── */}
        {billingMode === 'prepaid' && (
          <View style={styles.section}>
            <View style={styles.prepaidCard}>
              <AppText role="label" color={colors.textMuted}>
                {t('session.start.prepaid.label')}
              </AppText>
              <AppText role="money" color={colors.primary} style={styles.prepaidAmount}>
                {formatEgp(session.prepaid_total ?? 0)}
              </AppText>
              {session.prepaid_minutes != null && (
                <AppText role="caption" color={colors.textFaint}>
                  {toArabicDigits(String(session.prepaid_minutes))} {t('minutes')}
                </AppText>
              )}
            </View>
          </View>
        )}

        {/* Closed-session grand total summary */}
        {isClosed && (
          <View style={styles.closedSummary}>
            <View style={styles.summaryRow}>
              <AppText role="label" color={colors.textMuted}>
                {t('session.close.timeCost')}
              </AppText>
              <AppText role="label" color={colors.text}>
                {formatEgp(session.time_total)}
              </AppText>
            </View>
            <View style={[styles.summaryRow, styles.summaryGrandTotal]}>
              <AppText role="h3" color={colors.primary}>
                {t('session.close.grandTotal')}
              </AppText>
              <AppText role="h3" color={colors.primary}>
                {formatEgp(session.grand_total)}
              </AppText>
            </View>
          </View>
        )}

        {/* Orders slot — Phase 5 */}
        {/* <OrdersSlot sessionId={session.id} /> */}
      </ScrollView>

      {/* Close button — pinned at the bottom, above safe area.
          SHOULD-FIX 4: disabled until deviceData is loaded for open-meter sessions
          (planSegments needs the real device_type for correct rate resolution).
          deviceLoading/deviceError are shown as a caption when relevant. */}
      {!isClosed && (
        <View style={styles.footer}>
          {billingMode === 'open' && deviceError && (
            <AppText
              role="caption"
              color={colors.danger}
              align="center"
              style={styles.deviceWarning}
            >
              {t('session.device.error')}
            </AppText>
          )}
          {billingMode === 'open' && deviceLoading && !deviceError && (
            <AppText
              role="caption"
              color={colors.textMuted}
              align="center"
              style={styles.deviceWarning}
            >
              {t('session.device.loading')}
            </AppText>
          )}
          <Button
            variant="primary"
            size="lg"
            fullWidth
            disabled={billingMode === 'open' && !deviceReady}
            onPress={() => setConfirmCloseVisible(true)}
            accessibilityLabel={t('session.close.confirm')}
          >
            {t('session.close.confirm')}
          </Button>
        </View>
      )}

      {/* ── Confirm: close session ── */}
      <ConfirmDialog
        visible={confirmCloseVisible}
        title={t('session.close.summary')}
        body={formatEgp(displayTotal)}
        confirmLabel={t('session.close.confirm')}
        cancelLabel={t('action.cancel')}
        onConfirm={() => void handleCloseConfirm()}
        onCancel={() => setConfirmCloseVisible(false)}
        loading={closing}
        destructive={false}
      />

      {/* ── Confirm: switch play mode ── */}
      <Sheet
        visible={confirmSwitchVisible}
        onClose={() => {
          setConfirmSwitchVisible(false);
          setPendingPlayMode(null);
        }}
        title={t('session.mode.switch.title')}
      >
        <AppText role="body" color={colors.textMuted}>
          {t('session.mode.switch.description')}
        </AppText>
        {pendingPlayMode && (
          <AppText role="label" color={colors.primary} align="center">
            {/* ← RTL-correct: current ← new reads right-to-left as "new ← current" */}
            {t('playMode.' + pendingPlayMode)} {'←'} {t('playMode.' + currentPlayMode)}
          </AppText>
        )}
        <Button
          variant="primary"
          size="lg"
          fullWidth
          loading={switching}
          onPress={() => void handleSwitchConfirm()}
          accessibilityLabel={t('session.mode.switch.confirm')}
        >
          {t('session.mode.switch.confirm')}
        </Button>
        <Button
          variant="ghost"
          size="lg"
          fullWidth
          onPress={() => {
            setConfirmSwitchVisible(false);
            setPendingPlayMode(null);
          }}
          accessibilityLabel={t('action.cancel')}
        >
          {t('action.cancel')}
        </Button>
      </Sheet>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  container: {
    flex: 1,
    padding: spacing.xl,
    gap: spacing.md,
    justifyContent: 'center',
  },
  skeleton: {
    alignSelf: 'center',
    marginVertical: spacing.sm,
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
  content: {
    padding: spacing.xl,
    gap: spacing.xl,
    flexGrow: 1,
  },
  hero: {
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing['2xl'],
    paddingHorizontal: spacing.xl,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  modeBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing['2xs'],
    backgroundColor: colors.surface3,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  total: {
    fontSize: 36,
    fontWeight: '800' as const,
    fontVariant: ['tabular-nums'],
  },
  startedRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  section: {
    gap: spacing.sm,
  },
  sectionLabel: {
    paddingStart: spacing.xs,
  },
  segmentList: {
    gap: spacing.xs,
  },
  prepaidCard: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.xl,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  prepaidAmount: {
    fontSize: fontSize.h1,
    fontWeight: fontWeight.h1,
  },
  closedSummary: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    gap: spacing.sm,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  summaryGrandTotal: {
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    marginTop: spacing.xs,
  },
  footer: {
    padding: spacing.xl,
    paddingBottom: spacing['2xl'],
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: spacing.xs,
  },
  deviceWarning: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xs,
  },
});
