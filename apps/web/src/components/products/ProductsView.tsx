'use client';

/**
 * ProductsView — owner product catalog management page (Phase 5, AC A1–A5).
 *
 * Lists the tenant's products, filterable by category and active/inactive.
 * Products sorted by category then name (deterministic; matches mobile read path).
 * Owners can create / edit / deactivate / reactivate products.
 * Managers see the list read-only (no write controls — AC A1).
 *
 * HARD RULES:
 *  - Money always via @ps/core formatEgp + egpToPiastres / piastresToEgp.
 *  - All strings from i18n — no hardcoded user-facing text.
 *  - RTL layout — logical spacing only (start/end, ms/me/ps/pe).
 *  - Tenant isolation: tenant_id comes from RLS (JWT claim), never from client.
 *  - Audit write on create/update/deactivate/reactivate (ADR-0006 Decision 7).
 *  - Soft-delete only (is_active=false) — never hard-delete (AC A4).
 *  - Stock toggle: tracked ⇒ stock = integer ≥ 0; untracked ⇒ stock = null.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  formatEgp,
  toArabicDigits,
} from '@ps/core';
import type { Product } from '@ps/core';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { ProductForm } from './ProductForm';
import { getBrowserClient } from '@/lib/supabase/client';
import { useAuth } from '@/lib/auth/AuthContext';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProductsViewProps {
  /** true = owner (full CRUD); false = manager/staff (read-only list) */
  isOwner: boolean;
}

type Modal =
  | { type: 'create' }
  | { type: 'edit'; product: Product }
  | { type: 'deactivate'; product: Product }
  | { type: 'reactivate'; product: Product }
  | null;

type StatusFilter = 'all' | 'active' | 'inactive';

// ─── Stock badge ──────────────────────────────────────────────────────────────

function StockBadge({ product, t }: { product: Product; t: ReturnType<typeof useTranslations> }) {
  if (product.stock === null) {
    return (
      <span className="text-micro font-medium bg-surface-3 text-text-faint px-xs py-1 rounded-xs">
        {t('products.stock.untracked')}
      </span>
    );
  }
  const onHand = product.stock;
  if (onHand <= 0) {
    return (
      <span className="text-micro font-medium bg-danger/10 text-danger px-xs py-1 rounded-xs">
        {t('products.stock.out')}
      </span>
    );
  }
  if (onHand <= 5) {
    return (
      <span className="text-micro font-medium bg-warning/10 text-warning px-xs py-1 rounded-xs">
        {t('products.stock.low')} — {toArabicDigits(String(onHand))}
      </span>
    );
  }
  return (
    <span className="text-micro font-medium bg-success/10 text-success px-xs py-1 rounded-xs">
      {t('products.stock.ok')} — {toArabicDigits(String(onHand))}
    </span>
  );
}

// ─── Product card ─────────────────────────────────────────────────────────────

interface ProductCardProps {
  product: Product;
  isOwner: boolean;
  pending: boolean;
  onEdit: () => void;
  onDeactivate: () => void;
  onReactivate: () => void;
  t: ReturnType<typeof useTranslations>;
}

