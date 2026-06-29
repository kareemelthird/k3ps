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
 * Performance (ADR-0011 §Q4, AC 16): products list uses FlatList — not
 * ScrollView+map — so the screen stays smooth as catalog grows past 20 rows.
 * Movement history inside the Sheet also uses FlatList.
 *
 * A11y (ADR-0011 §Q5, AC 22): StockCard rows expose accessibilityRole + state;
 * action buttons carry 44pt touch targets (TAP_TARGET); error alerts use
 * accessibilityRole="alert". (AC 22)
 *
 * INVARIANTS:
 *   - On-hand ALWAYS from the view / computeLevels — never ad-hoc sum.
 *   - stockStatus drives badges (out/low/ok/untracked).
 *   - Each action writes one audit row (stock.restock / stock.adjust).
 *   - All strings via t('key'). Arabic-Indic numerals. RTL.
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
import { useTranslation } from 'react-i18next';

import {
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

// ── List item discriminant ─────────────────────────────────────────────────────
// Using a discriminated union so FlatList can handle both tracked and untracked
// products in a single virtualized list without two separate ScrollView maps.
type StockListItem =
  | { kind: 'tracked'; product: ProductRow }
  | { kind: 'untracked'; product: ProductRow };

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
      <View
        style={styles.stockCard}
        accessible
        accessibilityLabel={`${product.name} — ${t('stock.status.untracked')}`}
      >
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
  const statusColor = colorMap[status] ?? colors.textFaint;

  return (
    <View
      style={styles.stockCard}
      accessible
      accessibilityLabel={`${product.name} — ${t(`stock.status.${status}`)} — ${toArabicDigits(String(onHand ?? 0))}`}
    >
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
          <View style={[styles.badge, { backgroundColor: statusColor }]}>
            <AppText role="micro" color={colors.onPrimary}>
              {t(`stock.status.${status}`)}
            </AppText>
          </View>
          <AppText role="h3" color={statusColor}>
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

  // ── Combined virtualized list data (AC 16 — FlatList, not ScrollView+map) ──
  // Tracked products first so action buttons appear at the top; untracked at the bottom.
  const stockListData = useMemo<StockListItem[]>(() => {
    const tracked = (products ?? [])
      .filter((p) => isProductTracked(p.stock))
      .map((p): StockListItem => ({ kind: 'tracked', product: p }));
    const untracked = (products ?? [])
      .filter((p) => !isProductTracked(p.stock))
      .map((p): StockListItem => ({ kind: 'untracked', product: p }));
    return [...tracked, ...untracked];
  }, [products]);

  // ── Handlers ──
  const handleRestock = async () => {
    if (!restockProduct || !tenantId || !branchId || !managerId) return;
    setRestockError(null);
    const qty = parseInt(restockQty, 10);
    if (isNaN(qty) || qty <= 0) {
      setRestockError(t('stock.error.qtyRequired'));
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
      setAdjustError(t('stock.error.deltaRequired'));
      return;
    }
    if (!adjustNote.trim()) {
      setAdjustError(t('stock.error.noteRequired'));
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

  // ── Render item ──
  const renderStockItem = ({ item }: { item: StockListItem }) => {
    const { product } = item;
    if (item.kind === 'tracked') {
      return (
        <Pressable
          onLongPress={() => setHistoryProduct(product)}
          accessibilityLabel={`${product.name} — ${t('stock.movements.title')}`}
          accessibilityHint={t('stock.movements.title')}
          accessibilityRole="button"
          style={styles.stockItemPressable}
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
      );
    }
    // Untracked — informational only, not interactive for stock actions
    return (
      <StockCard
        product={product}
        onHand={undefined}
        onRestock={() => {}}
        onAdjust={() => {}}
        canAdjust={false}
      />
    );
  };

  // ── Loading / error early returns ──
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

  return (
    <SafeAreaView style={styles.screen}>
      <OfflineBanner />

      <View style={styles.header}>
        <AppText role="h2">{t('stock.title')}</AppText>
      </View>

      {/* Virtualized product list (AC 16 — FlatList replaces ScrollView+map) */}
      <FlatList
        data={stockListData}
        keyExtractor={(item) => item.product.id}
        renderItem={renderStockItem}
        contentContainerStyle={styles.scrollContent}
        ListEmptyComponent={
          <EmptyState
            title={t('orders.emptyProducts.title')}
            body={t('orders.emptyProducts.body')}
          />
        }
      />

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

      {/* Movement history sheet (long-press on a tracked product)
          Uses FlatList so history of 100+ movements stays smooth. */}
      <Sheet
        visible={Boolean(historyProduct)}
        onClose={() => setHistoryProduct(null)}
        title={`${t('stock.movements.title')} — ${historyProduct?.name ?? ''}`}
      >
        <FlatList
          data={movements ?? []}
          keyExtractor={(m) => m.id}
          renderItem={({ item }) => <MovementRow movement={item} />}
          style={styles.movementsScroll}
          ListEmptyComponent={
            <AppText role="caption" color={colors.textMuted}>
              {t('stock.movements.title')}
            </AppText>
          }
        />
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
  stockItemPressable: {
    // Ensures the long-press target is the full card area
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
