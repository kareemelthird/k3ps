/**
 * Session detail — M5 (design spec §M5).
 * Live timer from started_at; running total via @ps/core.
 * Close flow: ConfirmDialog → compute time_total via @ps/core → close session
 * → free device → write audit_log → route back to grid.
 *
 * INVARIANT: timer value = elapsedSeconds(startedAt, now), never a counter.
 * Money = integer piastres via openMeterCostPiastres/@ps/core. No floats. (CLAUDE.md §2)
 * Times displayed in Africa/Cairo via localHm (CLAUDE.md §3).
 */
import React, { useState } from 'react';
import {
  SafeAreaView,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';

import {
  formatEgp,
  localHm,
  nowIso,
  openMeterCostPiastres,
  toArabicDigits,
} from '@ps/core';

import { useCloseSession } from '../../../src/features/devices/api';
import { useAuth } from '../../../src/stores/useAuth';
import { supabase } from '../../../src/lib/supabase';
import { colors, spacing, radius } from '../../../src/design/tokens';
import { AppText } from '../../../src/components/AppText';
import { Button } from '../../../src/components/Button';
import { ConfirmDialog } from '../../../src/components/ConfirmDialog';
import { EmptyState } from '../../../src/components/EmptyState';
import { ErrorState } from '../../../src/components/ErrorState';
import { LiveTimer } from '../../../src/components/LiveTimer';
import { OfflineBanner } from '../../../src/components/OfflineBanner';
import { Skeleton } from '../../../src/components/Skeleton';
import { StatusPill } from '../../../src/components/StatusPill';
import { useTick } from '../../../src/hooks/useTick';

export default function SessionDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useTranslation();
  const { claim, user } = useAuth();
  const { mutateAsync: closeSession } = useCloseSession();

  const [confirmVisible, setConfirmVisible] = useState(false);
  const [closing, setClosing] = useState(false);
  const [closedAt, setClosedAt] = useState<string | null>(null);

  // Tick to force re-render (not the source of the value)
  useTick(closedAt ? null : 1000);

  const tenantId = claim?.tenant_id ?? null;

  // Load session + its first segment (for the rate snapshot)
  const {
    data,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ['session', id, tenantId],
    enabled: Boolean(id && tenantId),
    queryFn: async () => {
      const [sessionRes, segmentRes] = await Promise.all([
        supabase
          .from('sessions')
          .select('*')
          .eq('id', id)
          .eq('tenant_id', tenantId)
          .single(),
        supabase
          .from('session_segments')
          .select('*')
          .eq('session_id', id)
          .eq('tenant_id', tenantId)
          .order('started_at', { ascending: true })
          .limit(1)
          .single(),
      ]);

      if (sessionRes.error) throw sessionRes.error;
      // SHOULD-FIX: surface a missing-rate error rather than silently billing 0
      if (segmentRes.error) throw segmentRes.error;
      return {
        session: sessionRes.data as {
          id: string;
          tenant_id: string;
          branch_id: string;
          device_id: string;
          started_at: string;
          ended_at: string | null;
          status: string;
          grand_total: number;
          time_total: number;
        },
        segment: segmentRes.data as {
          price_per_hour_snapshot: number;
        },
      };
    },
    refetchInterval: 30_000,
  });

  const session = data?.session;
  const segment = data?.segment;

  // Compute live running total (integer piastres, @ps/core — never inline math)
  // For a live session: pass nowIso() each tick. For closed: pass ended_at.
  const now = closedAt ?? nowIso();
  const liveTotalPiastres =
    session && segment
      ? openMeterCostPiastres(
          session.started_at,
          session.ended_at ?? now,
          segment.price_per_hour_snapshot,
        )
      : 0;

  const handleCloseConfirm = async () => {
    if (!session || !tenantId || !user) return;
    // SHOULD-FIX: block close when rate snapshot is unavailable to avoid silent 0-billing
    if (!segment) return;
    setClosing(true);
    const endedAt = nowIso();

    try {
      // BLOCKER: use @ps/core openMeterCostPiastres — integer piastres, no inline floats
      const timeTotalPiastres = openMeterCostPiastres(
        session.started_at,
        endedAt,
        segment.price_per_hour_snapshot,
      );

      await closeSession({
        sessionId: session.id,
        deviceId: session.device_id,
        tenantId,
        branchId: session.branch_id,
        managerId: user.id,
        timeTotalPiastres,
        endedAt,
      });

      setClosedAt(endedAt);
      setConfirmVisible(false);

      // Navigate back to device grid
      router.back();
    } catch {
      setConfirmVisible(false);
    } finally {
      setClosing(false);
    }
  };

  if (isLoading) {
    return (
      <SafeAreaView style={styles.screen}>
        <OfflineBanner />
        <View style={styles.container}>
          <Skeleton height={40} width="60%" style={styles.skeleton} />
          <Skeleton height={60} width="80%" style={styles.skeleton} />
          <Skeleton height={30} width="50%" style={styles.skeleton} />
        </View>
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView style={styles.screen}>
        <OfflineBanner />
        <ErrorState
          message={t('state.error.generic')}
          onRetry={() => void refetch()}
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

  const isClosed = session.status === 'closed' || Boolean(closedAt);
  const displayTotal = isClosed ? session.grand_total : liveTotalPiastres;

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
        {/* Hero: live timer */}
        <View style={styles.hero}>
          <LiveTimer
            startedAt={session.started_at}
            endedAt={isClosed ? (session.ended_at ?? closedAt ?? undefined) : undefined}
            size="lg"
            tickMs={1000}
          />

          {/* Running total — integer piastres via formatEgp */}
          <AppText role="money" style={styles.total} color={colors.primary}>
            {formatEgp(displayTotal)}
          </AppText>

          <View style={styles.startedRow}>
            <AppText role="caption" color={colors.textMuted}>
              {t('session.startedAt')}
            </AppText>
            {/* SHOULD-FIX: use localHm (Africa/Cairo) — never device TZ */}
            <AppText role="caption" color={colors.textMuted}>
              {toArabicDigits(localHm(session.started_at))}
            </AppText>
          </View>
        </View>

        {/* Reserved orders slot — Phase 6 will insert here */}
        {/* <OrdersSlot sessionId={session.id} /> */}
      </ScrollView>

      {/* Close button — pinned above safe area */}
      {!isClosed && (
        <View style={styles.footer}>
          <Button
            variant="primary"
            size="lg"
            fullWidth
            onPress={() => setConfirmVisible(true)}
            accessibilityLabel={t('session.close.confirm')}
          >
            {t('session.close.confirm')}
          </Button>
        </View>
      )}

      {/* Confirm dialog — destructive friction */}
      <ConfirmDialog
        visible={confirmVisible}
        title={t('session.close.summary')}
        body={`${formatEgp(liveTotalPiastres)}`}
        confirmLabel={t('session.close.confirm')}
        cancelLabel={t('action.cancel')}
        onConfirm={handleCloseConfirm}
        onCancel={() => setConfirmVisible(false)}
        loading={closing}
        destructive={false}
      />
    </SafeAreaView>
  );
}

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
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  total: {
    fontSize: 32,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  startedRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  footer: {
    padding: spacing.xl,
    paddingBottom: spacing['2xl'],
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
});
