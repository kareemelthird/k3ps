'use client';

/**
 * ProductForm — create / edit a product (owner-only write).
 *
 * HARD RULES:
 *  - Money entered in EGP, converted to integer piastres via @ps/core egpToPiastres.
 *  - Rendered back via piastresToEgp + formatEgp. Never stores or computes floats.
 *  - All strings from i18n — no hardcoded user-facing text.
 *  - RTL: logical spacing (start/end), labels align to start.
 *  - Validation per AC A2: name required; price required ≥0; cost optional ≥0;
 *    stock toggle: tracked ⇒ integer ≥0 (products.stock = integer = opening count,
 *    per ADR-0006 Decision 5 — no initial movement written); untracked ⇒ stock=null.
 *  - Client-generated UUID for idempotent upsert (CLAUDE.md §2.8).
 *  - Audit write on create/update (ADR-0006 Decision 7; action 'product.create|update').
 *  - stock = products.stock column (opening count); no separate stock_movements row
 *    on create (ADR-0006 Decision 5).
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  egpToPiastres,
  piastresToEgp,
  uuidv4,
  uuidv5,
  PS_UUID_NS,
} from '@ps/core';
import type { Product } from '@ps/core';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { getBrowserClient } from '@/lib/supabase/client';
import { useAuth } from '@/lib/auth/AuthContext';

// ─── Types ────────────────────────────────────────────────────────────────────

type FormErrors = Partial<Record<string, string>>;

interface ProductFormProps {
  /** Existing product to edit; undefined = create new. */
  initial?: Product;
  onSuccess: (product: Product) => void;
  onCancel: () => void;
}

// ─── Helper: EGP display ↔ piastres storage ──────────────────────────────────

/** Piastres → EGP display string (never raw piastres in the UI). */
function toEgpStr(piastres: number | null | undefined): string {
  if (piastres == null) return '';
  return String(piastresToEgp(piastres));
}

/**
 * EGP string → integer piastres. Returns null if blank or not a valid number.
 * Normalises Arabic/Western comma decimals (e.g. "5,5" → 5.5).
 * Rejects trailing garbage ("5abc") that parseFloat would silently accept.
 */