function ProductCard({
  product,
  isOwner,
  pending,
  onEdit,
  onDeactivate,
  onReactivate,
  t,
}: ProductCardProps) {
  const isInactive = !product.is_active;

  return (
    <article
      aria-label={`${product.name} — ${product.category || t('products.noCategory')}`}
      className={`rounded-md bg-surface border p-md flex flex-col sm:flex-row sm:items-center gap-sm transition-opacity
        ${isInactive ? 'opacity-50 border-border' : 'border-border hover:border-border-strong'}`}
    >
      {/* Status indicator dot */}
      <span
        className={`w-2 h-2 rounded-full flex-shrink-0 self-start mt-1
          ${isInactive ? 'bg-text-faint' : 'bg-status-free'}`}
        aria-hidden="true"
      />

      {/* Product details */}
      <div className="flex-1 min-w-0 space-y-2xs">
        {/* Name + category row */}
        <div className="flex flex-wrap items-center gap-xs">
          <span className="text-body font-medium text-text">{product.name}</span>

          {product.category && (
            <span className="text-micro font-medium bg-surface-3 text-text-muted px-xs py-1 rounded-xs">
              {product.category}
            </span>
          )}

          {isInactive && (
            <span className="text-micro font-medium text-text-faint">
              {t('products.status.inactive')}
            </span>
          )}
        </div>

        {/* Price row */}
        <div className="flex flex-wrap items-center gap-md">
          {/* Sale price — money via formatEgp (AC A3, CLAUDE.md §2.1) */}
          <p className="text-h3 text-text tabular-nums" dir="ltr">
            {formatEgp(product.price)}
          </p>

          {/* Cost (optional) */}
          {product.cost != null && (
            <p className="text-caption text-text-muted tabular-nums" dir="ltr">
              {t('products.table.cost')}: {formatEgp(product.cost)}
            </p>
          )}

          {/* Stock badge */}
          <StockBadge product={product} t={t} />
        </div>
      </div>

      {/* Owner-only action buttons */}
      {isOwner && (
        <div className="flex items-center gap-sm flex-shrink-0">
          <Button
            variant="ghost"
            size="md"
            onClick={onEdit}
            aria-label={`${t('products.edit')} ${product.name}`}
            className="h-9 px-sm text-text-muted"
            disabled={pending}
          >
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
          </Button>

          {/* Deactivate / Reactivate — spatially separated from edit */}
          {isInactive ? (
            <Button
              variant="secondary"
              size="md"
              onClick={onReactivate}
              aria-label={`${t('products.action.reactivate')} ${product.name}`}
              className="h-9 px-sm"
              loading={pending}
            >
              {t('products.action.reactivate')}
            </Button>
          ) : (
            <Button
              variant="danger"
              size="md"
              onClick={onDeactivate}
              aria-label={`${t('products.action.deactivate')} ${product.name}`}
              className="h-9 px-sm"
              loading={pending}
            >
              {t('products.action.deactivate')}
            </Button>
          )}
        </div>
      )}
    </article>
  );
}

// ─── Modal overlay ────────────────────────────────────────────────────────────

// ModalOverlay replaced by the shared <Dialog> component (ADR-0011 §Q5 a11y).

// ─── Confirm dialog ───────────────────────────────────────────────────────────

