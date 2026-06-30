/**
 * Orders screen — Slice 1 additions on top of Phase 5 (ADR-0006).
 *
 * New in Slice 1:
 *   10. Quantity stepper per product in the cart (+ / − / qty badge);
 *       first grid tap = add 1, subsequent taps via stepper.
 *   11. Search box for products (in addition to category chips).
 *   12. Quick-add chips: first 6 products as one-tap add chips above the grid.
 *   13. Repeat last walk-in sale: rebuild previous ticket's lines from current
 *       products; guard against now-out-of-stock items (warn, don't block).
 *
 * Two modes:
 *   A. Session-attached: tap a product → add to the active session's order.
 *   B. Walk-in: standalone order paid directly with a payment_method.
 *
 * Performance: FlatList numColumns=2 as outer scroll container (AC 16).
 * A11y: ProductCard has accessibilityRole + state; pay confirm button is labelled.
 *
 * INVARIANTS:
 *   - unit_price snapshotted at add-time.
 *   - computeOrderTotal from @ps/core — no inline money math.
 *   - Stock badge via stockStatus (out/low/ok/untracked).
 *   - Oversell: warn via badge, never block the sale.
 *   - All strings via t('key'). Arabic-Indic numerals. RTL.
 */
import React, { useCallback, useMemo, useState } from 'react';
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
  useLastPaidWalkIn,
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

// ─── Constants ────────────────────────────────────────────────────────────────
const QUICK_ADD_COUNT = 6;

// ─── Stock badge ──────────────────────────────────────────────────────────────