function fromEgpStr(s: string): number | null {
  const normalised = s.trim().replace(',', '.');
  if (normalised === '') return null;
  if (!/^-?\d+(\.\d+)?$/.test(normalised)) return null;
  const egp = Number(normalised);
  if (!isFinite(egp)) return null;
  return egpToPiastres(egp);
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validate(
  f: FormState,
  t: ReturnType<typeof useTranslations>,
): FormErrors {
  const errors: FormErrors = {};

  // Name: required, non-empty (Arabic-capable text — no language restriction in
  // the DB; the UI label signals Arabic as expected per the spec).
  if (!f.name.trim()) {
    errors['name'] = t('products.validation.nameRequired');
  }

  // Price: required, ≥ 0 piastres (AC A2)
  const price = fromEgpStr(f.price_egp);
  if (price == null) {
    errors['price_egp'] = t('products.validation.priceRequired');
  } else if (price < 0) {
    errors['price_egp'] = t('products.validation.priceNonNegative');
  }

  // Cost: optional, but if provided must be ≥ 0 (AC A2)
  if (f.cost_egp.trim() !== '') {
    const cost = fromEgpStr(f.cost_egp);
    if (cost == null || cost < 0) {
      errors['cost_egp'] = t('products.validation.costNonNegative');
    }
  }

  // Stock: if tracking enabled, opening stock must be a non-negative integer (AC A2)
  if (f.stock_tracked) {
    const stockVal = f.opening_stock.trim();
    if (stockVal === '') {
      errors['opening_stock'] = t('products.validation.stockRequired');
    } else {
      const stock = parseInt(stockVal, 10);
      if (isNaN(stock) || stock < 0) {
        errors['opening_stock'] = t('products.validation.stockNonNegative');
      }
    }
  }

  return errors;
}

// ─── Form state ───────────────────────────────────────────────────────────────

interface FormState {
  name: string;
  category: string;
  price_egp: string;
  cost_egp: string;
  /** true = tracked (stock = integer); false = untracked (stock = null) */
  stock_tracked: boolean;
  /** Only meaningful when stock_tracked = true. String for controlled input. */
  opening_stock: string;
  is_active: boolean;
}

function toFormState(product?: Product): FormState {
  if (!product) {
    return {
      name: '',
      category: '',
      price_egp: '',
      cost_egp: '',
      stock_tracked: false,
      opening_stock: '0',
      is_active: true,
    };
  }
  return {
    name: product.name,
    category: product.category,
    price_egp: toEgpStr(product.price),
    cost_egp: toEgpStr(product.cost),
    stock_tracked: product.stock !== null,
    opening_stock: product.stock != null ? String(product.stock) : '0',
    is_active: product.is_active,
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ProductForm({ initial, onSuccess, onCancel }: ProductFormProps) {
  const t = useTranslations();
  const { claim, user } = useAuth();
  const [form, setForm] = useState<FormState>(toFormState(initial));
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: undefined }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const errs = validate(form, t);
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      // Focus the first error field (TextField uses the id prop directly as the element id)
      const firstKey = Object.keys(errs)[0];
      if (firstKey) {
        // Map form key → element id (matches the id prop passed to TextField)
        const fieldIdMap: Record<string, string> = {
          name: 'name',
          price_egp: 'price_egp',
          cost_egp: 'cost_egp',
          opening_stock: 'opening_stock',
        };
        const elId = fieldIdMap[firstKey] ?? firstKey;
        const el = document.getElementById(elId);
        if (el) (el as HTMLElement).focus();
      }
      return;
    }

    setSaving(true);
    setSaveError(null);

    try {
      const supabase = getBrowserClient();

      // Tenant identity comes from the signed JWT claim (app_metadata.tenant_id).
      // The client sends its own claim value; RLS WITH CHECK validates it server-side.
      // An attacker sending a different tenant_id is rejected by the policy.
      // (CLAUDE.md §5, ADR-0003 — never bypass RLS or scope with service role.)
      const tenantId = claim?.tenant_id;
      const actorId = user?.id;
      if (!tenantId || !actorId) throw new Error('Not authenticated');

      const id = initial?.id ?? uuidv4();
      const now = new Date().toISOString();

      // Convert EGP → piastres for storage (CLAUDE.md §2.1, AC A3)
      const price = fromEgpStr(form.price_egp) ?? 0;
      const cost = form.cost_egp.trim() !== '' ? fromEgpStr(form.cost_egp) : null;

      // Stock column:
      //   tracked ⇒ integer opening count (products.stock = opening count, no separate
      //              initial movement — ADR-0006 Decision 5)
      //   untracked ⇒ null
      const stock = form.stock_tracked ? parseInt(form.opening_stock.trim(), 10) : null;

      const row = {
        id,
        // tenant_id from the JWT claim: client sends its own claim value and RLS
        // WITH CHECK (tenant_id = current_tenant_id()) validates it server-side.
        // This is the correct pattern — NOT a trust violation (ADR-0003, CLAUDE.md §5).
        tenant_id: tenantId,
        name: form.name.trim(),
        category: form.category.trim(),
        price,
        cost: cost ?? null,
        stock,
        is_active: form.is_active,
        updated_at: now,
        ...(initial == null ? { created_at: now } : {}),
      };

      // Upsert (idempotent — client-generated UUID, CLAUDE.md §2.8)
      const { data, error } = await supabase
        .from('products')
        .upsert(row, { onConflict: 'id' })
        .select()
        .single();

      if (error) throw error;

      // Write audit_log row (ADR-0006 Decision 7; action taxonomy locked)
      // action: 'product.create' on insert, 'product.update' on edit.
      // amount: null (catalog config change, not a money transaction per ADR-0006).
      const action = initial == null ? 'product.create' : 'product.update';
      const auditMeta =
        initial == null
          ? { snapshot: { name: row.name, category: row.category, price: row.price, cost: row.cost, stock: row.stock } }
          : {
              before: {
                name: initial.name,
                category: initial.category,
                price: initial.price,
                cost: initial.cost,
                stock: initial.stock,
                is_active: initial.is_active,
              },
              after: {
                name: row.name,
                category: row.category,
                price: row.price,
                cost: row.cost,
                stock: row.stock,
                is_active: row.is_active,
              },
            };

      // Audit write is an IDEMPOTENT upsert (ADR-0006 Decision 7, CLAUDE.md §2.8).
      // The id is deterministic from the operation's identity (action:productId:instant)
      // so a double-fire of the same save upserts the same row instead of duplicating.
      // The error is surfaced (not swallowed): a missing audit row on a money-config
      // change must be visible (CLAUDE.md §2.7).
      // tenant_id and actor_id are required NOT NULL columns (0002 migration).
      const { error: auditErr } = await supabase.from('audit_log').upsert(
        {
          id: uuidv5(`${action}:${id}:${now}`, PS_UUID_NS),
          tenant_id: tenantId,
          actor_id: actorId,
          action,
          entity: 'product',
          entity_id: id,
          amount: null,
          meta: auditMeta,
          created_at: now,
        },
        { onConflict: 'id' },
      );
      if (auditErr) throw auditErr;

      onSuccess(data as Product);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} noValidate className="space-y-lg">
      {/* Name — required (Arabic text) */}
      <TextField
        id="name"
        label={t('products.field.name')}
        value={form.name}
        onChange={(e) => set('name', e.target.value)}
        helper={t('products.field.nameHelper')}
        required
        error={errors['name']}
        autoComplete="off"
      />

      {/* Category — optional */}
      <TextField
        id="category"
        label={t('products.field.category')}
        value={form.category}
        onChange={(e) => set('category', e.target.value)}
        helper={t('products.field.categoryHelper')}
        error={errors['category']}
        autoComplete="off"
      />

      {/* Price — required, EGP input → piastres storage (AC A3) */}
      <TextField
        id="price_egp"
        label={t('products.field.price')}
        type="number"
        inputMode="decimal"
        min="0"
        step="0.01"
        value={form.price_egp}
        onChange={(e) => set('price_egp', e.target.value)}
        helper={t('products.field.priceHelper')}
        required
        error={errors['price_egp']}
      />

      {/* Cost — optional, EGP input → piastres storage */}
      <TextField
        id="cost_egp"
        label={t('products.field.cost')}
        type="number"
        inputMode="decimal"
        min="0"
        step="0.01"
        value={form.cost_egp}
        onChange={(e) => set('cost_egp', e.target.value)}
        helper={t('products.field.costHelper')}
        error={errors['cost_egp']}
      />

      {/* Stock tracking toggle */}
      <div className="flex flex-col gap-xs">
        <div className="flex items-center gap-sm">
          <button
            type="button"
            role="switch"
            aria-checked={form.stock_tracked}
            aria-label={t('products.field.stockTracking')}
            onClick={() => set('stock_tracked', !form.stock_tracked)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary
              ${form.stock_tracked ? 'bg-primary' : 'bg-surface-3 border border-border'}`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-fast
                ${form.stock_tracked ? 'translate-x-6' : 'translate-x-1'}`}
              aria-hidden="true"
            />
          </button>
          <label
            className="text-label font-medium text-text-muted cursor-pointer select-none"
            onClick={() => set('stock_tracked', !form.stock_tracked)}
          >
            {t('products.field.stockTracking')}
          </label>
        </div>
        <p className="text-caption text-text-faint text-start ps-[52px]">
          {t('products.field.stockTrackingHelper')}
        </p>
      </div>

      {/* Opening stock — shown only when tracking is enabled */}
      {form.stock_tracked && (
        <TextField
          id="opening_stock"
          label={t('products.field.openingStock')}
          type="number"
          inputMode="numeric"
          min="0"
          step="1"
          value={form.opening_stock}
          onChange={(e) => set('opening_stock', e.target.value)}
          helper={t('products.field.openingStockHelper')}
          required
          error={errors['opening_stock']}
        />
      )}

      {/* Save error */}
      {saveError && (
        <p role="alert" aria-live="assertive" className="text-caption text-danger text-start">
          {saveError}
        </p>
      )}

      {/* Actions */}
      <div className="flex gap-md justify-end pt-sm">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={saving}>
          {t('products.action.cancel')}
        </Button>
        <Button type="submit" variant="primary" loading={saving}>
          {t('products.action.save')}
        </Button>
      </div>
    </form>
  );
}
