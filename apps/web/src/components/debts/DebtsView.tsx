'use client';

/**
 * DebtsView — owner debts and customer-credit management page (Slice 3).
 *
 * Shows all debts for the tenant (RLS-scoped), with:
 *   - KPI row: total outstanding, open count, partially-paid count.
 *   - Status filter: all / non-settled / settled (segmented toggle).
 *   - Debt cards: customer name, amount, paid_total, remaining, status badge, date.
 *   - Record Payment dialog per non-settled debt: amount input (default = remaining),
 *     validates ≤ remaining, inserts into debt_payments, refetches on success.
 *     The AFTER-INSERT trigger auto-updates the parent debt's paid_total + status.
 *
 * HARD RULES:
 *  - Money via @ps/core formatEgp (piastres) + egpToPiastres for input conversion.
 *  - All strings from i18n — no hardcoded Arabic.
 *  - RTL: logical spacing only (start/end, ms/me/ps/pe). No left/right.
 *  - Tenant isolation: RLS handles row filtering; tenant_id from claim (not client body).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatEgp, toArabicDigits, egpToPiastres, piastresToEgp } from '@ps/core';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { getBrowserClient } from '@/lib/supabase/client';
import { useAuth } from '@/lib/auth/AuthContext';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DebtRow {
  id: string;
  tenant_id: string;
  customer_id: string | null;
  customer_name: string;
  amount: number;       // integer piastres (total charged)
  paid_total: number;   // integer piastres (sum of debt_payments)
  note: string | null;
  status: 'open' | 'partially_paid' | 'settled';
  created_at: string;
}

type StatusFilter = 'all' | 'non_settled' | 'settled';

type Modal = { type: 'payment'; debt: DebtRow } | null;

// ─── KPI Hero tile (mirrors OwnerHomeView gradient style) ─────────────────────

function HeroTile({
  label,
  hero,
  loading,
}: {
  label: string;
  hero: string;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div
        className="rounded-md shadow-e1 p-md flex flex-col gap-xs min-h-[120px]"
        style={{ background: 'linear-gradient(135deg, #F59E0B 0%, #D97706 100%)' }}
        aria-busy="true"
      >
        <div
          className="h-4 w-24 rounded animate-pulse"
          style={{ backgroundColor: 'rgba(255,255,255,0.2)' }}
        />
        <div
          className="h-10 w-28 mt-xs rounded animate-pulse"
          style={{ backgroundColor: 'rgba(255,255,255,0.2)' }}
        />
      </div>
    );
  }

  return (
    <div
      className="rounded-md shadow-e1 p-md flex flex-col gap-xs min-h-[120px]"
      style={{ background: 'linear-gradient(135deg, #F59E0B 0%, #D97706 100%)' }}
      aria-label={`${label}: ${hero}`}
    >
      <p
        className="text-caption font-medium"
        style={{ color: 'rgba(255,255,255,0.85)' }}
      >
        {label}
      </p>
      <p
        className="text-display font-bold tabular-nums leading-none"
        dir="ltr"
        style={{ color: '#ffffff' }}
      >
        {hero}
      </p>
    </div>
  );
}

// ─── Stat tile (mirrors OwnerHomeView StatTile) ────────────────────────────────

function StatTile({
  label,
  hero,
  accentColor = '#14B8A6',
  loading,
}: {
  label: string;
  hero: string;
  accentColor?: string;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="rounded-md bg-surface border border-border shadow-e1 p-md flex flex-col gap-xs">
        <div className="h-4 w-24 rounded bg-surface-2 animate-pulse" />
        <div className="h-8 w-20 mt-xs rounded bg-surface-2 animate-pulse" />
      </div>
    );
  }

  return (
    <div
      className="rounded-md bg-surface border border-border shadow-e1 p-md flex flex-col gap-xs"
      aria-label={`${label}: ${hero}`}
    >
      <div className="flex items-center gap-xs">
        <span
          aria-hidden="true"
          className="w-2 h-2 rounded-pill flex-shrink-0"
          style={{ backgroundColor: accentColor }}
        />
        <p className="text-caption text-text-muted">{label}</p>
      </div>
      <p className="text-display text-text font-bold tabular-nums leading-none">{hero}</p>
    </div>
  );
}

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({
  status,
  t,
}: {
  status: DebtRow['status'];
  t: ReturnType<typeof useTranslations>;
}) {
  const styles: Record<DebtRow['status'], string> = {
    open: 'bg-warning/10 text-warning',
    partially_paid: 'bg-primary/10 text-primary',
    settled: 'bg-success/10 text-success',
  };

  return (
    <span
      className={`text-micro font-medium px-xs py-0.5 rounded-xs ${styles[status]}`}
    >
      {t(`debts.status.${status}`)}
    </span>
  );
}

// ─── Debt card ────────────────────────────────────────────────────────────────

function DebtCard({
  debt,
  onRecordPayment,
  t,
}: {
  debt: DebtRow;
  onRecordPayment: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const remaining = debt.amount - debt.paid_total;
  const isSettled = debt.status === 'settled';

  // ar-EG locale produces Arabic-Indic digits natively
  const dateStr = new Date(debt.created_at).toLocaleDateString('ar-EG', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  const dotColor =
    debt.status === 'settled'
      ? 'bg-success'
      : debt.status === 'partially_paid'
        ? 'bg-primary'
        : 'bg-warning';

  return (
    <article
      aria-label={`${debt.customer_name} — ${t(`debts.status.${debt.status}`)}`}
      className={`rounded-md bg-surface border p-md flex flex-col sm:flex-row sm:items-center gap-sm transition-opacity
        ${isSettled ? 'opacity-60 border-border' : 'border-border hover:border-border-strong'}`}
    >
      {/* Status indicator dot */}
      <span
        aria-hidden="true"
        className={`w-2 h-2 rounded-full flex-shrink-0 self-start mt-1.5 ${dotColor}`}
      />

      {/* Details */}
      <div className="flex-1 min-w-0 space-y-2xs">
        {/* Name + status badge row */}
        <div className="flex flex-wrap items-center gap-xs">
          <span className="text-body font-medium text-text">{debt.customer_name}</span>
          <StatusBadge status={debt.status} t={t} />
          {debt.note && (
            <span
              className="text-caption text-text-faint truncate max-w-[200px]"
              title={debt.note}
            >
              {debt.note}
            </span>
          )}
        </div>

        {/* Amounts row */}
        <div className="flex flex-wrap items-center gap-md">
          <span className="text-caption text-text-muted">
            {t('debts.col.amount')}:{' '}
            <span className="tabular-nums" dir="ltr">
              {formatEgp(debt.amount)}
            </span>
          </span>

          {debt.paid_total > 0 && (
            <span className="text-caption text-text-muted">
              {t('debts.col.paid')}:{' '}
              <span className="tabular-nums text-success" dir="ltr">
                {formatEgp(debt.paid_total)}
              </span>
            </span>
          )}

          {!isSettled && remaining > 0 && (
            <span className="text-caption font-medium text-text">
              {t('debts.col.remaining')}:{' '}
              <span className="tabular-nums text-warning" dir="ltr">
                {formatEgp(remaining)}
              </span>
            </span>
          )}

          <span className="text-caption text-text-faint">{dateStr}</span>
        </div>
      </div>

      {/* Record payment button — only for non-settled debts */}
      {!isSettled && (
        <div className="flex items-center flex-shrink-0">
          <Button
            variant="secondary"
            size="md"
            onClick={onRecordPayment}
            aria-label={`${t('debts.action.recordPayment')} — ${debt.customer_name}`}
            className="h-9 px-sm"
          >
            {t('debts.action.recordPayment')}
          </Button>
        </div>
      )}
    </article>
  );
}

