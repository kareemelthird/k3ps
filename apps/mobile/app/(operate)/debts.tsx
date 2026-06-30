/**
 * Debt book screen — Slice 3 (ADR-0012).
 *
 * Lists open/partially-paid debts for the tenant. Staff can record payments
 * (subject to `can_manage_debts` RLS and UI permission gate). Owners can settle
 * any debt; staff can only settle debts they created (RLS enforced at DB).
 *
 * UI contract:
 *   - Header summary: total outstanding (Σ remaining) + count of debtors.
 *   - FlatList of depth cards: customer name, amount/paid/remaining, status pill,
 *     created date. Empty / loading (skeleton) / error / offline states.
 *   - Tap a debt → Sheet: numeric amount input, "سداد كامل" quick button,
 *     confirm → useRecordDebtPayment. Optimistic refetch after settle.
 *   - Settle button disabled when !can_manage_debts (UI gate only; DB RLS is authority).
 *
 * HARD RULES (CLAUDE.md §2 / §6):
 *   - Money via formatEgp + toArabicDigits from @ps/core.
 *   - All strings via t('key') — never hardcoded Arabic.
 *   - Layout RTL-first (start/end spacing, no left/right).
 *   - Writes via useRecordDebtPayment (outbox) — never direct Supabase.
 */
import React, { useState } from 'react';
import {
  FlatList,
  Pressable,
  SafeAreaView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import {
  egpToPiastres,
  formatEgp,
  localHm,
  toArabicDigits,
  type Piastres,
} from '@ps/core';

import { useOpenDebts, useRecordDebtPayment, type DebtRow, type DebtStatus } from '../../src/features/debts/api';
import { useMyPermissions } from '../../src/features/auth/usePermissions';
import { colors, radius, spacing, TAP_TARGET } from '../../src/design/tokens';
import { AppText } from '../../src/components/AppText';
import { Button } from '../../src/components/Button';
import { EmptyState } from '../../src/components/EmptyState';
import { ErrorState } from '../../src/components/ErrorState';
import { OfflineBanner } from '../../src/components/OfflineBanner';
import { Sheet } from '../../src/components/Sheet';
import { Skeleton } from '../../src/components/Skeleton';
import { StatusPill } from '../../src/components/StatusPill';

// ─── Status pill mapping ──────────────────────────────────────────────────────

type PillStatus = 'danger' | 'warning' | 'free';

function debtStatusPill(status: DebtStatus): { pillStatus: PillStatus; key: string } {
  switch (status) {
    case 'open':           return { pillStatus: 'danger',  key: 'debts.status.open' };
    case 'partially_paid': return { pillStatus: 'warning', key: 'debts.status.partially_paid' };
    case 'settled':        return { pillStatus: 'free',    key: 'debts.status.settled' };
  }
}

// ─── Debt card ────────────────────────────────────────────────────────────────

interface DebtCardProps {
  debt: DebtRow;
  onPress: (debt: DebtRow) => void;
}

function DebtCard({ debt, onPress }: DebtCardProps) {
  const { t } = useTranslation();
  const { pillStatus, key: pillKey } = debtStatusPill(debt.status);

  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      onPress={() => onPress(debt)}
      accessibilityRole="button"
      accessibilityLabel={debt.customer_name}
    >
      {/* Header row: name + status pill */}
      <View style={styles.cardHeader}>
        <AppText role="h3" color={colors.text} numberOfLines={1} style={styles.cardName}>
          {debt.customer_name}
        </AppText>
        <StatusPill status={pillStatus} label={t(pillKey)} />
      </View>

      {/* Money rows */}
      <View style={styles.cardRow}>
        <AppText role="caption" color={colors.textMuted}>
          {t('debts.card.amount')}
        </AppText>
        <AppText role="label" color={colors.text}>
          {formatEgp(debt.amount)}
        </AppText>
      </View>

      {debt.paid_total > 0 && (
        <View style={styles.cardRow}>
          <AppText role="caption" color={colors.textMuted}>
            {t('debts.card.paid')}
          </AppText>
          <AppText role="label" color={colors.statusFree}>
            {formatEgp(debt.paid_total)}
          </AppText>
        </View>
      )}

      <View style={styles.cardRow}>
        <AppText role="caption" color={colors.textMuted}>
          {t('debts.card.remaining')}
        </AppText>
        <AppText role="label" color={colors.warning} style={styles.remainingAmount}>
          {formatEgp(debt.remaining)}
        </AppText>
      </View>

      {/* Date */}
      <AppText role="micro" color={colors.textFaint}>
        {toArabicDigits(localHm(debt.created_at))}
      </AppText>
    </Pressable>
  );
}

