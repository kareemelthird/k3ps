'use client';

/**
 * DangerZoneCard — lifecycle controls in tenant detail (design §4 item 4, AC 14–27).
 *
 * Suspend: only when active (AC 14)
 * Reactivate: only when suspended (AC 14)
 * Impersonate: guarded — only active tenants, disabled when suspended with tooltip (AC 22)
 *
 * All three mutations open separate dialogs (SuspendTenantDialog / ReactivateTenantDialog /
 * ImpersonationStartDialog) — no inline destructive actions.
 * DangerZone panel: red-tinted border, warnings, spatially separated from the rest of the detail.
 */

import { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { SuspendTenantDialog } from './SuspendTenantDialog';
import { ReactivateTenantDialog } from './ReactivateTenantDialog';
import { ImpersonationStartDialog } from './ImpersonationStartDialog';

export interface DangerZoneTenant {
  id: string;
  name: string;
  status: 'active' | 'suspended';
}

interface DangerZoneCardProps {
  tenant: DangerZoneTenant;
  maxImpersonationTtlSec?: number;
  onSuspend: (payload: { reason: string }) => Promise<void>;
  /** reason is passed through to reactivate-tenant edge function (requires >= 5 chars). */
  onReactivate: (payload: { reason: string }) => Promise<void>;
  onImpersonate: (payload: { reason: string; ttlSec: number }) => Promise<void>;
}

type Dialog = 'none' | 'suspend' | 'reactivate' | 'impersonate';

export function DangerZoneCard({
  tenant,
  maxImpersonationTtlSec = 3600,
  onSuspend,
  onReactivate,
  onImpersonate,
}: DangerZoneCardProps) {
  const t = useTranslations('admin');

  const [dialog, setDialog] = useState<Dialog>('none');
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const isActive = tenant.status === 'active';

  const runAction = useCallback(
    async (action: () => Promise<void>, onDone?: () => void) => {
      setSubmitting(true);
      setActionError(null);
      try {
        await action();
        setDialog('none');
        onDone?.();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : t('error.generic'));
      } finally {
        setSubmitting(false);
      }
    },
    [],
  );

  return (
    <div className="bg-surface rounded-md border border-danger/30 p-xl flex flex-col gap-md">
      <h2 className="text-h3 text-danger font-semibold">{t('detail.dangerZone')}</h2>

      <div className="flex flex-wrap gap-sm">
        {/* Suspend — only when active */}
        {isActive && (
          <Button
            variant="danger"
            size="md"
            onClick={() => {
              setActionError(null);
              setDialog('suspend');
            }}
          >
            {t('tenant.action.suspend')}
          </Button>
        )}

        {/* Reactivate — only when suspended */}
        {!isActive && (
          <Button
            variant="primary"
            size="md"
            onClick={() => {
              setActionError(null);
              setDialog('reactivate');
            }}
          >
            {t('tenant.action.reactivate')}
          </Button>
        )}

        {/* Impersonate — always visible; disabled + tooltip when suspended (AC 22) */}
        <div
          title={!isActive ? t('impersonate.start.error.suspended') : undefined}
          className="inline-flex"
        >
          <Button
            variant="ghost"
            size="md"
            disabled={!isActive}
            onClick={() => {
              setActionError(null);
              setDialog('impersonate');
            }}
          >
            {t('tenant.action.impersonate')}
          </Button>
        </div>
      </div>

      {/* Suspend dialog */}
      <SuspendTenantDialog
        open={dialog === 'suspend'}
        tenant={tenant}
        submitting={submitting}
        error={actionError}
        onConfirm={(payload) =>
          void runAction(() => onSuspend(payload))
        }
        onCancel={() => {
          setDialog('none');
          setActionError(null);
        }}
      />

      {/* Reactivate dialog */}
      <ReactivateTenantDialog
        open={dialog === 'reactivate'}
        tenant={tenant}
        submitting={submitting}
        error={actionError}
        onConfirm={(payload) =>
          void runAction(() => onReactivate(payload))
        }
        onCancel={() => {
          setDialog('none');
          setActionError(null);
        }}
      />

      {/* Impersonation start dialog */}
      <ImpersonationStartDialog
        open={dialog === 'impersonate'}
        tenant={{ id: tenant.id, name: tenant.name, status: tenant.status }}
        maxTtlSec={maxImpersonationTtlSec}
        submitting={submitting}
        error={actionError}
        onConfirm={(payload) =>
          void runAction(() => onImpersonate(payload))
        }
        onCancel={() => {
          setDialog('none');
          setActionError(null);
        }}
      />
    </div>
  );
}