// ─── Payment form ─────────────────────────────────────────────────────────────

function PaymentForm({
  debt,
  onClose,
  onSuccess,
}: {
  debt: DebtRow;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const t = useTranslations();
  const { claim, user } = useAuth();

  const remaining = debt.amount - debt.paid_total;

  // Default to the full remaining amount, displayed in EGP
  const [amountEgp, setAmountEgp] = useState<string>(
    String(piastresToEgp(remaining)),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const parsed = parseFloat(amountEgp);
    if (!amountEgp || isNaN(parsed)) {
      setError(t('debts.validation.amountRequired'));
      return;
    }
    if (parsed <= 0) {
      setError(t('debts.validation.amountPositive'));
      return;
    }

    // Convert to piastres (integer) via @ps/core — never do inline math
    const piastres = egpToPiastres(parsed);

    if (piastres > remaining) {
      setError(t('debts.validation.amountExceedsRemaining'));
      return;
    }

    setLoading(true);
    try {
      const supabase = getBrowserClient();

      // tenant_id is set explicitly so the RLS WITH CHECK can verify it matches
      // the JWT claim. manager_id = current authenticated user's id.
      const { error: err } = await supabase.from('debt_payments').insert({
        tenant_id: claim?.tenant_id,
        debt_id: debt.id,
        amount: piastres,
        manager_id: user?.id,
        shift_id: null,   // no active shift required on the web dashboard
      });

      if (err) throw err;

      // The AFTER-INSERT trigger has already updated debt.paid_total + status.
      // Just signal success — the caller refetches.
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} noValidate className="space-y-md">
      {/* Debt summary */}
      <div className="p-sm rounded-sm bg-surface-3 border border-border space-y-xs">
        <p className="text-label font-medium text-text">{debt.customer_name}</p>
        <p className="text-caption text-text-muted">
          {t('debts.col.remaining')}:{' '}
          <span className="tabular-nums font-medium text-warning" dir="ltr">
            {formatEgp(remaining)}
          </span>
        </p>
      </div>

      {/* Amount input — in EGP; we convert to piastres on submit */}
      <div className="space-y-xs">
        <label htmlFor="payment-amount" className="text-label text-text">
          {t('debts.payment.amountLabel')}
          <span aria-hidden="true" className="text-danger ms-1">*</span>
        </label>
        <input
          id="payment-amount"
          type="number"
          min="0.01"
          step="0.01"
          value={amountEgp}
          onChange={(e) => setAmountEgp(e.target.value)}
          required
          inputMode="decimal"
          dir="ltr"
          className="w-full h-[52px] px-sm rounded-sm text-label text-text bg-surface-3 border border-border
            transition-colors duration-fast focus:outline-none focus:ring-2 focus:ring-primary focus:border-border-strong"
          aria-describedby="payment-amount-helper"
        />
        <p id="payment-amount-helper" className="text-caption text-text-faint">
          {t('debts.payment.amountHelper', { remaining: formatEgp(remaining) })}
        </p>
      </div>

      {/* Inline error */}
      {error && (
        <p role="alert" className="text-label text-danger">
          {error}
        </p>
      )}

      {/* Actions */}
      <div className="flex gap-md justify-end pt-xs">
        <Button
          type="button"
          variant="secondary"
          onClick={onClose}
          disabled={loading}
        >
          {t('debts.action.cancel')}
        </Button>
        <Button type="submit" variant="primary" loading={loading}>
          {t('debts.action.confirm')}
        </Button>
      </div>
    </form>
  );
}

// ─── Main view ────────────────────────────────────────────────────────────────

export function DebtsView() {
  const t = useTranslations();

  const [debts, setDebts] = useState<DebtRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [filter, setFilter] = useState<StatusFilter>('non_settled');
  const [successBanner, setSuccessBanner] = useState(false);

  // Fetch all debts — RLS gates to tenant from JWT claim
  const fetchDebts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const supabase = getBrowserClient();
      const { data, error: err } = await supabase
        .from('debts')
        .select(
          'id, tenant_id, customer_id, customer_name, amount, paid_total, note, status, created_at',
        )
        .order('created_at', { ascending: false });

      if (err) throw err;
      setDebts((data as DebtRow[]) ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchDebts();
  }, [fetchDebts]);

  // ── KPI derivations ────────────────────────────────────────────────────────
  const kpi = useMemo(() => {
    const nonSettled = debts.filter((d) => d.status !== 'settled');
    const outstanding = nonSettled.reduce(
      (sum, d) => sum + (d.amount - d.paid_total),
      0,
    );
    const openCount = debts.filter((d) => d.status === 'open').length;
    const partialCount = debts.filter((d) => d.status === 'partially_paid').length;
    return { outstanding, openCount, partialCount };
  }, [debts]);

  // ── Filtered list ──────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    if (filter === 'all') return debts;
    if (filter === 'non_settled') return debts.filter((d) => d.status !== 'settled');
    if (filter === 'settled') return debts.filter((d) => d.status === 'settled');
    return debts;
  }, [debts, filter]);

  // ── Payment success handler ────────────────────────────────────────────────
  function handlePaymentSuccess() {
    setModal(null);
    setSuccessBanner(true);
    setTimeout(() => setSuccessBanner(false), 3500);
    void fetchDebts();
  }

  // ── Filter toggle options ──────────────────────────────────────────────────
  const filterOptions: { value: StatusFilter; label: string }[] = [
    { value: 'all', label: t('debts.filter.all') },
    { value: 'non_settled', label: t('debts.filter.nonSettled') },
    { value: 'settled', label: t('debts.filter.settled') },
  ];

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-2xl">
      {/* Page header */}
      <div>
        <h1 className="text-h1 text-text font-bold">{t('debts.title')}</h1>
        <p className="text-body text-text-muted mt-xs">{t('debts.subtitle')}</p>
      </div>

      {/* KPI tile row — 1 col mobile, 3 col sm+ */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-card">
        {/* Gradient hero: total outstanding */}
        <HeroTile
          label={t('debts.kpi.outstanding')}
          hero={formatEgp(kpi.outstanding)}
          loading={loading}
        />

        {/* Stat: open debts count */}
        <StatTile
          label={t('debts.kpi.openCount')}
          hero={toArabicDigits(String(kpi.openCount))}
          accentColor="#F59E0B"
          loading={loading}
        />

        {/* Stat: partially-paid count */}
        <StatTile
          label={t('debts.kpi.partialCount')}
          hero={toArabicDigits(String(kpi.partialCount))}
          accentColor="#3B82F6"
          loading={loading}
        />
      </div>

      {/* Payment success banner */}
      {successBanner && (
        <div
          role="status"
          aria-live="polite"
          className="p-sm rounded-sm bg-success/10 border border-success/30 text-label text-success"
        >
          {t('debts.payment.success')}
        </div>
      )}

      {/* Status filter — segmented toggle (shown only when there are debts) */}
      {!loading && !error && debts.length > 0 && (
        <div
          className="flex gap-xs bg-surface-3 rounded-sm p-1 w-fit"
          role="group"
          aria-label={t('debts.filter.label')}
        >
          {filterOptions.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              aria-pressed={filter === value}
              className={`px-sm py-xs rounded-xs text-label font-medium transition-colors duration-fast
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary
                ${
                  filter === value
                    ? 'bg-surface text-primary shadow-e1'
                    : 'text-text-muted hover:text-text'
                }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="space-y-md" aria-busy="true" aria-label={t('state.loading')}>
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-20 rounded-md bg-surface-2 animate-pulse" />
          ))}
        </div>
      )}

      {/* Error */}
      {!loading && error && <ErrorState message={error} onRetry={fetchDebts} />}

      {/* Empty — no debts at all */}
      {!loading && !error && debts.length === 0 && (
        <EmptyState
          title={t('debts.empty.title')}
          body={t('debts.empty.body')}
        />
      )}

      {/* Empty after filter */}
      {!loading && !error && debts.length > 0 && filtered.length === 0 && (
        <EmptyState
          title={t('debts.empty.title')}
          body={t('debts.empty.body')}
        />
      )}

      {/* Debts list */}
      {!loading && !error && filtered.length > 0 && (
        <div className="space-y-sm">
          {filtered.map((debt) => (
            <DebtCard
              key={debt.id}
              debt={debt}
              onRecordPayment={() => setModal({ type: 'payment', debt })}
              t={t}
            />
          ))}
        </div>
      )}

      {/* Payment dialog */}
      {modal?.type === 'payment' && (
        <Dialog
          labelledBy="debt-payment-dialog-title"
          onClose={() => setModal(null)}
        >
          <div className="space-y-lg">
            <h2 id="debt-payment-dialog-title" className="text-h2 text-text">
              {t('debts.payment.title')}
            </h2>
            <PaymentForm
              debt={modal.debt}
              onClose={() => setModal(null)}
              onSuccess={handlePaymentSuccess}
            />
          </div>
        </Dialog>
      )}
    </div>
  );
}