// ─── Skeleton card ────────────────────────────────────────────────────────────

function DebtCardSkeleton() {
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Skeleton height={18} width="55%" />
        <Skeleton height={22} width="25%" borderRadius={radius.xs} />
      </View>
      <Skeleton height={14} width="70%" />
      <Skeleton height={14} width="50%" />
    </View>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function DebtsScreen() {
  const { t } = useTranslation();
  const perms = useMyPermissions();
  const canSettleDebt = perms.can('can_manage_debts');

  const {
    data: debts = [],
    isLoading,
    error,
    refetch,
  } = useOpenDebts();

  const { mutateAsync: recordPayment, isPending: paying } = useRecordDebtPayment();

  // Settle sheet state
  const [selectedDebt, setSelectedDebt] = useState<DebtRow | null>(null);
  const [payAmountEgp, setPayAmountEgp] = useState('');
  const [payError, setPayError] = useState('');

  // Derived: total outstanding across all open debts
  const totalOutstanding = debts.reduce((sum, d) => sum + d.remaining, 0) as Piastres;
  const debtorCount = debts.length;

  function openSettleSheet(debt: DebtRow) {
    setSelectedDebt(debt);
    setPayAmountEgp('');
    setPayError('');
  }

  function closeSettleSheet() {
    setSelectedDebt(null);
    setPayAmountEgp('');
    setPayError('');
  }

  async function handleSettle() {
    if (!selectedDebt) return;

    const amountPiastres = Math.round(
      egpToPiastres(parseFloat(payAmountEgp.replace(',', '.')) || 0),
    ) as Piastres;

    if (amountPiastres <= 0) {
      setPayError(t('debts.settle.amountRequired'));
      return;
    }

    setPayError('');

    try {
      await recordPayment({
        debtId: selectedDebt.id,
        amount: amountPiastres,
      });
      closeSettleSheet();
    } catch {
      setPayError(t('debts.settle.error'));
    }
  }

  // ── Loading state ──────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <SafeAreaView style={styles.screen}>
        <OfflineBanner />
        <View style={styles.header}>
          <Skeleton height={20} width="50%" />
          <Skeleton height={28} width="40%" />
        </View>
        <View style={styles.list}>
          {[0, 1, 2].map((i) => <DebtCardSkeleton key={i} />)}
        </View>
      </SafeAreaView>
    );
  }

  // ── Error state ────────────────────────────────────────────────────────────

  if (error) {
    return (
      <SafeAreaView style={styles.screen}>
        <OfflineBanner />
        <ErrorState
          message={t('debts.error.load')}
          onRetry={() => void refetch()}
          retryLabel={t('action.retry')}
        />
      </SafeAreaView>
    );
  }

  // ── Empty state ────────────────────────────────────────────────────────────

  if (debts.length === 0) {
    return (
      <SafeAreaView style={styles.screen}>
        <OfflineBanner />
        <View style={styles.titleRow}>
          <AppText role="h2" color={colors.text}>{t('debts.title')}</AppText>
        </View>
        <EmptyState
          title={t('debts.empty.title')}
          body={t('debts.empty.body')}
        />
      </SafeAreaView>
    );
  }

  // ── Main render ────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.screen}>
      <OfflineBanner />

      {/* Summary header */}
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <AppText role="h2" color={colors.text}>{t('debts.title')}</AppText>
          <AppText role="caption" color={colors.textMuted}>
            {t('debts.summary.debtors', {
              countDisplay: toArabicDigits(String(debtorCount)),
            })}
          </AppText>
        </View>
        <View style={styles.summaryCard}>
          <AppText role="label" color={colors.textMuted}>{t('debts.summary.outstanding')}</AppText>
          <AppText role="h2" color={colors.warning}>{formatEgp(totalOutstanding)}</AppText>
        </View>
      </View>

      {/* Debt list */}
      <FlatList
        data={debts}
        keyExtractor={(d) => d.id}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <DebtCard debt={item} onPress={openSettleSheet} />
        )}
        showsVerticalScrollIndicator={false}
      />

      {/* Settle sheet */}
      {selectedDebt && (
        <Sheet
          visible={Boolean(selectedDebt)}
          onClose={closeSettleSheet}
          title={t('debts.settle.title')}
        >
          {/* Debt info recap */}
          <View style={styles.settleInfo}>
            <AppText role="h3" color={colors.text}>{selectedDebt.customer_name}</AppText>
            <View style={styles.settleRow}>
              <AppText role="caption" color={colors.textMuted}>{t('debts.card.remaining')}</AppText>
              <AppText role="label" color={colors.warning}>
                {formatEgp(selectedDebt.remaining)}
              </AppText>
            </View>
          </View>

          {/* Permission gate */}
          {!canSettleDebt ? (
            <AppText role="body" color={colors.textFaint} align="center">
              {t('debts.settle.noPermission')}
            </AppText>
          ) : (
            <>
              {/* Amount input */}
              <View style={styles.settleField}>
                <AppText role="label" color={colors.textMuted}>{t('debts.settle.amount')}</AppText>
                <TextInput
                  style={styles.settleInput}
                  value={payAmountEgp}
                  onChangeText={(v) => {
                    setPayAmountEgp(v);
                    setPayError('');
                  }}
                  placeholder={formatEgp(selectedDebt.remaining, false)}
                  placeholderTextColor={colors.textFaint}
                  keyboardType="decimal-pad"
                  accessibilityLabel={t('debts.settle.amount')}
                />
              </View>

              {/* Settle full quick button */}
              <Button
                variant="secondary"
                onPress={() => {
                  const rem = selectedDebt.remaining / 100;
                  setPayAmountEgp(String(rem % 1 === 0 ? rem : rem.toFixed(2)));
                  setPayError('');
                }}
                accessibilityLabel={t('debts.settle.fullSettle')}
              >
                {t('debts.settle.fullSettle')} ({formatEgp(selectedDebt.remaining)})
              </Button>

              {payError ? (
                <AppText role="caption" color={colors.danger}>
                  {payError}
                </AppText>
              ) : null}

              {/* Confirm */}
              <Button
                variant="primary"
                size="lg"
                fullWidth
                loading={paying}
                onPress={() => void handleSettle()}
                accessibilityLabel={t('debts.settle.confirm')}
              >
                {t('debts.settle.confirm')}
              </Button>

              <Button
                variant="ghost"
                size="lg"
                fullWidth
                onPress={closeSettleSheet}
                accessibilityLabel={t('action.cancel')}
              >
                {t('action.cancel')}
              </Button>
            </>
          )}
        </Sheet>
      )}
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
    gap: spacing.md,
  },
  titleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  summaryCard: {
    backgroundColor: colors.surface2,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing['2xs'],
  },
  list: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xl,
    gap: spacing.md,
  },
  // ── Debt card ──
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.xs,
    // Elevation for depth
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 4,
    elevation: 3,
  },
  cardPressed: {
    backgroundColor: colors.surface2,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing['2xs'],
  },
  cardName: {
    flex: 1,
  },
  cardRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  remainingAmount: {
    fontWeight: '700',
  },
  // ── Settle sheet ──
  settleInfo: {
    backgroundColor: colors.surface2,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.xs,
  },
  settleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  settleField: {
    gap: spacing.xs,
  },
  settleInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.text,
    minHeight: TAP_TARGET,
    fontSize: 16,
  },
});
