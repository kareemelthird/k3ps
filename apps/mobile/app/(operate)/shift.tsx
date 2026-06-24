/**
 * Shift screen — Phase 5 (ADR-0006 Decisions 1, 3, 6, 7).
 *
 * States:
 *   A. No open shift → Open-shift sheet (opening_cash).
 *   B. Open shift → Shows running summary; Close-shift form (counted_cash).
 *
 * INVARIANTS:
 *   - One open shift per branch enforced by DB (shifts_one_open_per_branch).
 *     Unique-constraint error is surfaced as an Arabic message.
 *   - computeShiftReconciliation from @ps/core — difference NOT clamped.
 *   - Business-day attribution via businessDayKey(opened_at, cutoverHour).
 *   - Cash sales = only cash-settled sessions + walk-in orders stamped with
 *     shift_id. wallet/other/debt excluded (Decision 3).
 *   - All strings via t('key'). Arabic-Indic numerals. RTL.
 */
import React, { useState } from 'react';
import {
  SafeAreaView,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import {
  businessDayKey,
  egpToPiastres,
  formatEgp,
  localHm,
  toArabicDigits,
  type Piastres,
} from '@ps/core';

import {
  useOpenShift,
  useOpenShift_mutation,
  useCloseShift,
  type ShiftRow,
} from '../../src/features/shifts/api';
import { useAuth } from '../../src/stores/useAuth';
import { colors, spacing, radius, TAP_TARGET, fontSize } from '../../src/design/tokens';
import { AppText } from '../../src/components/AppText';
import { Button } from '../../src/components/Button';
import { Sheet } from '../../src/components/Sheet';
import { OfflineBanner } from '../../src/components/OfflineBanner';
import { ErrorState } from '../../src/components/ErrorState';
import { DeviceCardSkeleton } from '../../src/components/Skeleton';

// ─── Shift summary card (open state) ─────────────────────────────────────────

function OpenShiftCard({
  shift,
  onClose,
}: {
  shift: ShiftRow;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const businessDay = businessDayKey(shift.opened_at);

  return (
    <View style={styles.shiftCard}>
      <View style={styles.shiftCardHeader}>
        <View style={[styles.statusDot, { backgroundColor: colors.statusFree }]} />
        <AppText role="h3" color={colors.statusFree}>
          {t('shift.status.open')}
        </AppText>
      </View>

      <View style={styles.shiftRow}>
        <AppText role="label" color={colors.textMuted}>
          {t('shift.openedAt')}
        </AppText>
        <AppText role="label">
          {localHm(shift.opened_at)}
        </AppText>
      </View>

      <View style={styles.shiftRow}>
        <AppText role="label" color={colors.textMuted}>
          {t('shift.businessDay')}
        </AppText>
        <AppText role="label">
          {businessDay}
        </AppText>
      </View>

      <View style={styles.shiftRow}>
        <AppText role="label" color={colors.textMuted}>
          {t('shift.open.openingCash')}
        </AppText>
        <AppText role="label" color={colors.primary}>
          {formatEgp(shift.opening_cash)}
        </AppText>
      </View>

      <Button
        variant="primary"
        size="lg"
        fullWidth
        onPress={onClose}
        accessibilityLabel={t('shift.close.title')}
      >
        {t('shift.close.title')}
      </Button>
    </View>
  );
}

// ─── Close shift form ─────────────────────────────────────────────────────────

function CloseShiftForm({
  shift,
  onSubmit,
  loading,
  error,
}: {
  shift: ShiftRow;
  onSubmit: (params: { countedCash: Piastres; notes: string }) => void;
  loading: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  const [countedEgp, setCountedEgp] = useState('');
  const [notes, setNotes] = useState('');

  const handleSubmit = () => {
    const egp = parseFloat(countedEgp.replace(',', '.'));
    if (isNaN(egp) || egp < 0) return;
    onSubmit({
      countedCash: egpToPiastres(egp),
      notes,
    });
  };

  return (
    <View style={styles.closeForm}>
      <View style={styles.shiftRow}>
        <AppText role="label" color={colors.textMuted}>
          {t('shift.open.openingCash')}
        </AppText>
        <AppText role="label" color={colors.primary}>
          {formatEgp(shift.opening_cash)}
        </AppText>
      </View>

      <AppText role="label" color={colors.textMuted}>
        {t('shift.close.countedCash')}
      </AppText>
      <TextInput
        style={styles.input}
        value={countedEgp}
        onChangeText={setCountedEgp}
        placeholder={toArabicDigits('0.00')}
        placeholderTextColor={colors.textFaint}
        keyboardType="decimal-pad"
        accessibilityLabel={t('shift.close.countedCash')}
      />

      <AppText role="label" color={colors.textMuted}>
        {t('shift.close.notes')}
      </AppText>
      <TextInput
        style={[styles.input, styles.inputMultiline]}
        value={notes}
        onChangeText={setNotes}
        placeholder={t('shift.close.notes')}
        placeholderTextColor={colors.textFaint}
        multiline
        accessibilityLabel={t('shift.close.notes')}
      />

      {error && (
        <View accessibilityRole="alert" accessible>
          <AppText role="caption" color={colors.danger}>{error}</AppText>
        </View>
      )}

      <Button
        variant="primary"
        size="lg"
        fullWidth
        loading={loading}
        onPress={handleSubmit}
        accessibilityLabel={t('shift.close.confirm')}
      >
        {t('shift.close.confirm')}
      </Button>
    </View>
  );
}

// ─── Reconciliation result card ───────────────────────────────────────────────

function ReconciliationCard({
  openingCash,
  expectedCash,
  actualCash,
  difference,
}: {
  openingCash: Piastres;
  expectedCash: Piastres;
  actualCash: Piastres;
  difference: Piastres;
}) {
  const { t } = useTranslation();
  const isOver = difference > 0;
  const isShort = difference < 0;
  const differenceColor = isOver
    ? colors.statusFree
    : isShort
    ? colors.danger
    : colors.primary;
  const differenceLabel = isOver
    ? t('shift.close.over')
    : isShort
    ? t('shift.close.short')
    : t('shift.close.balanced');

  return (
    <View style={styles.reconciliationCard}>
      <View style={styles.shiftRow}>
        <AppText role="label" color={colors.textMuted}>
          {t('shift.open.openingCash')}
        </AppText>
        <AppText role="label">{formatEgp(openingCash)}</AppText>
      </View>
      <View style={styles.shiftRow}>
        <AppText role="label" color={colors.textMuted}>
          {t('shift.close.expectedCash')}
        </AppText>
        <AppText role="label">{formatEgp(expectedCash)}</AppText>
      </View>
      <View style={styles.shiftRow}>
        <AppText role="label" color={colors.textMuted}>
          {t('shift.close.countedCash')}
        </AppText>
        <AppText role="label">{formatEgp(actualCash)}</AppText>
      </View>
      <View style={[styles.shiftRow, styles.differenceRow]}>
        <AppText role="h3" color={differenceColor}>
          {differenceLabel}
        </AppText>
        <AppText role="h2" color={differenceColor}>
          {formatEgp(Math.abs(difference))}
        </AppText>
      </View>
    </View>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function ShiftScreen() {
  const { t } = useTranslation();
  const { claim, user, activeBranchId } = useAuth();
  const tenantId = claim?.tenant_id ?? null;
  const branchId = activeBranchId;
  const managerId = user?.id ?? '';

  const {
    data: openShift,
    isLoading,
    error: shiftError,
    refetch,
  } = useOpenShift(tenantId, branchId);

  const { mutateAsync: doOpenShift, isPending: openingShift } = useOpenShift_mutation();
  const { mutateAsync: doCloseShift, isPending: closingShift } = useCloseShift();

  // ── Open shift sheet state ──
  const [openSheetVisible, setOpenSheetVisible] = useState(false);
  const [openingCashEgp, setOpeningCashEgp] = useState('');
  const [openError, setOpenError] = useState<string | null>(null);

  // ── Close shift sheet state ──
  const [closeSheetVisible, setCloseSheetVisible] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);

  // ── Reconciliation result (shown after close) ──
  const [reconciliation, setReconciliation] = useState<{
    openingCash: Piastres;
    expectedCash: Piastres;
    actualCash: Piastres;
    difference: Piastres;
  } | null>(null);

  // ── Handlers ──
  const handleOpenShift = async () => {
    if (!tenantId || !branchId || !managerId) return;
    setOpenError(null);

    const egp = parseFloat(openingCashEgp.replace(',', '.'));
    if (isNaN(egp) || egp < 0) {
      setOpenError(t('shift.open.openingCash'));
      return;
    }
    const openingCash = eggToPiastres(egp);

    try {
      await doOpenShift({
        tenantId,
        branchId,
        managerId,
        openingCash,
      });
      setOpenSheetVisible(false);
      setOpeningCashEgp('');
    } catch (err: unknown) {
      // DB unique constraint error on shifts_one_open_per_branch.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('shifts_one_open_per_branch') || msg.includes('unique')) {
        setOpenError(t('shift.open.alreadyOpen'));
      } else {
        setOpenError(t('shift.error.openFailed'));
      }
    }
  };

  const handleCloseShift = async ({
    countedCash,
    notes,
  }: {
    countedCash: Piastres;
    notes: string;
  }) => {
    if (!openShift || !tenantId || !branchId || !managerId) return;
    setCloseError(null);

    try {
      const result = await doCloseShift({
        shiftId: openShift.id,
        tenantId,
        branchId,
        managerId,
        openingCash: openShift.opening_cash,
        countedCash,
        notes,
        openedAt: openShift.opened_at,
      });

      setReconciliation({
        openingCash: openShift.opening_cash,
        expectedCash: result.expected_cash,
        actualCash: countedCash,
        difference: result.difference,
      });
      setCloseSheetVisible(false);
    } catch {
      setCloseError(t('shift.error.closeFailed'));
    }
  };

  // ── Import egpToPiastres directly (not a hook) ──
  function eggToPiastres(egp: number): Piastres {
    return egpToPiastres(egp);
  }

  // ── Render ──
  if (isLoading) {
    return (
      <SafeAreaView style={styles.screen}>
        <OfflineBanner />
        <View style={styles.loadingGrid}>
          <DeviceCardSkeleton />
        </View>
      </SafeAreaView>
    );
  }

  if (shiftError) {
    return (
      <SafeAreaView style={styles.screen}>
        <ErrorState
          message={t('shift.error.loadFailed')}
          onRetry={() => void refetch()}
          retryLabel={t('action.retry')}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <OfflineBanner />

      <View style={styles.header}>
        <AppText role="h2">{t('shift.title')}</AppText>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        {/* Reconciliation result (post-close) */}
        {reconciliation && !openShift && (
          <ReconciliationCard
            openingCash={reconciliation.openingCash}
            expectedCash={reconciliation.expectedCash}
            actualCash={reconciliation.actualCash}
            difference={reconciliation.difference}
          />
        )}

        {/* No open shift */}
        {!openShift && !reconciliation && (
          <View style={styles.noShiftContainer}>
            <AppText role="h3" color={colors.textMuted} style={styles.centered}>
              {t('shift.status.none')}
            </AppText>
            <Button
              variant="primary"
              size="lg"
              fullWidth
              onPress={() => {
                setOpenSheetVisible(true);
                setOpeningCashEgp('');
                setOpenError(null);
              }}
              accessibilityLabel={t('shift.open.title')}
            >
              {t('shift.open.title')}
            </Button>
          </View>
        )}

        {/* Open shift card */}
        {openShift && (
          <OpenShiftCard
            shift={openShift}
            onClose={() => {
              setCloseSheetVisible(true);
              setCloseError(null);
            }}
          />
        )}

        {/* After close, allow starting a new shift */}
        {reconciliation && !openShift && (
          <Button
            variant="secondary"
            size="lg"
            fullWidth
            onPress={() => {
              setReconciliation(null);
              setOpenSheetVisible(true);
              setOpeningCashEgp('');
              setOpenError(null);
            }}
            accessibilityLabel={t('shift.open.title')}
          >
            {t('shift.open.title')}
          </Button>
        )}
      </ScrollView>

      {/* Open shift sheet */}
      <Sheet
        visible={openSheetVisible}
        onClose={() => setOpenSheetVisible(false)}
        title={t('shift.open.title')}
      >
        <AppText role="label" color={colors.textMuted}>
          {t('shift.open.openingCash')}
        </AppText>
        <TextInput
          style={styles.input}
          value={openingCashEgp}
          onChangeText={setOpeningCashEgp}
          placeholder={t('shift.open.placeholder')}
          placeholderTextColor={colors.textFaint}
          keyboardType="decimal-pad"
          accessibilityLabel={t('shift.open.openingCash')}
        />
        {openError && (
          <View accessibilityRole="alert" accessible>
            <AppText role="caption" color={colors.danger}>{openError}</AppText>
          </View>
        )}
        <Button
          variant="primary"
          size="lg"
          fullWidth
          loading={openingShift}
          onPress={() => void handleOpenShift()}
          accessibilityLabel={t('shift.open.confirm')}
        >
          {t('shift.open.confirm')}
        </Button>
      </Sheet>

      {/* Close shift sheet */}
      <Sheet
        visible={closeSheetVisible && Boolean(openShift)}
        onClose={() => setCloseSheetVisible(false)}
        title={t('shift.close.title')}
        dismissible={!closingShift}
      >
        {openShift && (
          <CloseShiftForm
            shift={openShift}
            onSubmit={handleCloseShift}
            loading={closingShift}
            error={closeError}
          />
        )}
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
  header: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  scrollContent: {
    padding: spacing.md,
    gap: spacing.md,
    paddingBottom: spacing['3xl'],
  },
  loadingGrid: {
    padding: spacing.md,
    gap: spacing.sm,
  },
  noShiftContainer: {
    gap: spacing.xl,
    alignItems: 'center',
    paddingTop: spacing['2xl'],
  },
  centered: {
    textAlign: 'center',
  },
  shiftCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  shiftCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  shiftRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing['2xs'],
  },
  closeForm: {
    gap: spacing.md,
  },
  reconciliationCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  differenceRow: {
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    marginTop: spacing.xs,
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
  inputMultiline: {
    minHeight: 80,
    textAlignVertical: 'top',
  },
});
