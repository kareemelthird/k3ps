/**
 * Stock screen — Phase 5 (ADR-0006 Decisions 4, 5, 7).
 *
 * Shows per-product on-hand via the product_stock_levels view
 * (computeLevels = products.stock + Σ deltas).
 *
 * Actions:
 *   - Restock (any staff): records reason='restock', +delta.
 *   - Adjust (owner-only, gated on JWT role): records reason='adjust', ±delta + note.
 *     RLS also enforces the owner-only rule DB-side.
 *
 * INVARIANTS:
 *   - On-hand ALWAYS from the view / computeLevels — never ad-hoc sum.
 *   - stockStatus drives badges (out/low/ok/untracked).
 *   - Each action writes one audit row (stock.restock / stock.adjust).
 *   - All strings via t('key'). Arabic-Indic numerals. RTL.
 */
import React, { useMemo, useState } from 'react';
import {
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import {
  formatEgp,
  stockStatus,
  toArabicDigits,
} from '@ps/core';

import {
  useProducts,
  useStockLevels,
  isProductTracked,
  type ProductRow,
} from '../../src/features/orders/api';
import {
  useRestock,
  useAdjustStock,
  useStockMovements,
  type StockMovementRow,
} from '../../src/features/stock/api';
import { useAuth } from '../../src/stores/useAuth';
import { colors, spacing, radius, TAP_TARGET, fontSize } from '../../src/design/tokens';
import { AppText } from '../../src/components/AppText';
import { Button } from '../../src/components/Button';
import { Sheet } from '../../src/components/Sheet';
import { EmptyState } from '../../src/components/EmptyState';
import { ErrorState } from '../../src/components/ErrorState';
import { DeviceCardSkeleton } from '../../src/components/Skeleton';
import { OfflineBanner } from '../../src/components/OfflineBanner';

// ─── Stock row card ───────────────────────────────────────────────────────────

function StockCard({
  product,
  onHand,
  onRestock,
  onAdjust,
  canAdjust,
}: {
  product: ProductRow;
  onHand: number | undefined;
  onRestock: () => void;
  onAdjust: () => void;
  canAdjust: boolean;
}) {
  const { t } = useTranslation();

  if (!isProductTracked(product.stock)) {
    return (
      <View style={styles.stockCard}>
        <View style={styles.stockCardRow}>
          <AppText role="label">{product.name}</AppText>
          <View style={[styles.badge, { backgroundColor: colors.textFaint }]}>
            <AppText role="micro" color={colors.onPrimary}>
              {t('stock.status.untracked')}
            </AppText>
          </View>
        </View>
      </View>
    );
  }

  // stockStatus(onHand, low?) — on_hand is the first param.
  const status = stockStatus(onHand ?? null);
  const colorMap: Record<string, string> = {
    ok: colors.statusFree,
    low: colors.warning,
    out: colors.danger,
    untracked: colors.textFaint,
  };

  return (
    <View style={styles.stockCard}>
      <View style={styles.stockCardRow}>
        <View style={styles.stockCardLeft}>
          <AppText role="label">{product.name}</AppText>
          {product.category ? (
            <AppText role="caption" color={colors.textMuted}>
              {product.category}
            </AppText>
          ) : null}
        </View>
        <View style={styles.stockCardRight}>
          <View style={[styles.badge, { backgroundColor: colorMap[status] ?? colors.textFaint }]}>
            <AppText role="micro" color={colors.onPrimary}>
              {t(`stock.status.${status}`)}
            </AppText>
          </View>
          <AppText role="h3" color={colorMap[status] ?? colors.text}>
            {toArabicDigits(String(onHand ?? 0))}
          </AppText>
        </View>
      </View>
      <View style={styles.stockActions}>
        <Button
          variant="secondary"
          size="md"
          onPress={onRestock}
          accessibilityLabel={t('stock.restock.title')}
        >
          {t('stock.restock.title')}
        </Button>
        {canAdjust && (
          <Button
            variant="ghost"
            size="md"
            onPress={onAdjust}
            accessibilityLabel={t('stock.adjust.title')}
          >
            {t('stock.adjust.title')}
          </Button>
        )}
      </View>
    </View>
  );
}

// ─── Movement history row ─────────────────────────────────────────────────────

function MovementRow({ movement }: { movement: StockMovementRow }) {
  const { t } = useTranslation();
  const isPositive = movement.delta > 0;

  return (
    <View style={styles.movementRow}>
      <View style={styles.movementLeft}>
        <AppText role="caption">
          {t(`stock.movements.reason.${movement.reason}`)}
        </AppText>
        {movement.note ? (
          <AppText role="micro" color={colors.textMuted}>
            {movement.note}
          </AppText>
        ) : null}
      </View>
      <AppText
        role="label"
        color={isPositive ? colors.statusFree : colors.danger}
      >
        {isPositive ? '+' : ''}{toArabicDigits(String(movement.delta))}
      </AppText>
    </View>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function StockScreen() {
  const { t } = useTranslation();
  const { claim, role, user, activeBranchId } = useAuth();
  const tenantId = claim?.tenant_id ?? null;
  const branchId = activeBranchId;
  const managerId = user?.id ?? '';
  const isOwner = role === 'owner';

  // ── Queries ──
  const { data: products, isLoading, error, refetch } = useProducts(tenantId);
  const { data: stockLevels } = useStockLevels(tenantId, branchId);

  // ── Mutations ──
  const { mutateAsync: doRestock, isPending: restocking } = useRestock();
  const { mutateAsync: doAdjust, isPending: adjusting } = useAdjustStock();

  // ── Sheet state ──
  const [restockProduct, setRestockProduct] = useState<ProductRow | null>(null);
  const [adjustProduct, setAdjustProduct] = useState<ProductRow | null>(null);
  const [historyProduct, setHistoryProduct] = useState<ProductRow | null>(null);

  const [restockQty, setRestockQty] = useState('');
  const [restockNote, setRestockNote] = useState('');
  const [restockError, setRestockError] = useState<string | null>(null);

  const [adjustDelta, setAdjustDelta] = useState('');
  const [adjustNote, setAdjustNote] = useState('');
  const [adjustError, setAdjustError] = useState<string | null>(null);

  // ── Movements query (only when history sheet open) ──
  const { data: movements } = useStockMovements(
    historyProduct?.id ?? null,
    tenantId,
  );

  // ── Stock level map ──
  const stockMap = useMemo(() => {
    const m = new Map<string, number>();
    (stockLevels ?? []).forEach((sl) => m.set(sl.product_id, sl.on_hand));
    return m;
  }, [stockLevels]);

  // ── Handlers ──
  const handleRestock = async () => {
    if (!restockProduct || !tenantId || !branchId || !managerId) return;
    setRestockError(null);
    const qty = parseInt(restockQty, 10);
    if (isNaN(qty) || qty <= 0) {
      setRestockError(t('stock.restock.qty'));
      return;
    }
    try {
      await doRestock({
        productId: restockProduct.id,
        tenantId,
        branchId,
        managerId,
        delta: qty,
        note: restockNote,
        productCost: restockProduct.cost,
      });
      setRestockProduct(null);
      setRestockQty('');
      setRestockNote('');
    } catch {
      setRestockError(t('stock.error.restockFailed'));
    }
  };

  const handleAdjust = async () => {
    if (!adjustProduct || !tenantId || !branchId || !managerId) return;
    setAdjustError(null);
    const delta = parseInt(adjustDelta, 10);
    if (isNaN(delta)) {
      setAdjustError(t('stock.adjust.delta'));
      return;
    }
    if (!adjustNote.trim()) {
      setAdjustError(t('stock.adjust.note'));
      return;
    }
    try {
      await doAdjust({
        productId: adjustProduct.id,
        tenantId,
        branchId,
        managerId,
        delta,
        note: adjustNote,
        productCost: adjustProduct.cost,
      });
      setAdjustProduct(null);
      setAdjustDelta('');
      setAdjustNote('');
    } catch {
      setAdjustError(t('stock.error.adjustFailed'));
    }
  };

  // ── Render ──
  if (isLoading) {
    return (
      <SafeAreaView style={styles.screen}>
        <OfflineBanner />
        <View style={styles.loadingGrid}>
          {[1, 2, 3].map((i) => <DeviceCardSkeleton key={i} />)}
        </View>
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView style={styles.screen}>
        <ErrorState
          message={t('state.error.generic')}
          onRetry={() => void refetch()}
          retryLabel={t('action.retry')}
        />
      </SafeAreaView>
    );
  }

  const trackedProducts = (products ?? []).filter((p) => isProductTracked(p.stock));
  const untrackedProducts = (products ?? []).filter((p) => !isProductTracked(p.stock));

  return (
    <SafeAreaView style={styles.screen}>
      <OfflineBanner />

      <View style={styles.header}>
        <AppText role="h2">{t('stock.title')}</AppText>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        {(products ?? []).length === 0 && (
          <EmptyState
            title={t('orders.emptyProducts.title')}
            body={t('orders.emptyProducts.body')}
          />
        )}

        {/* Tracked products */}
        {trackedProducts.map((product) => (
          <Pressable
            key={product.id}
            onLongPress={() => setHistoryProduct(product)}
            accessibilityLabel={`${product.name} — ${t('stock.movements.title')}`}
            accessibilityHint={t('stock.movements.title')}
          >
            <StockCard
              product={product}
              onHand={stockMap.get(product.id)}
              onRestock={() => {
                setRestockProduct(product);
                setRestockQty('');
                setRestockNote('');
                setRestockError(null);
              }}
              onAdjust={() => {
                setAdjustProduct(product);
                setAdjustDelta('');
                setAdjustNote('');
                setAdjustError(null);
              }}
              canAdjust={isOwner}
            />
          </Pressable>
        ))}

        {/* Untracked products */}
        {untrackedProducts.map((product) => (
          <StockCard
            key={product.id}
            product={product}
            onHand={undefined}
            onRestock={() => {}}
            onAdjust={() => {}}
            canAdjust={false}
          />
        ))}
      </ScrollView>

      {/* Restock sheet */}
      <Sheet
        visible={Boolean(restockProduct)}
        onClose={() => setRestockProduct(null)}
        title={`${t('stock.restock.title')} — ${restockProduct?.name ?? ''}`}
      >
        <AppText role="label" color={colors.textMuted}>
          {t('stock.restock.qty')}
        </AppText>
        <TextInput
          style={styles.input}
          value={restockQty}
          onChangeText={setRestockQty}
          placeholder={toArabicDigits('10')}
          placeholderTextColor={colors.textFaint}
          keyboardType="number-pad"
          accessibilityLabel={t('stock.restock.qty')}
        />
        <AppText role="label" color={colors.textMuted}>
          {t('stock.restock.note')}
        </AppText>
        <TextInput
          style={[styles.input, styles.inputMultiline]}
          value={restockNote}
          onChangeText={setRestockNote}
          placeholder={t('stock.restock.note')}
          placeholderTextColor={colors.textFaint}
          multiline
          accessibilityLabel={t('stock.restock.note')}
        />
        {restockError && (
          <View accessibilityRole="alert" accessible>
            <AppText role="caption" color={colors.danger}>{restockError}</AppText>
          </View>
        )}
        <Button
          variant="primary"
          size="lg"
          fullWidth
          loading={restocking}
          onPress={() => void handleRestock()}
          accessibilityLabel={t('stock.restock.confirm')}
        >
          {t('stock.restock.confirm')}
        </Button>
      </Sheet>

      {/* Adjust sheet (owner-only) */}
      <Sheet
        visible={Boolean(adjustProduct)}
        onClose={() => setAdjustProduct(null)}
        title={`${t('stock.adjust.title')} — ${adjustProduct?.name ?? ''}`}
      >
        {!isOwner ? (
          <AppText role="body" color={colors.warning}>
            {t('stock.adjust.ownerOnly')}
          </AppText>
        ) : (
          <>
            <AppText role="label" color={colors.textMuted}>
              {t('stock.adjust.delta')}
            </AppText>
            <TextInput
              style={styles.input}
              value={adjustDelta}
              onChangeText={setAdjustDelta}
              placeholder={toArabicDigits('-5')}
              placeholderTextColor={colors.textFaint}
              keyboardType="numbers-and-punctuation"
              accessibilityLabel={t('stock.adjust.delta')}
            />
            <AppText role="label" color={colors.textMuted}>
              {t('stock.adjust.note')}
            </AppText>
            <TextInput
              style={[styles.input, styles.inputMultiline]}
              value={adjustNote}
              onChangeText={setAdjustNote}
              placeholder={t('stock.adjust.note')}
              placeholderTextColor={colors.textFaint}
              multiline
              accessibilityLabel={t('stock.adjust.note')}
            />
            {adjustError && (
              <View accessibilityRole="alert" accessible>
                <AppText role="caption" color={colors.danger}>{adjustError}</AppText>
              </View>
            )}
            <Button
              variant="primary"
              size="lg"
              fullWidth
              loading={adjusting}
              onPress={() => void handleAdjust()}
              accessibilityLabel={t('stock.adjust.confirm')}
            >
              {t('stock.adjust.confirm')}
            </Button>
          </>
        )}
      </Sheet>

      {/* History sheet (long-press) */}
      <Sheet
        visible={Boolean(historyProduct)}
        onClose={() => setHistoryProduct(null)}
        title={`${t('stock.movements.title')} — ${historyProduct?.name ?? ''}`}
      >
        <ScrollView style={styles.movementsScroll}>
          {(movements ?? []).length === 0 && (
            <AppText role="caption" color={colors.textMuted}>
              {t('stock.movements.title')}
            </AppText>
          )}
          {(movements ?? []).map((m) => (
            <MovementRow key={m.id} movement={m} />
          ))}
        </ScrollView>
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
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    gap: spacing.sm,
    paddingBottom: spacing['3xl'],
  },
  loadingGrid: {
    padding: spacing.md,
    gap: spacing.sm,
  },
  stockCard: {
    backgroundColor: colors.surface2,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  stockCardRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  stockCardLeft: {
    flex: 1,
    gap: 2,
  },
  stockCardRight: {
    alignItems: 'flex-end',
    gap: 4,
  },
  stockActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    flexWrap: 'wrap',
  },
  badge: {
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
    borderRadius: radius.xs,
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
  movementsScroll: {
    maxHeight: 400,
  },
  movementRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  movementLeft: {
    flex: 1,
    gap: 2,
  },
});
