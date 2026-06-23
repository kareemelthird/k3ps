/**
 * custom-access-token-hook — Supabase Custom Access Token Hook
 *
 * Runs on every token issuance including token_refresh. Reads
 * tenant_members + profiles server-side, then merges the resolved
 * tenant claim into `app_metadata` ONLY (signed, non-user-editable).
 *
 * NEVER reads:
 *   - user_metadata (user-editable, untrusted)
 *   - request body
 *   - any client-supplied column
 *
 * Contract (ADR-0003):
 *   app_metadata.tenant_id      — active tenant UUID (scalar)
 *   app_metadata.roles          — 'owner' | 'manager' | 'staff'
 *   app_metadata.is_super_admin — boolean from profiles.is_platform_admin
 *   (impersonation tokens additionally carry impersonator_id, impersonation_exp)
 *
 * SECURITY REVIEWER: Required sign-off on this hook's claim construction.
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

interface HookPayload {
  user_id: string;
  claims: {
    app_metadata?: Record<string, unknown>;
    user_metadata?: Record<string, unknown>;
    [key: string]: unknown;
  };
  authentication_method?: string;
}

interface HookResponse {
  claims: Record<string, unknown>;
}

serve(async (req: Request): Promise<Response> => {
  try {
    const body = (await req.json()) as HookPayload;
    const userId = body.user_id;
    const claims = { ...body.claims };

    // Service-role client: bypasses RLS to read membership data server-side.
    // This is intentional — the hook runs as a trusted server process.
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    // 1. Read profile to get is_platform_admin
    const { data: profile } = await supabase
      .from('profiles')
      .select('is_platform_admin, is_active')
      .eq('id', userId)
      .single();

    const isSuperAdmin = profile?.is_platform_admin === true;

    // 2. Resolve active tenant membership
    //    Active tenant is the user's persisted selection, defaulted to their
    //    sole or last-used tenant. For Phase 2, we take the first active one.
    const { data: memberships } = await supabase
      .from('tenant_members')
      .select('tenant_id, role, is_active, tenants(status)')
      .eq('profile_id', userId)
      .eq('is_active', true)
      .limit(1)
      .order('created_at', { ascending: true });

    // Safe cast — tenants join shape
    type MemberRow = {
      tenant_id: string;
      role: string;
      is_active: boolean;
      tenants: { status: string } | null;
    };

    const activeMembership = (memberships as MemberRow[] | null)?.find(
      (m) => m.tenants?.status === 'active',
    );

    // 3. Build the app_metadata claim
    //    Only write to app_metadata — never user_metadata.
    //    Preserve any existing impersonation sub-claims if already set
    //    (impersonate-tenant edge function sets those; the hook should not clobber them).
    const existingAppMeta = (claims.app_metadata ?? {}) as Record<string, unknown>;
    const isImpersonation = typeof existingAppMeta['impersonator_id'] === 'string';

    if (!isImpersonation) {
      // Normal token: resolve fresh tenant from membership
      claims['app_metadata'] = {
        ...existingAppMeta,
        tenant_id: activeMembership?.tenant_id ?? null,
        roles: activeMembership?.role ?? null,
        is_super_admin: isSuperAdmin,
      };
    } else {
      // Impersonation token: only refresh is_super_admin (never overwrite the
      // impersonated tenant_id or impersonator metadata)
      claims['app_metadata'] = {
        ...existingAppMeta,
        is_super_admin: isSuperAdmin,
      };
    }

    const response: HookResponse = { claims };
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('custom-access-token-hook error:', err);
    return new Response(JSON.stringify({ error: 'Internal hook error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
