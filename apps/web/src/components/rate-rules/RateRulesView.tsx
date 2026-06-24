'use client';

/**
 * RateRulesView — owner rate-rule management page (AC 27–32, 40, 43).
 *
 * Lists the tenant's rate rules grouped by billing_mode then sorted by priority.
 * Owners can create / edit / deactivate / reactivate rules.
 * Managers see the list read-only (no write controls — AC 27).
 *
 * HARD RULES:
 *  - Money always via @ps/core formatEgp + toArabicDigits.
 *  - All strings from i18n — no hardcoded user-facing text.
 *  - RTL layout — logical spacing only (start/end, ms/me/ps/pe).
 *  - Tenant isolation: tenant_id comes from RLS (JWT claim), never from client.
 *  - Audit write on create/update/deactivate/reactivate (ADR-0005 Decision 5).
 *  - Soft-delete only (is_active=false) — never hard-delete (AC 30).
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  formatEgp,
  toArabicDigits,
  uuidv4,
} from '@ps/core';
import type { RateRule, BillingMode } from '@ps/core';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { RateRuleForm } from './RateRuleForm';
import { RateRulePreview } from './RateRulePreview';
import { getBrowserClient } from '@/lib/supabase/client';

// ─── Types ────────────────────────────────────────────────────────────────────

interface RateRulesViewProps {
  /** true = owner (full CRUD); false = manager/staff (read-only list) */
  isOwner: boolean;
}

type Modal =
  | { type: 'create' }
  | { type: 'edit'; rule: RateRule }
  | { type: 'deactivate'; rule: RateRule }
  | { type: 'reactivate'; rule: RateRule }
  | null;

// ─── Grouping ─────────────────────────────────────────────────────────────────

const BILLING_MODE_ORDER: BillingMode[] = ['open', 'prepaid', 'fixed_match'];

function groupByBillingMode(rules: RateRule[]): Map<BillingMode, RateRule[]> {
  const map = new Map<BillingMode, RateRule[]>();
  for (const mode of BILLING_MODE_ORDER) map.set(mode, []);
  for (const rule of rules) {
    const group = map.get(rule.billing_mode) ?? [];
    group.push(rule);
    map.set(rule.billing_mode, group);
  }
  // Sort each group by priority desc, then id asc (deterministic, matches resolveRule)
  for (const [mode, group] of map) {
    map.set(
      mode,
      [...group].sort((a, b) =>
        b.priority !== a.priority ? b.priority - a.priority : a.id.localeCompare(b.id),
      ),
    );
  }
  return map;
}

// ─── Price display helper ─────────────────────────────────────────────────────

function rulePrice(rule: RateRule, t: ReturnType<typeof useTranslations>): string {
  if (rule.billing_mode === 'open' && rule.price_per_hour != null) {
    return formatEgp(rule.price_per_hour);
  }
  if (rule.billing_mode === 'prepaid' && rule.block_price != null) {
    return formatEgp(rule.block_price);
  }
  if (rule.billing_mode === 'fixed_match' && rule.fixed_match_price != null) {
    return formatEgp(rule.fixed_match_price);
  }
  return t('rateRules.noPrice');
}

// ─── Component ────────────────────────────────────────────────────────────────

