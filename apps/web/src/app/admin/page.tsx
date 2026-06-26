'use client';

/**
 * /admin — Platform overview page (AC 5–6, 16–20, design §3).
 *
 * Content:
 *  - StatStrip: total / active / suspended tenant counts
 *  - TenantsTable: all tenants with search + filter + per-row actions
 *  - ProvisionTenantDialog: triggered by primary CTA
 *
 * Data: fetched client-side via the anon Supabase client.
 * The super-admin SELECT-only RLS policies (ADR-0008 Q4) grant access
 * when is_super_admin() AND NOT is_impersonating().
 *
 * Mutations flow through Supabase edge functions — no service-role key here.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth/AuthContext';
import { getBrowserClient } from '@/lib/supabase/client';
import { AdminShell } from '@/components/admin/AdminShell';
import { StatStrip } from '@/components/admin/StatStrip';
import { TenantsTable, type TenantRow } from '@/components/admin/TenantsTable';
import { ProvisionTenantDialog, type ProvisionPayload } from '@/components/admin/ProvisionTenantDialog';
import { SuspendTenantDialog } from '@/components/admin/SuspendTenantDialog';
import { ReactivateTenantDialog } from '@/components/admin/ReactivateTenantDialog';
import { ImpersonationStartDialog } from '@/components/admin/ImpersonationStartDialog';
import { Button } from '@/components/ui/Button';

interface ProvisionResult {
  tenant_id?: string;
  owner_user_id?: string;
  owner_temp_password?: string;
}

// Only real columns from the `tenants` table (id, name, status, created_at).
// member_count / owner_count / branch_count are computed in JS from tenant_members + branches.
// last_activity_at: future enhancement — deriving it requires a cross-tenant audit_log scan.
interface TenantRecord {
  id: string;
  name: string;
  status: 'active' | 'suspended';
  created_at: string;
  member_count: number;
  branch_count: number;
  owner_count: number;
}

function toTenantRow(r: TenantRecord): TenantRow {
  const health: TenantRow['health'] =
    r.status === 'suspended'
      ? 'suspended'
      : r.owner_count === 0
      ? 'noOwner'
      : 'healthy';

  return {
    id: r.id,
    name: r.name,
    status: r.status,
    health,
    memberCount: r.member_count,
    branchCount: r.branch_count,
    ownerCount: r.owner_count,
    createdAt: r.created_at,
  };
}

type ActionDialog =
  | { type: 'none' }
  | { type: 'provision' }
  | { type: 'suspend'; tenant: TenantRow }
  | { type: 'reactivate'; tenant: TenantRow }
  | { type: 'impersonate'; tenant: TenantRow };

export default function AdminOverviewPage() {
  const t = useTranslations('admin');
  const router = useRouter();
  const { refreshSession } = useAuth();

  const [tenants, setTenants] = useState<TenantRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // TenantsTable manages search/filter state owned here (controlled)
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'suspended'>('all');

  const [dialog, setDialog] = useState<ActionDialog>({ type: 'none' });
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Holds temp-password from provision response; shown once, then cleared
  const [tempPasswordResult, setTempPasswordResult] = useState<ProvisionResult | null>(null);

  const loadTenants = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const supabase = getBrowserClient();

      // Fetch only real columns from tenants (no computed/virtual columns exist)
      const [tenantsResult, membersResult, branchesResult] = await Promise.all([
        supabase
          .from('tenants')
          .select('id, name, status, created_at')
          .order('created_at', { ascending: false }),
        // Super-admin SELECT policy (0008) grants access to tenant_members cross-tenant
        supabase.from('tenant_members').select('tenant_id, role, is_active'),
        // Super-admin SELECT policy (0008) grants access to branches cross-tenant
        supabase.from('branches').select('id, tenant_id'),
      ]);

      if (tenantsResult.error) throw tenantsResult.error;
      if (membersResult.error) throw membersResult.error;
      if (branchesResult.error) throw branchesResult.error;

      const tenantDbRows = (tenantsResult.data ?? []) as Array<{
        id: string;
        name: string;
        status: 'active' | 'suspended';
        created_at: string;
      }>;

      const allMembers = (membersResult.data ?? []) as Array<{
        tenant_id: string;
        role: string;
        is_active: boolean;
      }>;

      const allBranches = (branchesResult.data ?? []) as Array<{
        id: string;
        tenant_id: string;
      }>;

      // Group in JS — data volumes are tiny for the super-admin console
      const membersByTenant = new Map<string, Array<{ role: string; is_active: boolean }>>();
      for (const m of allMembers) {
        const arr = membersByTenant.get(m.tenant_id) ?? [];
        arr.push({ role: m.role, is_active: m.is_active });
        membersByTenant.set(m.tenant_id, arr);
      }

      const branchCountByTenant = new Map<string, number>();
      for (const b of allBranches) {
        branchCountByTenant.set(b.tenant_id, (branchCountByTenant.get(b.tenant_id) ?? 0) + 1);
      }

      const computed: TenantRecord[] = tenantDbRows.map((t) => {
        const members = membersByTenant.get(t.id) ?? [];
        return {
          id: t.id,
          name: t.name,
          status: t.status,
          created_at: t.created_at,
          member_count: members.length,
          owner_count: members.filter((m) => m.role === 'owner').length,
          branch_count: branchCountByTenant.get(t.id) ?? 0,
        };
      });

      setTenants(computed);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t('overview.error'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadTenants();
  }, [loadTenants]);

  const stats = {
    total: tenants.length,
    active: tenants.filter((t) => t.status === 'active').length,
    suspended: tenants.filter((t) => t.status === 'suspended').length,
  };

  const rows: TenantRow[] = tenants.map(toTenantRow);

  const closeDialog = useCallback(() => {
    setDialog({ type: 'none' });
    setActionError(null);
  }, []);

  const runMutation = useCallback(
    async (action: () => Promise<void>) => {
      setSubmitting(true);
      setActionError(null);
      try {
        await action();
        closeDialog();
        await loadTenants();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : t('error.generic'));
      } finally {
        setSubmitting(false);
      }
    },
    [closeDialog, loadTenants],
  );

  const handleProvision = useCallback(
    async (payload: ProvisionPayload) => {
      // provision-tenant contract: { tenant_name, owner_email, owner_full_name? }
      // Handled separately from runMutation so we can capture the response data
      // (owner_temp_password must be surfaced to the super-admin exactly once).
      setSubmitting(true);
      setActionError(null);
      try {
        const supabase = getBrowserClient();
        const { data, error } = await supabase.functions.invoke('provision-tenant', {
          body: payload,
        });
        if (error) throw error;
        closeDialog();
        // Surface temp password if the edge function created a new user (show once)
        const result = data as ProvisionResult | null;
        if (result?.owner_temp_password) {
          setTempPasswordResult(result);
        }
        await loadTenants();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : t('error.generic'));
      } finally {
        setSubmitting(false);
      }
    },
    [closeDialog, loadTenants],
  );

  const handleSuspend = useCallback(
    async (tenantId: string, { reason }: { reason: string }) => {
      // suspend-tenant contract: { tenant_id, reason }
      await runMutation(async () => {
        const supabase = getBrowserClient();
        const { error } = await supabase.functions.invoke('suspend-tenant', {
          body: { tenant_id: tenantId, reason },
        });
        if (error) throw error;
      });
    },
    [runMutation],
  );

  const handleReactivate = useCallback(
    async (tenantId: string, { reason }: { reason: string }) => {
      // reactivate-tenant contract: { tenant_id, reason } (reason >= 5 chars required)
      await runMutation(async () => {
        const supabase = getBrowserClient();
        const { error } = await supabase.functions.invoke('reactivate-tenant', {
          body: { tenant_id: tenantId, reason },
        });
        if (error) throw error;
      });
    },
    [runMutation],
  );

  const handleImpersonate = useCallback(
    async (tenantId: string, { reason, ttlSec }: { reason: string; ttlSec: number }) => {
      // impersonate-tenant contract: { target_tenant_id, reason, ttl_seconds? }
      await runMutation(async () => {
        const supabase = getBrowserClient();
        const { error } = await supabase.functions.invoke('impersonate-tenant', {
          body: { target_tenant_id: tenantId, reason, ttl_seconds: ttlSec },
        });
        if (error) throw error;
        // Refresh session so JWT claims include impersonation context (ADR-0008 Q2)
        await refreshSession();
        // Navigate into tenant dashboard after impersonation starts
        router.push('/dashboard');
      });
    },
    [runMutation, refreshSession, router],
  );

  // onSuspendToggle: opens suspend or reactivate dialog based on tenant status
  const handleSuspendToggle = useCallback((tenant: TenantRow) => {
    setActionError(null);
    if (tenant.status === 'active') {
      setDialog({ type: 'suspend', tenant });
    } else {
      setDialog({ type: 'reactivate', tenant });
    }
  }, []);

  const primaryAction = (
    <Button
      variant="primary"
      size="md"
      onClick={() => {
        setActionError(null);
        setDialog({ type: 'provision' });
      }}
    >
      {t('overview.provision')}
    </Button>
  );

  return (
    <AdminShell
      activeNav="overview"
      pageTitle={t('overview.title')}
      headerActions={primaryAction}
    >
      {/* Stats strip */}
      <StatStrip
        total={loading ? null : stats.total}
        active={loading ? null : stats.active}
        suspended={loading ? null : stats.suspended}
      />

      {/* Tenants table (manages its own filter/error/empty display internally) */}
      <TenantsTable
        tenants={rows}
        query={query}
        statusFilter={statusFilter}
        loading={loading}
        error={loadError}
        onSearch={setQuery}
        onStatusChange={setStatusFilter}
        onOpen={(id) => router.push(`/admin/tenants/${id}`)}
        onSuspendToggle={handleSuspendToggle}
        onImpersonate={(tenant) => {
          setActionError(null);
          setDialog({ type: 'impersonate', tenant });
        }}
        onRetry={() => void loadTenants()}
      />

      {/* Provision dialog */}
      <ProvisionTenantDialog
        open={dialog.type === 'provision'}
        submitting={submitting}
        error={actionError}
        onSubmit={(payload) => void handleProvision(payload)}
        onClose={closeDialog}
      />

      {/* Suspend dialog */}
      {dialog.type === 'suspend' && (
        <SuspendTenantDialog
          open
          tenant={{ id: dialog.tenant.id, name: dialog.tenant.name }}
          submitting={submitting}
          error={actionError}
          onConfirm={(payload) => void handleSuspend(dialog.tenant.id, payload)}
          onCancel={closeDialog}
        />
      )}

      {/* Reactivate dialog */}
      {dialog.type === 'reactivate' && (
        <ReactivateTenantDialog
          open
          tenant={{ id: dialog.tenant.id, name: dialog.tenant.name }}
          submitting={submitting}
          error={actionError}
          onConfirm={(payload) => void handleReactivate(dialog.tenant.id, payload)}
          onCancel={closeDialog}
        />
      )}

      {/* Impersonation start dialog */}
      {dialog.type === 'impersonate' && (
        <ImpersonationStartDialog
          open
          tenant={{
            id: dialog.tenant.id,
            name: dialog.tenant.name,
            status: dialog.tenant.status,
          }}
          submitting={submitting}
          error={actionError}
          onConfirm={(payload) => void handleImpersonate(dialog.tenant.id, payload)}
          onCancel={closeDialog}
        />
      )}

      {/* Temp-password modal — shown exactly once after provision, then cleared */}
      {tempPasswordResult?.owner_temp_password && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="temp-pwd-title"
          className="fixed inset-0 z-[10000] flex items-center justify-center p-xl"
        >
          <div className="absolute inset-0 bg-scrim" aria-hidden="true" />
          <div className="relative z-10 bg-surface rounded-md shadow-e3 p-2xl max-w-md w-full border border-warning/40 flex flex-col gap-lg">
            {/* Warning icon + title */}
            <div className="flex items-center gap-sm">
              <span className="flex-shrink-0 w-8 h-8 rounded-xs bg-warning/15 flex items-center justify-center">
                <svg
                  aria-hidden="true"
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  className="text-warning"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.998L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.35 16.002c-.77 1.331.192 2.998 1.732 2.998z" />
                </svg>
              </span>
              <h2 id="temp-pwd-title" className="text-h3 text-text font-semibold">
                {t('provision.tempPassword.title')}
              </h2>
            </div>

            {/* One-time warning */}
            <p className="text-body text-text-muted bg-warning/10 border border-warning/30 rounded-xs px-sm py-xs">
              {t('provision.tempPassword.body')}
            </p>

            {/* Password value — selectable, LTR since it's a token */}
            <div className="flex flex-col gap-xs">
              <p className="text-label text-text-muted">{t('provision.tempPassword.label')}</p>
              <code
                dir="ltr"
                className="block text-body font-mono text-text bg-surface-2 border border-border rounded-xs px-md py-sm select-all break-all"
              >
                {tempPasswordResult.owner_temp_password}
              </code>
            </div>

            {/* Dismiss — clears the state so it can never be shown again */}
            <div className="flex justify-end">
              <Button
                variant="primary"
                size="md"
                onClick={() => setTempPasswordResult(null)}
              >
                {t('provision.tempPassword.close')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </AdminShell>
  );
}
