'use client';

/**
 * /admin/tenants/[id] — Tenant detail page (AC 7–15, design §4).
 *
 * Sections:
 *  1. TenantOverviewCard — name / status / counts
 *  2. MembersTable — all members (N must match overview count, AC 7)
 *  3. BranchesList — all branches (M must match overview count, AC 7)
 *  4. RecentAuditCard — last ~10 audit rows, link to full audit
 *  5. DangerZoneCard — suspend / reactivate / impersonate (AC 14–27)
 *
 * Server-side re-verification happens via the anon-client + RLS policies
 * (ADR-0008 Q4: four narrow additive SELECT-only super-admin policies).
 * Mutations use edge functions — no service-role key in client.
 */

import { use, useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth/AuthContext';
import { getBrowserClient } from '@/lib/supabase/client';
import { AdminShell } from '@/components/admin/AdminShell';
import { TenantOverviewCard } from '@/components/admin/TenantOverviewCard';
import { MembersTable, type MemberRow } from '@/components/admin/MembersTable';
import { BranchesList, type BranchItem } from '@/components/admin/BranchesList';
import { RecentAuditCard, type AuditRowData } from '@/components/admin/RecentAuditCard';
import { DangerZoneCard } from '@/components/admin/DangerZoneCard';
import { ErrorState } from '@/components/ui/ErrorState';

interface TenantDetailData {
  id: string;
  name: string;
  status: 'active' | 'suspended';
  createdAt: string;
  memberCount: number;
  branchCount: number;
  ownerCount: number;
  health: 'healthy' | 'noOwner' | 'idle' | 'suspended';
}

interface PageProps {
  params: Promise<{ id: string }>;
}

export default function TenantDetailPage({ params }: PageProps) {
  const { id: tenantId } = use(params);

  const t = useTranslations('admin');
  const router = useRouter();
  const { refreshSession } = useAuth();

  const [tenant, setTenant] = useState<TenantDetailData | null>(null);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [branches, setBranches] = useState<BranchItem[]>([]);
  const [auditRows, setAuditRows] = useState<AuditRowData[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadDetail = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const supabase = getBrowserClient();

      // 1. Fetch tenant base record — only real columns (id, name, status, created_at).
      //    tenants has NO member_count / branch_count / owner_count columns.
      const { data: tenantData, error: tenantErr } = await supabase
        .from('tenants')
        .select('id, name, status, created_at')
        .eq('id', tenantId)
        .single();
      if (tenantErr) throw tenantErr;

      const td = tenantData as {
        id: string;
        name: string;
        status: 'active' | 'suspended';
        created_at: string;
      };

      // 2. Fetch tenant_members for this tenant.
      //    profiles has NO tenant_id / email / role columns — role lives on tenant_members.
      //    Super-admin SELECT policy (0008) grants access cross-tenant.
      const { data: membershipData, error: memberErr } = await supabase
        .from('tenant_members')
        .select('profile_id, role, is_active')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: true });
      if (memberErr) throw memberErr;

      const memberships = (membershipData ?? []) as Array<{
        profile_id: string;
        role: string;
        is_active: boolean;
      }>;

      // 3. Fetch profile names for those members (profiles.id = tenant_members.profile_id).
      //    Email lives in auth.users — not reachable from the client; omitted.
      let profileMap = new Map<string, { full_name: string | null }>();
      if (memberships.length > 0) {
        const profileIds = memberships.map((m) => m.profile_id);
        const { data: profileData, error: profileErr } = await supabase
          .from('profiles')
          .select('id, full_name')
          .in('id', profileIds);
        if (profileErr) throw profileErr;
        profileMap = new Map(
          ((profileData ?? []) as Array<{ id: string; full_name: string | null }>).map((p) => [
            p.id,
            p,
          ]),
        );
      }

      // Compute counts from fetched memberships (no virtual columns needed)
      const memberCount = memberships.length;
      const ownerCount = memberships.filter((m) => m.role === 'owner').length;

      // 4. Fetch branches for this tenant
      const { data: branchData, error: branchErr } = await supabase
        .from('branches')
        .select('id, name, is_active')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: true });
      if (branchErr) throw branchErr;

      const branchRows = (branchData ?? []) as Array<{
        id: string;
        name: string;
        is_active: boolean;
      }>;

      // 5. Fetch last 10 audit rows for this tenant
      const { data: auditData, error: auditErr } = await supabase
        .from('audit_log')
        .select('id, created_at, action, actor_id, amount, meta')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false })
        .limit(10);
      if (auditErr) throw auditErr;

      // Derive health
      const health: TenantDetailData['health'] =
        td.status === 'suspended'
          ? 'suspended'
          : ownerCount === 0
          ? 'noOwner'
          : 'healthy';

      setTenant({
        id: td.id,
        name: td.name,
        status: td.status,
        createdAt: td.created_at,
        memberCount,
        branchCount: branchRows.length,
        ownerCount,
        health,
      });

      setMembers(
        memberships.map((m) => ({
          id: m.profile_id,
          name: profileMap.get(m.profile_id)?.full_name ?? '',
          role: m.role,
          isActive: m.is_active,
        })),
      );

      setBranches(
        branchRows.map((b) => ({ id: b.id, name: b.name, isActive: b.is_active })),
      );

      setAuditRows(
        ((auditData ?? []) as Array<{
          id: string;
          created_at: string;
          action: string;
          actor_id: string | null;
          amount: number | null;
          meta: Record<string, unknown> | null;
        }>).map((r) => ({
          id: r.id,
          createdAt: r.created_at,
          action: r.action,
          actorId: r.actor_id,
          amount: r.amount,
          meta: r.meta,
        })),
      );
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t('error.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  const handleSuspend = useCallback(
    async (payload: { reason: string }) => {
      // suspend-tenant contract: { tenant_id, reason }
      const supabase = getBrowserClient();
      const { error } = await supabase.functions.invoke('suspend-tenant', {
        body: { tenant_id: tenantId, reason: payload.reason },
      });
      if (error) throw error;
      await loadDetail();
    },
    [tenantId, loadDetail],
  );

  const handleReactivate = useCallback(
    async (payload: { reason: string }) => {
      // reactivate-tenant contract: { tenant_id, reason } (reason >= 5 chars required)
      const supabase = getBrowserClient();
      const { error } = await supabase.functions.invoke('reactivate-tenant', {
        body: { tenant_id: tenantId, reason: payload.reason },
      });
      if (error) throw error;
      await loadDetail();
    },
    [tenantId, loadDetail],
  );

  const handleImpersonate = useCallback(
    async (payload: { reason: string; ttlSec: number }) => {
      // impersonate-tenant contract: { target_tenant_id, reason, ttl_seconds? }
      const supabase = getBrowserClient();
      const { error } = await supabase.functions.invoke('impersonate-tenant', {
        body: { target_tenant_id: tenantId, reason: payload.reason, ttl_seconds: payload.ttlSec },
      });
      if (error) throw error;
      // Refresh JWT claims to include impersonation context (ADR-0008 Q2)
      await refreshSession();
      router.push('/dashboard');
    },
    [tenantId, refreshSession, router],
  );

  const pageTitle = tenant?.name ?? tenantId.slice(0, 8);

  // Breadcrumb back link
  const breadcrumb = (
    <Link
      href="/admin"
      className="text-label text-text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-xs"
    >
      ← {t('detail.breadcrumb')}
    </Link>
  );

  return (
    <AdminShell activeNav="overview" pageTitle={pageTitle} headerActions={breadcrumb}>
      {loadError && (
        <ErrorState message={loadError} onRetry={() => void loadDetail()} />
      )}

      {!loadError && (
        <div className="flex flex-col gap-2xl">
          {/* 1. Overview card */}
          <TenantOverviewCard tenant={tenant} loading={loading} />

          {/* 2. Members */}
          <MembersTable members={members} loading={loading} />

          {/* 3. Branches */}
          <BranchesList branches={branches} loading={loading} />

          {/* 4. Recent audit */}
          <RecentAuditCard tenantId={tenantId} rows={auditRows} loading={loading} />

          {/* 5. Danger zone */}
          {!loading && tenant && (
            <DangerZoneCard
              tenant={{ id: tenant.id, name: tenant.name, status: tenant.status }}
              onSuspend={handleSuspend}
              onReactivate={handleReactivate}
              onImpersonate={handleImpersonate}
            />
          )}
        </div>
      )}
    </AdminShell>
  );
}