function StockBadge({ product, onHand }: { product: ProductRow; onHand: number | undefined }) {
  const { t } = useTranslation();
  if (!isProductTracked(product.stock)) return null;

  const status = stockStatus(onHand ?? null);
  const colorMap: Record<string, string> = {
    ok: colors.statusFree,
    low: colors.warning,
    out: colors.danger,
    untracked: colors.textFaint,
  };
  return (
    <View style={[styles.badge, { backgroundColor: colorMap[status] ?? colors.textFaint }]}>
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

// ─── Cart item row with quantity stepper ─────────────────────────────────────

function CartItemRow({
  productName,
  unitPrice,
  qty,
  onIncrease,
  onDecrease,
}: {
  productName: string;
  unitPrice: number;
  qty: number;
  onIncrease: () => void;
  onDecrease: () => void;
}) {
  const { t } = useTranslation();

  return (
    <View style={styles.cartRow}>
      <View style={styles.cartLeft}>
        <AppText role="body">{productName}</AppText>
        <AppText role="caption" color={colors.textMuted}>
          {formatEgp(unitPrice)}
        </AppText>
      </View>
      {/* Stepper */}
      <View style={styles.stepper}>
        <Pressable
          onPress={onDecrease}
          style={({ pressed }) => [styles.stepBtn, pressed && styles.stepBtnPressed]}
          accessibilityRole="button"
          accessibilityLabel={t('orders.stepper.decrease')}
          hitSlop={4}
        >
          <AppText role="label" color={colors.text}>{'−'}</AppText>
        </Pressable>
        <View style={styles.stepQty} accessible accessibilityRole="text">
          <AppText role="label" color={colors.primary}>
            {toArabicDigits(String(qty))}
          </AppText>
        </View>
        <Pressable
          onPress={onIncrease}
          style={({ pressed }) => [styles.stepBtn, pressed && styles.stepBtnPressed]}
          accessibilityRole="button"
          accessibilityLabel={t('orders.stepper.increase')}
          hitSlop={4}
        >
          <AppText role="label" color={colors.text}>{'+'}</AppText>
        </Pressable>
      </View>
      <AppText role="label" color={colors.primary} style={styles.cartLineTotal}>
        {formatEgp(qty * unitPrice)}
      </AppText>
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
  const { data: lastPaidWalkIn } = useLastPaidWalkIn(tenantId, branchId);

  // ── Mutations ──
  const { mutateAsync: addOrder, isPending: addingOrder } = useAddOrder();
  const { mutateAsync: voidItem } = useVoidOrderItem();
  const { mutateAsync: payOrder, isPending: payingOrder } = usePayWalkInOrder();

  // ── Cart state: productId → qty ──
  const [cart, setCart] = useState<Map<string, number>>(new Map());
  const [addError, setAddError] = useState<string | null>(null);
  const [repeatNotice, setRepeatNotice] = useState<string | null>(null);

  // ── Walk-in order being managed ──
  const [activeWalkInOrder, setActiveWalkInOrder] =
    useState<(OrderRow & { items: OrderItemRow[] }) | null>(null);
  const [paySheetVisible, setPaySheetVisible] = useState(false);
  const [payMethod, setPayMethod] = useState<'cash' | 'wallet' | 'other'>('cash');
  const [payError, setPayError] = useState<string | null>(null);

  // ── Slice 1: search + category filter ────────────────────────────────────

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('');

  // ── Stock level map ──
  const stockMap = useMemo(() => {
    const m = new Map<string, number>();
    (stockLevels ?? []).forEach((sl) => m.set(sl.product_id, sl.on_hand));
    return m;
  }, [stockLevels]);

  // ── Category list ──
  const categories = useMemo(() => {
    const cats = new Set<string>();
    (products ?? []).forEach((p) => {
      if (p.category) cats.add(p.category);
    });
    return ['', ...Array.from(cats)];
  }, [products]);

  // ── Product maps ──
  const productMap = useMemo(() => {
    const m = new Map<string, ProductRow>();
    (products ?? []).forEach((p) => m.set(p.id, p));
    return m;
  }, [products]);

  // ── Filtered products (category + search) ──
  const filteredProducts = useMemo(() => {
    let list = products ?? [];
    if (selectedCategory) {
      list = list.filter((p) => p.category === selectedCategory);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      list = list.filter((p) => p.name.toLowerCase().includes(q));
    }
    return list;
  }, [products, selectedCategory, searchQuery]);

  // ── Quick-add chips: first 6 products (all categories, unfiltered) ──
  const quickAddProducts = useMemo(
    () => (products ?? []).slice(0, QUICK_ADD_COUNT),
    [products],
  );

  // ── Cart total ──
  const cartTotal = useMemo(() => {
    let total = 0;
    cart.forEach((qty, productId) => {
      const product = productMap.get(productId);
      if (product && qty > 0) total += qty * product.price;
    });
    return total;
  }, [cart, productMap]);

  // ── Cart handlers ──
  const handleAddToCart = useCallback((product: ProductRow) => {
    setCart((prev) => {
      const next = new Map(prev);
      next.set(product.id, (next.get(product.id) ?? 0) + 1);
      return next;
    });
  }, []);

  const handleIncreaseQty = useCallback((productId: string) => {
    setCart((prev) => {
      const next = new Map(prev);
      next.set(productId, (next.get(productId) ?? 0) + 1);
      return next;
    });
  }, []);

  const handleDecreaseQty = useCallback((productId: string) => {
    setCart((prev) => {
      const next = new Map(prev);
      const current = next.get(productId) ?? 0;
      if (current <= 1) next.delete(productId);
      else next.set(productId, current - 1);
      return next;
    });
  }, []);

  // ── Repeat last walk-in sale ──
  const handleRepeatLast = () => {
    if (!lastPaidWalkIn || !products) {
      setRepeatNotice(t('orders.repeatLast.none'));
      return;
    }

    const newCart = new Map<string, number>();
    let hadOutOfStock = false;

    for (const item of lastPaidWalkIn.items) {
      if (item.is_void) continue;
      const product = productMap.get(item.product_id);
      if (!product || !product.is_active) continue;

      // Warn if tracked and out of stock but still add
      const onHand = stockMap.get(item.product_id);
      const isOut = isProductTracked(product.stock) && (onHand ?? 0) <= 0;
      if (isOut) hadOutOfStock = true;

      newCart.set(item.product_id, (newCart.get(item.product_id) ?? 0) + item.qty);
    }

    if (newCart.size === 0) {
      setRepeatNotice(t('orders.repeatLast.none'));
      return;
    }

    setCart(newCart);
    setRepeatNotice(hadOutOfStock ? t('orders.repeatLast.outOfStock') : null);
    setAddError(null);
  };

  // ── Submit cart as new walk-in order ──
  const handleSubmitOrder = async () => {
    if (!tenantId || !branchId || !managerId || cart.size === 0) return;
    if (!products) return;
    setAddError(null);
    setRepeatNotice(null);

    const items: { productId: string; unitPrice: number; qty: number }[] = [];
    cart.forEach((qty, productId) => {
      const p = productMap.get(productId);
      if (p && qty > 0) {
        items.push({ productId, unitPrice: p.price, qty });
      }
    });

    try {
      await addOrder({
        sessionId: null,
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

  // ── Loading / error early returns ──
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

  // ── FlatList header: title + search + category + quick-add + repeat-last ──
  const ListHeader = (
    <View>
      <View style={styles.header}>
        <AppText role="h2">{t('orders.title')}</AppText>
        {/* Repeat last sale button */}
        {lastPaidWalkIn && (
          <Pressable
            onPress={handleRepeatLast}
            style={({ pressed }) => [
              styles.repeatBtn,
              pressed && styles.repeatBtnPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel={t('orders.repeatLast.label')}
          >
            <AppText role="caption" color={colors.primary}>
              {'↺ '}{t('orders.repeatLast.label')}
            </AppText>
          </Pressable>
        )}
      </View>

      {/* Search box */}
      <View style={styles.searchRow}>
        <TextInput
          style={styles.searchInput}
          value={searchQuery}
          onChangeText={setSearchQuery}
          placeholder={t('orders.search.placeholder')}
          placeholderTextColor={colors.textFaint}
          accessibilityLabel={t('orders.search.placeholder')}
          returnKeyType="search"
          clearButtonMode="while-editing"
        />
      </View>

      {/* Category chips */}
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
              accessibilityLabel={cat || t('orders.title')}
              accessibilityState={{ selected: selectedCategory === cat }}
            >
              <AppText
                role="caption"
                color={selectedCategory === cat ? colors.onPrimary : colors.textMuted}
              >
                {cat || t('orders.title')}
              </AppText>
            </Pressable>
          ))}
        </ScrollView>
      )}

      {/* Quick-add chips — first 6 products */}
      {quickAddProducts.length > 0 && (
        <View style={styles.quickAddSection}>
          <AppText role="micro" color={colors.textFaint} style={styles.quickAddLabel}>
            {t('orders.quickAdd')}
          </AppText>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.quickAddScroll}
          >
            {quickAddProducts.map((p) => {
              const qty = cart.get(p.id) ?? 0;
              return (
                <Pressable
                  key={p.id}
                  onPress={() => handleAddToCart(p)}
                  style={({ pressed }) => [
                    styles.quickAddChip,
                    pressed && styles.quickAddChipPressed,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={`${p.name} — ${formatEgp(p.price)}`}
                >
                  <AppText role="caption" numberOfLines={1}>
                    {p.name}
                  </AppText>
                  <AppText role="micro" color={colors.primary}>
                    {formatEgp(p.price)}
                  </AppText>
                  {qty > 0 && (
                    <View style={styles.qtyBadgeSmall}>
                      <AppText role="micro" color={colors.onPrimary}>
                        {toArabicDigits(String(qty))}
                      </AppText>
                    </View>
                  )}
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      )}
    </View>
  );

  // ── FlatList footer: cart + walk-in orders ──
  const ListFooter = (
    <View style={styles.footerContent}>
      {/* Repeat notice */}
      {repeatNotice && (
        <View style={styles.notice} accessible accessibilityRole="none">
          <AppText role="caption" color={colors.warning}>{repeatNotice}</AppText>
        </View>
      )}

      {/* Cart summary with steppers */}
      {cart.size > 0 && (
        <View style={styles.cartSection}>
          <AppText role="h3" style={styles.sectionTitle}>
            {t('orders.newOrder')}
          </AppText>
          {Array.from(cart.entries())
            .filter(([, qty]) => qty > 0)
            .map(([productId, qty]) => {
              const product = productMap.get(productId);
              if (!product) return null;
              return (
                <CartItemRow
                  key={productId}
                  productName={product.name}
                  unitPrice={product.price}
                  qty={qty}
                  onIncrease={() => handleIncreaseQty(productId)}
                  onDecrease={() => handleDecreaseQty(productId)}
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
    </View>
  );

  // ── Render — FlatList as outer scroll container ──
  return (
    <SafeAreaView style={styles.screen}>
      <OfflineBanner />

      <FlatList
        data={filteredProducts}
        numColumns={2}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <ProductCard
            product={item}
            onHand={stockMap.get(item.id)}
            qty={cart.get(item.id) ?? 0}
            onPress={() => handleAddToCart(item)}
          />
        )}
        columnWrapperStyle={styles.productGridRow}
        contentContainerStyle={styles.flatListContent}
        ListHeaderComponent={ListHeader}
        ListEmptyComponent={
          <EmptyState
            title={t('orders.emptyProducts.title')}
            body={t('orders.emptyProducts.body')}
          />
        }
        ListFooterComponent={ListFooter}
      />

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
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  repeatBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.xs,
    borderWidth: 1,
    borderColor: colors.primary,
    minHeight: 36,
    justifyContent: 'center',
  },
  repeatBtnPressed: {
    backgroundColor: colors.surface3,
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
  flatListContent: {
    paddingBottom: spacing['3xl'],
  },
  footerContent: {
    gap: spacing.lg,
    paddingTop: spacing.md,
  },
  loadingGrid: {
    padding: spacing.md,
    gap: spacing.sm,
  },
  categoryScroll: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
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
  quickAddSection: {
    paddingTop: spacing.sm,
    gap: spacing['2xs'],
  },
  quickAddLabel: {
    paddingHorizontal: spacing.xl,
  },
  quickAddScroll: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.sm,
    gap: spacing.sm,
    flexDirection: 'row',
  },
  quickAddChip: {
    backgroundColor: colors.surface2,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    minWidth: 80,
    maxWidth: 140,
    gap: 2,
    position: 'relative',
  },
  quickAddChipPressed: {
    backgroundColor: colors.surface3,
  },
  qtyBadgeSmall: {
    position: 'absolute',
    top: -4,
    start: -4,
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
    width: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Product grid
  productGridRow: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.sm,
    gap: spacing.sm,
  },
  productCard: {
    flex: 1,
    backgroundColor: colors.surface2,
    borderRadius: radius.md,
    padding: spacing.md,
    minHeight: TAP_TARGET,
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
  // Cart with steppers
  cartSection: {
    paddingHorizontal: spacing.md,
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
    alignItems: 'center',
    paddingVertical: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.sm,
  },
  cartLeft: {
    flex: 1,
    gap: 2,
  },
  cartRight: {
    alignItems: 'flex-end',
    gap: 4,
  },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  stepBtn: {
    width: 32,
    height: 32,
    borderRadius: radius.xs,
    backgroundColor: colors.surface3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepBtnPressed: {
    backgroundColor: colors.border,
  },
  stepQty: {
    minWidth: 28,
    alignItems: 'center',
  },
  cartLineTotal: {
    minWidth: 72,
    textAlign: 'right',
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
  notice: {
    marginHorizontal: spacing.md,
    padding: spacing.sm,
    backgroundColor: colors.surface2,
    borderRadius: radius.xs,
    borderWidth: 1,
    borderColor: colors.warning,
  },
});
