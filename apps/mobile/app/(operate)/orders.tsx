/**
 * Orders screen — Phase 5 (ADR-0006 Decisions 2, 3, 4, 7, 8).
 *
 * Two modes:
 *   A. Session-attached: tap a product → add to the active session's order.
 *      The order total folds into session.orders_total → grand_total at close.
 *   B. Walk-in: standalone order (session_id=null), paid directly with a
 *      payment_method (cash/wallet/other; debt NOT selectable).
 *
 * INVARIANTS:
 *   - unit_price snapshotted at add-time (catalog price at that instant).
 *   - computeOrderTotal from @ps/core — no inline money math.
 *   - Stock badge via stockStatus (out/low/ok/untracked).
 *   - Oversell: warn via badge, never block the sale.
 *   - Void: sets is_void=true; rewrites total; writes audit.
 *   - All strings via t('key'). Arabic-Indic numerals. RTL.
 */
import React, { useMemo, useState } from 'react';
import {
  FlatList,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import {
  computeOrderTotal,
  formatEgp,
  stockStatus,
  toArabicDigits,
} from '@ps/core';

import {
  useProducts,
  useStockLevels,
  useWalkInOrders,
  useAddOrder,
  useVoidOrderItem,
  usePayWalkInOrder,
  isProductTracked,
  type ProductRow,
  type OrderRow,
  type OrderItemRow,
} from '../../src/features/orders/api';
import { useOpenShift } from '../../src/features/shifts/api';
import { useAuth } from '../../src/stores/useAuth';
import { colors, spacing, radius, TAP_TARGET, fontSize } from '../../src/design/tokens';
import { AppText } from '../../src/components/AppText';
import { Button } from '../../src/components/Button';
import { Sheet } from '../../src/components/Sheet';
import { EmptyState } from '../../src/components/EmptyState';
import { ErrorState } from '../../src/components/ErrorState';
import { DeviceCardSkeleton } from '../../src/components/Skeleton';
import { OfflineBanner } from '../../src/components/OfflineBanner';
import { SegmentedControl } from '../../src/components/SegmentedControl';

// ─── Stock badge ──────────────────────────────────────────────────────────────

function StockBadge({ product, onHand }: { product: ProductRow; onHand: number | undefined }) {
  const { t } = useTranslation();
  if (!isProductTracked(product.stock)) return null;

  // stockStatus(onHand) — first param is on_hand (number | null | undefined).
  const status = stockStatus(onHand ?? null);
  const colorMap: Record<string, string> = {
    ok: colors.statusFree,
    low: colors.warning,
    out: colors.danger,
    untracked: colors.textFaint,
  };
  return (
    <View
      style={[
        styles.badge,
        { backgroundColor: colorMap[status] ?? colors.textFaint },
      ]}
    >
      <AppText role="micro" color={colors.onPrimary}>
        {t(`stock.status.${status}`)}
      </AppText>
    </View>
  );
}

// ─── Product catalog card ──────────────────────────────────────────────────────

function ProductCard({
  product,
  onHand,
  onPress,
  qty,
}: {
  product: ProductRow;
  onHand: number | undefined;
  onPress: () => void;
  qty: number;
}) {
  const { t } = useTranslation();
  const tracked = isProductTracked(product.stock);
  const status = tracked ? stockStatus(onHand ?? null) : 'untracked';
  const warnOverSell = tracked && status === 'out';

  return (
    <Pressable
      style={({ pressed }) => [
        styles.productCard,
        pressed && styles.productCardPressed,
        warnOverSell && styles.productCardWarn,
      ]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${product.name} — ${formatEgp(product.price)}`}
      accessibilityState={{ selected: qty > 0 }}
    >
      <View style={styles.productCardTop}>
        <AppText role="label" style={styles.productName}>
          {product.name}
        </AppText>
        <StockBadge product={product} onHand={onHand} />
      </View>
      <View style={styles.productCardBottom}>
        <AppText role="body" color={colors.primary} style={styles.productPrice}>
          {formatEgp(product.price)}
        </AppText>
        {qty > 0 && (
          <View style={styles.qtyChip}>
            <AppText role="micro" color={colors.onPrimary}>
              {toArabicDigits(String(qty))}
            </AppText>
          </View>
        )}
      </View>
      {warnOverSell && (
        <AppText role="caption" color={colors.danger}>
          {t('stock.status.out')}
        </AppText>
      )}
    </Pressable>
  );
}

// ─── Cart item row ────────────────────────────────────────────────────────────

function CartItemRow({
  item,
  productName,
  onVoid,
}: {
  item: { productId: string; qty: number; unitPrice: number; isVoid?: boolean };
  productName: string;
  onVoid: () => void;
}) {
  const { t } = useTranslation();
  if (item.isVoid) return null;

  return (
    <View style={styles.cartRow}>
      <View style={styles.cartLeft}>
        <AppText role="body">{productName}</AppText>
        <AppText role="caption" color={colors.textMuted}>
          {toArabicDigits(String(item.qty))} × {formatEgp(item.unitPrice)}
        </AppText>
      </View>
      <View style={styles.cartRight}>
        <AppText role="label" color={colors.primary}>
          {formatEgp(item.qty * item.unitPrice)}
        </AppText>
        <Pressable
          onPress={onVoid}
          style={styles.voidBtn}
          accessibilityRole="button"
          accessibilityLabel={t('orders.void.title')}
          hitSlop={8}
        >
          <AppText role="caption" color={colors.danger}>
            {t('orders.void.title')}
          </AppText>
        </Pressable>
      </View>
    </View>
  );
}

// ─── Order items list (for an existing walk-in order) ────────────────────────

function OrderItemsList({
  order,
  products,
  onVoidItem,
}: {
  order: OrderRow & { items: OrderItemRow[] };
  products: ProductRow[];
  onVoidItem: (item: OrderItemRow) => void;
}) {
  const { t } = useTranslation();
  const productMap = useMemo(() => {
    const m = new Map<string, ProductRow>();
    products.forEach((p) => m.set(p.id, p));
    return m;
  }, [products]);

  const nonVoidItems = order.items.filter((i) => !i.is_void);
  const total = computeOrderTotal(
    order.items.map((i) => ({ qty: i.qty, unit_price: i.unit_price, is_void: i.is_void })),
  );

  return (
    <View style={styles.orderCard}>
      {nonVoidItems.map((item) => (
        <View key={item.id} style={styles.cartRow}>
          <View style={styles.cartLeft}>
            <AppText role="body">
              {productMap.get(item.product_id)?.name ?? item.product_id}
            </AppText>
            <AppText role="caption" color={colors.textMuted}>
              {toArabicDigits(String(item.qty))} × {formatEgp(item.unit_price)}
            </AppText>
          </View>
          <View style={styles.cartRight}>
            <AppText role="label" color={colors.primary}>
              {formatEgp(item.qty * item.unit_price)}
            </AppText>
            <Pressable
              onPress={() => onVoidItem(item)}
              style={styles.voidBtn}
              accessibilityRole="button"
              accessibilityLabel={t('orders.void.title')}
              hitSlop={8}
            >
              <AppText role="caption" color={colors.danger}>
                {t('orders.void.title')}
              </AppText>
            </Pressable>
          </View>
        </View>
      ))}
      <View style={styles.totalRow}>
        <AppText role="label" color={colors.textMuted}>
          {t('orders.total')}
        </AppText>
        <AppText role="h3" color={colors.primary}>
          {formatEgp(total)}
        </AppText>
      </View>
    </View>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function OrdersScreen() {
  const { t } = useTranslation();
  const { claim, user, activeBranchId } = useAuth();
  const tenantId = claim?.tenant_id ?? null;
  const branchId = activeBranchId;
  const managerId = user?.id ?? '';

  // ── Queries ──
  const { data: products, isLoading: productsLoading, error: productsError, refetch: refetchProducts } =
    useProducts(tenantId);
  const { data: stockLevels } = useStockLevels(tenantId, branchId);
  const { data: walkInOrders, refetch: refetchWalkIns } = useWalkInOrders(tenantId, branchId);
  const { data: openShift } = useOpenShift(tenantId, branchId);

  // ── Mutations ──
  const { mutateAsync: addOrder, isPending: addingOrder } = useAddOrder();
  const { mutateAsync: voidItem, isPending: voidingItem } = useVoidOrderItem();
  const { mutateAsync: payOrder, isPending: payingOrder } = usePayWalkInOrder();

  // ── Cart state (for new walk-in or session-attached order building) ──
  const [mode, setMode] = useState<'walkin' | 'catalog'>('walkin');
  const [cart, setCart] = useState<Map<string, number>>(new Map()); // productId → qty
  const [addError, setAddError] = useState<string | null>(null);

  // ── Walk-in order being managed ──
  const [activeWalkInOrder, setActiveWalkInOrder] =
    useState<(OrderRow & { items: OrderItemRow[] }) | null>(null);
  const [paySheetVisible, setPaySheetVisible] = useState(false);
  const [payMethod, setPayMethod] = useState<'cash' | 'wallet' | 'other'>('cash');
  const [payError, setPayError] = useState<string | null>(null);

  // ── Stock level map ──
  const stockMap = useMemo(() => {
    const m = new Map<string, number>();
    (stockLevels ?? []).forEach((sl) => m.set(sl.product_id, sl.on_hand));
    return m;
  }, [stockLevels]);

  // ── Category list (NIT 5: chip value and filter predicate use the same
  //    raw category string; blank-category products are excluded from chips
  //    since '' is the sentinel for "All") ──
  const categories = useMemo(() => {
    const cats = new Set<string>();
    (products ?? []).forEach((p) => {
      if (p.category) cats.add(p.category);
    });
    return ['', ...Array.from(cats)];
  }, [products]);

  const [selectedCategory, setSelectedCategory] = useState('');

  const filteredProducts = useMemo(() => {
    if (!selectedCategory) return products ?? [];
    return (products ?? []).filter((p) => p.category === selectedCategory);
  }, [products, selectedCategory]);

  // ── Cart total ──
  const cartTotal = useMemo(() => {
    if (!products) return 0;
    const productMap = new Map(products.map((p) => [p.id, p]));
    let total = 0;
    cart.forEach((qty, productId) => {
      const product = productMap.get(productId);
      if (product && qty > 0) total += qty * product.price;
    });
    return total;
  }, [cart, products]);

  // ── Add to cart ──
  const handleAddToCart = (product: ProductRow) => {
    setCart((prev) => {
      const next = new Map(prev);
      next.set(product.id, (next.get(product.id) ?? 0) + 1);
      return next;
    });
  };

  // ── Submit cart as new walk-in order ──
  const handleSubmitOrder = async () => {
    if (!tenantId || !branchId || !managerId || cart.size === 0) return;
    if (!products) return;
    setAddError(null);

    const productMap = new Map(products.map((p) => [p.id, p]));
    const items: { productId: string; unitPrice: number; qty: number }[] = [];
    cart.forEach((qty, productId) => {
      const p = productMap.get(productId);
      if (p && qty > 0) {
        items.push({ productId, unitPrice: p.price, qty });
      }
    });

    try {
      await addOrder({
        sessionId: null, // walk-in
        tenantId,
        branchId,
        managerId,
        shiftId: openShift?.id ?? null,
        items,
      });
      setCart(new Map());
      void refetchWalkIns();
    } catch {
      setAddError(t('orders.error.addFailed'));
    }
  };

  // ── Void an item on an existing walk-in order ──
  const handleVoidItem = async (
    order: OrderRow & { items: OrderItemRow[] },
    item: OrderItemRow,
  ) => {
    if (!tenantId || !branchId || !managerId) return;
    const product = (products ?? []).find((p) => p.id === item.product_id);
    try {
      await voidItem({
        itemId: item.id,
        orderId: order.id,
        sessionId: null,
        tenantId,
        branchId,
        managerId,
        qty: item.qty,
        unitPrice: item.unit_price,
        productId: item.product_id,
        productIsTracked: isProductTracked(product?.stock ?? null),
        orderStatus: order.status,
      });
    } catch {
      // surface inline
    }
  };

  // ── Pay walk-in order ──
  const handlePay = async () => {
    if (!activeWalkInOrder || !tenantId || !branchId || !managerId) return;
    setPayError(null);
    const productMap = new Map((products ?? []).map((p) => [p.id, p]));

    try {
      await payOrder({
        orderId: activeWalkInOrder.id,
        tenantId,
        branchId,
        managerId,
        shiftId: openShift?.id ?? null,
        paymentMethod: payMethod,
        total: computeOrderTotal(
          activeWalkInOrder.items.map((i) => ({
            qty: i.qty,
            unit_price: i.unit_price,
            is_void: i.is_void,
          })),
        ),
        items: activeWalkInOrder.items.map((i) => ({
          itemId: i.id,
          productId: i.product_id,
          qty: i.qty,
          unitPrice: i.unit_price,
          isVoid: i.is_void,
          isTracked: isProductTracked(productMap.get(i.product_id)?.stock ?? null),
        })),
      });
      setPaySheetVisible(false);
      setActiveWalkInOrder(null);
    } catch {
      setPayError(t('orders.error.payFailed'));
    }
  };

  const payMethodOptions = [
    { value: 'cash', label: t('orders.pay.method.cash') },
    { value: 'wallet', label: t('orders.pay.method.wallet') },
    { value: 'other', label: t('orders.pay.method.other') },
  ];

  // ── Render ──
  if (productsLoading) {
    return (
      <SafeAreaView style={styles.screen}>
        <OfflineBanner />
        <View style={styles.loadingGrid}>
          {[1, 2, 3, 4].map((i) => (
            <DeviceCardSkeleton key={i} />
          ))}
        </View>
      </SafeAreaView>
    );
  }

  if (productsError) {
    return (
      <SafeAreaView style={styles.screen}>
        <ErrorState
          message={t('state.error.generic')}
          onRetry={() => void refetchProducts()}
          retryLabel={t('action.retry')}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <OfflineBanner />

      {/* Header */}
      <View style={styles.header}>
        <AppText role="h2">{t('orders.title')}</AppText>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        {/* Category filter */}
        {categories.length > 1 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.categoryScroll}
          >
            {categories.map((cat) => (
              <Pressable
                key={cat || '__all__'}
                onPress={() => setSelectedCategory(cat)}
                style={[
                  styles.categoryChip,
                  selectedCategory === cat && styles.categoryChipActive,
                ]}
                accessibilityRole="button"
                accessibilityState={{ selected: selectedCategory === cat }}
              >
                <AppText
                  role="caption"
                  color={selectedCategory === cat ? colors.onPrimary : colors.textMuted}
                >
                  {/* '' sentinel = "All products" chip; non-empty = raw category */}
                  {cat || t('orders.title')}
                </AppText>
              </Pressable>
            ))}
          </ScrollView>
        )}

        {/* Product grid */}
        {filteredProducts.length === 0 ? (
          <EmptyState
            title={t('orders.emptyProducts.title')}
            body={t('orders.emptyProducts.body')}
          />
        ) : (
          <View style={styles.productGrid}>
            {filteredProducts.map((product) => (
              <ProductCard
                key={product.id}
                product={product}
                onHand={stockMap.get(product.id)}
                qty={cart.get(product.id) ?? 0}
                onPress={() => handleAddToCart(product)}
              />
            ))}
          </View>
        )}

        {/* Cart summary (new order) */}
        {cart.size > 0 && (
          <View style={styles.cartSection}>
            <AppText role="h3" style={styles.sectionTitle}>
              {t('orders.newOrder')}
            </AppText>
            {Array.from(cart.entries())
              .filter(([, qty]) => qty > 0)
              .map(([productId, qty]) => {
                const product = (products ?? []).find((p) => p.id === productId);
                if (!product) return null;
                return (
                  <CartItemRow
                    key={productId}
                    item={{ productId, qty, unitPrice: product.price }}
                    productName={product.name}
                    onVoid={() => {
                      setCart((prev) => {
                        const next = new Map(prev);
                        const current = next.get(productId) ?? 0;
                        if (current <= 1) next.delete(productId);
                        else next.set(productId, current - 1);
                        return next;
                      });
                    }}
                  />
                );
              })}
            <View style={styles.totalRow}>
              <AppText role="label" color={colors.textMuted}>
                {t('orders.total')}
              </AppText>
              <AppText role="h3" color={colors.primary}>
                {formatEgp(cartTotal)}
              </AppText>
            </View>
            {addError && (
              <View accessibilityRole="alert" accessible>
                <AppText role="caption" color={colors.danger}>{addError}</AppText>
              </View>
            )}
            <Button
              variant="primary"
              size="lg"
              fullWidth
              loading={addingOrder}
              onPress={() => void handleSubmitOrder()}
              accessibilityLabel={t('orders.walkinOrder')}
            >
              {t('orders.walkinOrder')}
            </Button>
          </View>
        )}

        {/* Open walk-in orders */}
        {(walkInOrders ?? []).length > 0 && (
          <View style={styles.walkInSection}>
            <AppText role="h3" style={styles.sectionTitle}>
              {t('orders.walkin')}
            </AppText>
            {(walkInOrders ?? []).map((order) => (
              <View key={order.id} style={styles.orderCard}>
                <OrderItemsList
                  order={order}
                  products={products ?? []}
                  onVoidItem={(item) => void handleVoidItem(order, item)}
                />
                <Button
                  variant="primary"
                  size="md"
                  fullWidth
                  onPress={() => {
                    setActiveWalkInOrder(order);
                    setPayMethod('cash');
                    setPayError(null);
                    setPaySheetVisible(true);
                  }}
                  accessibilityLabel={t('orders.pay.confirm')}
                >
                  {t('orders.pay.confirm')}
                </Button>
              </View>
            ))}
          </View>
        )}
      </ScrollView>

      {/* Pay sheet */}
      <Sheet
        visible={paySheetVisible}
        onClose={() => setPaySheetVisible(false)}
        title={t('orders.pay.title')}
      >
        {activeWalkInOrder && (
          <View style={styles.payTotal}>
            <AppText role="label" color={colors.textMuted}>
              {t('orders.total')}
            </AppText>
            <AppText role="h2" color={colors.primary}>
              {formatEgp(
                computeOrderTotal(
                  activeWalkInOrder.items.map((i) => ({
                    qty: i.qty,
                    unit_price: i.unit_price,
                    is_void: i.is_void,
                  })),
                ),
              )}
            </AppText>
          </View>
        )}

        <AppText role="label" color={colors.textMuted}>
          {t('orders.pay.method.label')}
        </AppText>
        <SegmentedControl
          options={payMethodOptions}
          value={payMethod}
          onChange={(v) => setPayMethod(v as 'cash' | 'wallet' | 'other')}
        />

        {payError && (
          <View accessibilityRole="alert" accessible>
            <AppText role="caption" color={colors.danger}>{payError}</AppText>
          </View>
        )}

        <Button
          variant="primary"
          size="lg"
          fullWidth
          loading={payingOrder}
          onPress={() => void handlePay()}
          accessibilityLabel={t('orders.pay.confirm')}
        >
          {t('orders.pay.confirm')}
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
  header: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: spacing['3xl'],
    gap: spacing.lg,
  },
  loadingGrid: {
    padding: spacing.md,
    gap: spacing.sm,
  },
  categoryScroll: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    gap: spacing.sm,
    flexDirection: 'row',
  },
  categoryChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
    backgroundColor: colors.surface3,
    minHeight: 36,
    justifyContent: 'center',
  },
  categoryChipActive: {
    backgroundColor: colors.primary,
  },
  productGrid: {
    paddingHorizontal: spacing.xl,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  productCard: {
    backgroundColor: colors.surface2,
    borderRadius: radius.md,
    padding: spacing.md,
    minHeight: TAP_TARGET,
    width: '47%',
    gap: spacing['2xs'],
  },
  productCardPressed: {
    backgroundColor: colors.surface3,
  },
  productCardWarn: {
    borderWidth: 1,
    borderColor: colors.danger,
  },
  productCardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  productName: {
    flex: 1,
    flexWrap: 'wrap',
  },
  productCardBottom: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  productPrice: {
    fontWeight: '700',
  },
  badge: {
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
    borderRadius: radius.xs,
    marginStart: spacing.xs,
  },
  qtyChip: {
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cartSection: {
    paddingHorizontal: spacing.xl,
    backgroundColor: colors.surface,
    marginHorizontal: spacing.md,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sectionTitle: {
    marginBottom: spacing.xs,
  },
  cartRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  cartLeft: {
    flex: 1,
    gap: 2,
  },
  cartRight: {
    alignItems: 'flex-end',
    gap: 4,
  },
  voidBtn: {
    minHeight: 32,
    justifyContent: 'center',
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: spacing.sm,
  },
  walkInSection: {
    paddingHorizontal: spacing.md,
    gap: spacing.md,
  },
  orderCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  payTotal: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
});