export function RateRulesView({ isOwner }: RateRulesViewProps) {
  const t = useTranslations();
  const [rules, setRules] = useState<RateRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const fetchRules = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const supabase = getBrowserClient();
      // RLS ensures only this tenant's rules are returned (JWT claim gates rows).
      const { data, error: err } = await supabase
        .from('rate_rules')
        .select('*')
        .order('priority', { ascending: false })
        .order('id', { ascending: true });
      if (err) throw err;
      setRules((data as RateRule[]) ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchRules();
  }, [fetchRules]);

  // Called after create/edit success
  function handleSaved(rule: RateRule) {
    setRules((prev) => {
      const idx = prev.findIndex((r) => r.id === rule.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = rule;
        return next;
      }
      return [rule, ...prev];
    });
    setModal(null);
  }

  // Soft-deactivate (AC 30): set is_active=false, never hard-delete
  async function handleDeactivate(rule: RateRule) {
    setPendingId(rule.id);
    try {
      const supabase = getBrowserClient();
      const now = new Date().toISOString();
      const { error: err } = await supabase
        .from('rate_rules')
        .update({ is_active: false, updated_at: now })
        .eq('id', rule.id);
      if (err) throw err;

      // Audit write (ADR-0005 Decision 5, taxonomy: rate_rule.deactivate)
      await supabase.from('audit_log').insert({
        id: uuidv4(),
        action: 'rate_rule.deactivate',
        entity: 'rate_rule',
        entity_id: rule.id,
        amount: null,
        meta: { before: { is_active: true }, after: { is_active: false } },
        created_at: now,
      });

      setRules((prev) =>
        prev.map((r) => (r.id === rule.id ? { ...r, is_active: false } : r)),
      );
      setModal(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setPendingId(null);
    }
  }

  // Reactivate: set is_active=true (symmetric to deactivate)
  async function handleReactivate(rule: RateRule) {
    setPendingId(rule.id);
    try {
      const supabase = getBrowserClient();
      const now = new Date().toISOString();
      const { error: err } = await supabase
        .from('rate_rules')
        .update({ is_active: true, updated_at: now })
        .eq('id', rule.id);
      if (err) throw err;

      // Audit write (ADR-0005 Decision 5, taxonomy: rate_rule.reactivate)
      await supabase.from('audit_log').insert({
        id: uuidv4(),
        action: 'rate_rule.reactivate',
        entity: 'rate_rule',
        entity_id: rule.id,
        amount: null,
        meta: { before: { is_active: false }, after: { is_active: true } },
        created_at: now,
      });

      setRules((prev) =>
        prev.map((r) => (r.id === rule.id ? { ...r, is_active: true } : r)),
      );
      setModal(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setPendingId(null);
    }
  }

  const grouped = groupByBillingMode(rules);

  return (
    <div className="space-y-2xl">
      {/* Header */}
      <div className="flex items-center justify-between gap-md">
        <div>
          <h1 className="text-h1 text-text">{t('rateRules.title')}</h1>
          <p className="text-label text-text-muted mt-xs">{t('rateRules.subtitle')}</p>
        </div>
        {isOwner && (
          <Button
            variant="primary"
            onClick={() => setModal({ type: 'create' })}
            aria-label={t('rateRules.create')}
          >
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            {t('rateRules.create')}
          </Button>
        )}
      </div>

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
        <ErrorState message={error} onRetry={fetchRules} />
      )}

      {/* Empty */}
      {!loading && !error && rules.length === 0 && (
        <EmptyState
          title={t('rateRules.empty.title')}
          body={t('rateRules.empty.body')}
          action={
            isOwner ? (
              <Button variant="primary" onClick={() => setModal({ type: 'create' })}>
                {t('rateRules.create')}
              </Button>
            ) : undefined
          }
        />
      )}

      {/* Rule groups */}
      {!loading && !error && rules.length > 0 && (
        <div className="space-y-2xl">
          {BILLING_MODE_ORDER.map((mode) => {
            const group = grouped.get(mode) ?? [];
            if (group.length === 0) return null;
            return (
              <section key={mode} aria-labelledby={`group-${mode}`}>
                <h2
                  id={`group-${mode}`}
                  className="text-h2 text-text mb-md pb-sm border-b border-border"
                >
                  {t(`rateRules.billingMode.${mode}`)}
                </h2>
                <div className="space-y-sm">
                  {group.map((rule) => (
                    <RateRuleCard
                      key={rule.id}
                      rule={rule}
                      isOwner={isOwner}
                      pending={pendingId === rule.id}
                      onEdit={() => setModal({ type: 'edit', rule })}
                      onDeactivate={() => setModal({ type: 'deactivate', rule })}
                      onReactivate={() => setModal({ type: 'reactivate', rule })}
                      t={t}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {/* Preview panel — shown only when rules exist */}
      {!loading && !error && rules.length > 0 && (
        <RateRulePreview rules={rules} />
      )}

      {/* Modal overlay */}
      {modal && (
        <ModalOverlay onClose={() => setModal(null)}>
          {modal.type === 'create' && (
            <div className="space-y-lg">
              <h2 className="text-h2 text-text">{t('rateRules.create')}</h2>
              <RateRuleForm
                onSuccess={handleSaved}
                onCancel={() => setModal(null)}
              />
            </div>
          )}

          {modal.type === 'edit' && (
            <div className="space-y-lg">
              <h2 className="text-h2 text-text">{t('rateRules.edit')}</h2>
              <RateRuleForm
                initial={modal.rule}
                onSuccess={handleSaved}
                onCancel={() => setModal(null)}
              />
            </div>
          )}

          {modal.type === 'deactivate' && (
            <ConfirmDialog
              message={t('rateRules.action.deactivateConfirm')}
              confirmLabel={t('rateRules.action.deactivate')}
              confirmVariant="danger"
              loading={pendingId === modal.rule.id}
              onConfirm={() => void handleDeactivate(modal.rule)}
              onCancel={() => setModal(null)}
              t={t}
            />
          )}

          {modal.type === 'reactivate' && (
            <ConfirmDialog
              message={t('rateRules.action.reactivateConfirm')}
              confirmLabel={t('rateRules.action.reactivate')}
              confirmVariant="primary"
              loading={pendingId === modal.rule.id}
              onConfirm={() => void handleReactivate(modal.rule)}
              onCancel={() => setModal(null)}
              t={t}
            />
          )}
        </ModalOverlay>
      )}
    </div>
  );
}

// ─── RateRuleCard ─────────────────────────────────────────────────────────────

interface RateRuleCardProps {
  rule: RateRule;
  isOwner: boolean;
  pending: boolean;
  onEdit: () => void;
  onDeactivate: () => void;
  onReactivate: () => void;
  t: ReturnType<typeof useTranslations>;
}

function RateRuleCard({
  rule,
  isOwner,
  pending,
  onEdit,
  onDeactivate,
  onReactivate,
  t,
}: RateRuleCardProps) {
  const isInactive = !rule.is_active;

  return (
    <article
      aria-label={`${t(`rateRules.billingMode.${rule.billing_mode}`)} — ${rule.device_type} — ${t(`rateRules.playMode.${rule.play_mode}`)}`}
      className={`rounded-md bg-surface border p-md flex flex-col sm:flex-row sm:items-center gap-sm transition-opacity
        ${isInactive ? 'opacity-50 border-border' : 'border-border hover:border-border-strong'}`}
    >
      {/* Status indicator */}
      <span
        className={`w-2 h-2 rounded-full flex-shrink-0 self-start mt-1
          ${isInactive ? 'bg-text-faint' : 'bg-status-free'}`}
        aria-hidden="true"
      />

      {/* Rule details */}
      <div className="flex-1 min-w-0 space-y-2xs">
        <div className="flex flex-wrap items-center gap-xs">
          {/* Device type */}
          <span
            className="text-micro font-medium bg-surface-3 text-text-muted px-xs py-1 rounded-xs uppercase tracking-wider"
            dir="ltr"
          >
            {rule.device_type}
          </span>

          {/* Play mode */}
          <span className="text-micro font-medium bg-surface-3 text-text-muted px-xs py-1 rounded-xs">
            {t(`rateRules.playMode.${rule.play_mode}`)}
          </span>

          {/* Day type */}
          <span className="text-micro font-medium bg-surface-3 text-text-muted px-xs py-1 rounded-xs">
            {t(`rateRules.dayType.${rule.day_type}`)}
          </span>

          {/* Time window */}
          {rule.time_start && rule.time_end ? (
            <span className="text-micro font-medium text-text-faint" dir="ltr">
              {rule.time_start}–{rule.time_end}
            </span>
          ) : (
            <span className="text-micro text-text-faint">{t('rateRules.allDay')}</span>
          )}

          {/* Priority badge */}
          <span className="text-micro font-medium text-primary" dir="ltr">
            P{toArabicDigits(String(rule.priority))}
          </span>

          {/* Inactive badge */}
          {isInactive && (
            <span className="text-micro font-medium text-text-faint">
              {t('rateRules.status.inactive')}
            </span>
          )}
        </div>

        {/* Price — money always via formatEgp (AC 29, CLAUDE.md §2.1) */}
        <p className="text-h3 text-text tabular-nums" dir="ltr">
          {rulePrice(rule, t)}
        </p>
      </div>

      {/* Owner-only action buttons */}
      {isOwner && (
        <div className="flex items-center gap-sm flex-shrink-0">
          <Button
            variant="ghost"
            size="md"
            onClick={onEdit}
            aria-label={`${t('rateRules.edit')} ${rule.id}`}
            className="h-9 px-sm text-text-muted"
            disabled={pending}
          >
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
          </Button>

          {/* Deactivate / Reactivate — separated from edit (destructive-emphasis) */}
          {isInactive ? (
            <Button
              variant="secondary"
              size="md"
              onClick={onReactivate}
              aria-label={`${t('rateRules.action.reactivate')} ${rule.id}`}
              className="h-9 px-sm"
              loading={pending}
            >
              {t('rateRules.action.reactivate')}
            </Button>
          ) : (
            <Button
              variant="danger"
              size="md"
              onClick={onDeactivate}
              aria-label={`${t('rateRules.action.deactivate')} ${rule.id}`}
              className="h-9 px-sm"
              loading={pending}
            >
              {t('rateRules.action.deactivate')}
            </Button>
          )}
        </div>
      )}
    </article>
  );
}

// ─── Modal overlay (simple — design-system §5 motion tokens) ─────────────────

function ModalOverlay({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  const t = useTranslations();
  return (
    // Scrim (design-system §2.2: rgba(0,0,0,0.6))
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-md"
      style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
      role="dialog"
      aria-modal="true"
    >
      {/* Backdrop close */}
      <div className="absolute inset-0" onClick={onClose} aria-hidden="true" />

      {/* Panel — design-system elevation e3 */}
      <div
        className="relative z-10 w-full max-w-lg bg-surface rounded-lg border border-border shadow-e3 p-xl max-h-[90dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close button — aria-label from i18n (RTL/i18n check) */}
        <button
          onClick={onClose}
          aria-label={t('action.close')}
          className="absolute top-md end-md text-text-muted hover:text-text transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-xs p-xs"
        >
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        {children}
      </div>
    </div>
  );
}

// ─── Confirm dialog ───────────────────────────────────────────────────────────

interface ConfirmDialogProps {
  message: string;
  confirmLabel: string;
  confirmVariant: 'primary' | 'danger';
  loading: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  t: ReturnType<typeof useTranslations>;
}

function ConfirmDialog({
  message,
  confirmLabel,
  confirmVariant,
  loading,
  onConfirm,
  onCancel,
  t,
}: ConfirmDialogProps) {
  return (
    <div className="space-y-lg">
      <p className="text-body text-text">{message}</p>
      <div className="flex gap-md justify-end">
        <Button variant="secondary" onClick={onCancel} disabled={loading}>
          {t('rateRules.action.cancel')}
        </Button>
        <Button variant={confirmVariant} onClick={onConfirm} loading={loading}>
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}