interface ConfirmDialogProps {
  message: string;
  confirmLabel: string;
  confirmVariant: 'primary' | 'danger';
  loading: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmDialog({
  message,
  confirmLabel,
  confirmVariant,
  loading,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const t = useTranslations();
  return (
    <div className="space-y-lg">
      <p className="text-body text-text">{message}</p>
      <div className="flex gap-md justify-end">
        <Button variant="secondary" onClick={onCancel} disabled={loading}>
          {t('products.action.cancel')}
        </Button>
        <Button variant={confirmVariant} onClick={onConfirm} loading={loading}>
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}

// ─── Main view ────────────────────────────────────────────────────────────────

export function ProductsView({ isOwner }: ProductsViewProps) {
  const t = useTranslations();
  const { claim, user } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  // Filter state
  const [categoryFilter, setCategoryFilter] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');

  const fetchProducts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const supabase = getBrowserClient();
      // RLS ensures only this tenant's products are returned (JWT claim gates rows).
      const { data, error: err } = await supabase
        .from('products')
        .select('*')
        .order('category', { ascending: true })
        .order('name', { ascending: true });
      if (err) throw err;
      setProducts((data as Product[]) ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchProducts();
  }, [fetchProducts]);

  // Derive unique categories for the filter dropdown
  const categories = useMemo(() => {
    const cats = new Set<string>();
    for (const p of products) {
      if (p.category) cats.add(p.category);
    }
    return [...cats].sort();
  }, [products]);

  // Apply filters
  const filteredProducts = useMemo(() => {
    return products.filter((p) => {
      if (categoryFilter && p.category !== categoryFilter) return false;
      if (statusFilter === 'active' && !p.is_active) return false;
      if (statusFilter === 'inactive' && p.is_active) return false;
      return true;
    });
  }, [products, categoryFilter, statusFilter]);

  // Group filtered products by category for display
  const grouped = useMemo(() => {
    const map = new Map<string, Product[]>();
    for (const p of filteredProducts) {
      const cat = p.category || '';
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(p);
    }
    return map;
  }, [filteredProducts]);

  function handleSaved(product: Product) {
    setProducts((prev) => {
      const idx = prev.findIndex((p) => p.id === product.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = product;
        return next;
      }
      return [product, ...prev];
    });
    setModal(null);
  }

  // Soft-deactivate (AC A4): set is_active=false, never hard-delete
  async function handleDeactivate(product: Product) {
    setPendingId(product.id);
    try {
      const supabase = getBrowserClient();
      const tenantId = claim?.tenant_id;
      const actorId = user?.id;
      if (!tenantId || !actorId) throw new Error('Not authenticated');

      const now = new Date().toISOString();
      const { error: err } = await supabase
        .from('products')
        .update({ is_active: false, updated_at: now })
        .eq('id', product.id);
      if (err) throw err;

      // Audit write removed: migration 0011 audit_config_change trigger handles
      // this atomically on the products UPDATE (ADR-0011 §Q3).

      setProducts((prev) =>
        prev.map((p) => (p.id === product.id ? { ...p, is_active: false } : p)),
      );
      setModal(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setPendingId(null);
    }
  }

  // Reactivate: set is_active=true (symmetric to deactivate)
  async function handleReactivate(product: Product) {
    setPendingId(product.id);
    try {
      const supabase = getBrowserClient();
      const tenantId = claim?.tenant_id;
      const actorId = user?.id;
      if (!tenantId || !actorId) throw new Error('Not authenticated');

      const now = new Date().toISOString();
      const { error: err } = await supabase
        .from('products')
        .update({ is_active: true, updated_at: now })
        .eq('id', product.id);
      if (err) throw err;

      // Audit write removed: migration 0011 audit_config_change trigger handles
      // this atomically on the products UPDATE (ADR-0011 §Q3).

      setProducts((prev) =>
        prev.map((p) => (p.id === product.id ? { ...p, is_active: true } : p)),
      );
      setModal(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="space-y-2xl">
      {/* Header */}
      <div className="flex items-center justify-between gap-md">
        <div>
          <h1 className="text-h1 text-text">{t('products.title')}</h1>
          <p className="text-label text-text-muted mt-xs">{t('products.subtitle')}</p>
        </div>
        {isOwner && (
          <Button
            variant="primary"
            onClick={() => setModal({ type: 'create' })}
            aria-label={t('products.create')}
          >
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            {t('products.create')}
          </Button>
        )}
      </div>

      {/* Filter bar */}
      {!loading && !error && products.length > 0 && (
        <div className="flex flex-wrap items-center gap-md">
          {/* Category filter */}
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            aria-label={t('products.filter.allCategories')}
            className="h-9 px-sm rounded-sm text-label text-text bg-surface-3 border border-border
              transition-colors duration-fast focus:outline-none focus:ring-2 focus:ring-primary focus:border-border-strong"
          >
            <option value="">{t('products.filter.allCategories')}</option>
            {categories.map((cat) => (
              <option key={cat} value={cat}>{cat}</option>
            ))}
          </select>

          {/* Status filter */}
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            aria-label={t('products.filter.allStatuses')}
            className="h-9 px-sm rounded-sm text-label text-text bg-surface-3 border border-border
              transition-colors duration-fast focus:outline-none focus:ring-2 focus:ring-primary focus:border-border-strong"
          >
            <option value="all">{t('products.filter.allStatuses')}</option>
            <option value="active">{t('products.filter.active')}</option>
            <option value="inactive">{t('products.filter.inactive')}</option>
          </select>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="space-y-md" aria-busy="true" aria-label={t('state.loading')}>
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 rounded-md bg-surface-2 animate-pulse" />
          ))}
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <ErrorState message={error} onRetry={fetchProducts} />
      )}

      {/* Empty (no products at all) */}
      {!loading && !error && products.length === 0 && (
        <EmptyState
          title={t('products.empty.title')}
          body={t('products.empty.body')}
          action={
            isOwner ? (
              <Button variant="primary" onClick={() => setModal({ type: 'create' })}>
                {t('products.create')}
              </Button>
            ) : undefined
          }
        />
      )}

      {/* Empty after filtering */}
      {!loading && !error && products.length > 0 && filteredProducts.length === 0 && (
        <EmptyState
          title={t('products.empty.title')}
          body={t('products.empty.body')}
        />
      )}

      {/* Product groups (by category) */}
      {!loading && !error && filteredProducts.length > 0 && (
        <div className="space-y-2xl">
          {[...grouped.entries()].map(([category, group]) => (
            <section key={category || '__uncategorised'} aria-labelledby={`cat-${category || 'none'}`}>
              <h2
                id={`cat-${category || 'none'}`}
                className="text-h2 text-text mb-md pb-sm border-b border-border"
              >
                {category || t('products.noCategory')}
              </h2>
              <div className="space-y-sm">
                {group.map((product) => (
                  <ProductCard
                    key={product.id}
                    product={product}
                    isOwner={isOwner}
                    pending={pendingId === product.id}
                    onEdit={() => setModal({ type: 'edit', product })}
                    onDeactivate={() => setModal({ type: 'deactivate', product })}
                    onReactivate={() => setModal({ type: 'reactivate', product })}
                    t={t}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {/* Accessible dialog — focus trap, focus return, Escape key (ADR-0011 §Q5) */}
      {modal && modal.type === 'create' && (
        <Dialog labelledBy="products-dialog-title" onClose={() => setModal(null)}>
          <div className="space-y-lg">
            <h2 id="products-dialog-title" className="text-h2 text-text">
              {t('products.create')}
            </h2>
            <ProductForm onSuccess={handleSaved} onCancel={() => setModal(null)} />
          </div>
        </Dialog>
      )}

      {modal && modal.type === 'edit' && (
        <Dialog labelledBy="products-dialog-title" onClose={() => setModal(null)}>
          <div className="space-y-lg">
            <h2 id="products-dialog-title" className="text-h2 text-text">
              {t('products.edit')}
            </h2>
            <ProductForm
              initial={modal.product}
              onSuccess={handleSaved}
              onCancel={() => setModal(null)}
            />
          </div>
        </Dialog>
      )}

      {modal && modal.type === 'deactivate' && (
        <Dialog ariaLabel={t('products.action.deactivate')} onClose={() => setModal(null)}>
          <ConfirmDialog
            message={t('products.action.deactivateConfirm')}
            confirmLabel={t('products.action.deactivate')}
            confirmVariant="danger"
            loading={pendingId === modal.product.id}
            onConfirm={() => void handleDeactivate(modal.product)}
            onCancel={() => setModal(null)}
          />
        </Dialog>
      )}

      {modal && modal.type === 'reactivate' && (
        <Dialog ariaLabel={t('products.action.reactivate')} onClose={() => setModal(null)}>
          <ConfirmDialog
            message={t('products.action.reactivateConfirm')}
            confirmLabel={t('products.action.reactivate')}
            confirmVariant="primary"
            loading={pendingId === modal.product.id}
            onConfirm={() => void handleReactivate(modal.product)}
            onCancel={() => setModal(null)}
          />
        </Dialog>
      )}
    </div>
  );
}
