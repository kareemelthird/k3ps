/**
 * custom-access-token-hook — Supabase Custom Access Token Hook (Phase 7 rewrite)
 *
 * Runs on every token issuance including token_refresh. Derives ALL claims
 * DYNAMICALLY from the database on every issuance — there is NO "preserve
 * existing impersonation from app_metadata" branch (ADR-0008 Decision Q2/Q5).
 *
 * Impersonation state is derived FRESHLY from impersonation_sessions:
 *   - live row (not ended, not expired) → stamp impersonation claims
 *   - no live row (expired, ended, never started) → stamp normal claims
 * This means expiry/revocation are fail-closed: a session that was revoked
 * (ended_at set) or has passed its window (expires_at < now) produces a normal
 * token on the next refresh, regardless of the prior app_metadata value (AC 27).
 *
 * NEVER reads:
 *   - user_metadata (user-editable, untrusted)
 *   - request body / headers / client-supplied columns
 *   - prior app_metadata (all claims are re-derived from the DB)
 *
 * Contract (ADR-0003 / ADR-0008):
 *   app_metadata.tenant_id        — active tenant UUID (scalar) or null
 *   app_metadata.roles            — 'owner' | 'manager' | 'staff' (scalar text) or null
 *   app_metadata.is_super_admin   — boolean (ONLY true if profiles.is_platform_admin)
 *   (impersonation additionally):
 *   app_metadata.impersonator_id  — super-admin's auth.uid()
 *   app_metadata.impersonation_exp — ISO timestamp of session expiry
 *
 * SECURITY REVIEWER: Required sign-off.
 *   * is_super_admin set ONLY from profiles.is_platform_admin (AC 36).
 *   * Impersonation derived from DB row, never from prior app_metadata.
 *   * No user_metadata, no request body, no client-supplied input trusted.
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

// Shape of an impersonation_sessions row returned by the DB query.
// tenants is a nested join used to fetch the tenant display name for the
// impersonation banner (the web app reads claim.tenant_name to show the
// café name rather than a UUID slice — SHOULD-FIX).
interface ImpersonationSessionRow {
  target_tenant_id: string;
  role: string;
  expires_at: string;
  tenants: { name: string } | null;
}

// Shape of a tenant_members row returned by the DB query.
interface MemberRow {
  tenant_id: string;
  role: string;
  is_active: boolean;
  tenants: { status: string } | null;
}

serve(async (req: Request): Promise<Response> => {
  try {
    // ── SECURITY FIX (Finding 2): verify this request comes from Supabase Auth ──
    // The custom-access-token hook endpoint is a Supabase Edge Function reachable
    // at a public URL. Without an Authorization check ANY caller can trigger the
    // hook with an arbitrary user_id and receive manufactured claims.
    //
    // Supabase Auth infrastructure presents the service-role key as a Bearer token
    // when it calls a webhook/hook function. We verify this before processing the
    // payload. If the key is missing or wrong we return 403 — the hook call fails
    // and Supabase Auth falls back to its default claims (no app_metadata injection),
    // which is a safe fail-closed outcome.
    //
    // NOTE: SUPABASE_SERVICE_ROLE_KEY is an env var injected by the Supabase runtime;
    // it is never present in the client bundle (AC 29). Do NOT remove this check.
    const authHeader = req.headers.get('Authorization') ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    if (!serviceKey || authHeader !== `Bearer ${serviceKey}`) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const body = (await req.json()) as HookPayload;
    const userId = body.user_id;
    const claims = { ...body.claims };

    // Service-role client: bypasses RLS to read membership + impersonation data
    // server-side. This is intentional — the hook runs as a trusted server process.
    // The service-role key NEVER reaches the client bundle (AC 29).
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    // ── Step 1: Read profile — determines is_super_admin (AC 36) ─────────────
    // is_super_admin is set ONLY from profiles.is_platform_admin; it is NEVER
    // inherited from the prior app_metadata or any client-supplied value.
    const { data: profile } = await supabase
      .from('profiles')
      .select('is_platform_admin, is_active')
      .eq('id', userId)
      .single();

    // Non-platform-admin users NEVER receive is_super_admin=true (AC 36).
    const isSuperAdmin = profile?.is_platform_admin === true;

    // ── Step 2: Check for a LIVE impersonation session (ADR-0008 Decision Q2) ─
    // Derived freshly from the DB: no "preserve existing impersonation" branch.
    // A session is live when ended_at IS NULL and expires_at > now().
    // If multiple live sessions exist (shouldn't, but defensive), take the latest.
    // Join tenants to capture the display name for the impersonation banner.
    // The web app reads claim.tenant_name instead of showing a UUID slice.
    const { data: sessionData } = await supabase
      .from('impersonation_sessions')
      .select('target_tenant_id, role, expires_at, tenants(name)')
      .eq('impersonator_id', userId)
      .is('ended_at', null)
      .gt('expires_at', new Date().toISOString())
      .order('expires_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const liveSession = sessionData as ImpersonationSessionRow | null;

    // ── Step 3: Build app_metadata — the ONLY output we write ────────────────
    if (liveSession && isSuperAdmin) {
      // ── Impersonation path ──────────────────────────────────────────────────
      // The super-admin's token carries the target tenant's claim so that all
      // RLS policies resolve to the target tenant. is_super_admin=true is
      // preserved for the impersonation banner and audit identity (AC 21).
      // impersonator_id is stamped so is_impersonating() → true, which:
      //   (a) enables the is_active_member() impersonation branch (RLS gate), and
      //   (b) suppresses the super-admin cross-tenant read policies (AC 13).
      // tenant_name is the display name of the target tenant (joined from tenants)
      // so the impersonation banner can show "Impersonating Alpha Café" instead
      // of a raw UUID slice (SHOULD-FIX). null-safe: falls back to null.
      claims['app_metadata'] = {
        tenant_id: liveSession.target_tenant_id,
        tenant_name: liveSession.tenants?.name ?? null,
        roles: liveSession.role,               // scalar text (Decision Q3)
        is_super_admin: true,                   // preserved for banner + audit
        impersonator_id: userId,               // stamps is_impersonating()=true
        impersonation_exp: liveSession.expires_at,
      };
    } else {
      // ── Normal path (no live impersonation, or non-super-admin) ────────────
      // Derive tenant_id and roles freshly from tenant_members.
      // For Phase 2: take the first active membership (earliest by created_at).
      // A super-admin without a membership gets tenant_id=null, roles=null.
      const { data: memberships } = await supabase
        .from('tenant_members')
        .select('tenant_id, role, is_active, tenants(status)')
        .eq('profile_id', userId)
        .eq('is_active', true)
        .order('created_at', { ascending: true })
        .limit(1);

      const activeMembership = (memberships as MemberRow[] | null)?.find(
        (m) => m.tenants?.status === 'active',
      );

      // roles is a SCALAR string — never an array (Decision Q3).
      // Consumers must treat any non-scalar/unknown shape as no role (denied).
      claims['app_metadata'] = {
        tenant_id: activeMembership?.tenant_id ?? null,
        roles: activeMembership?.role ?? null,  // scalar text or null
        is_super_admin: isSuperAdmin,
        // No impersonator_id → is_impersonating() returns false
      };
    }

    const response: HookResponse = { claims };
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('custom-access-token-hook error:', err);
    // Fail-closed: return 500 so Supabase Auth rejects the token issuance.
    // The user's existing token (if any) is unaffected; they will need to retry.
    return new Response(JSON.stringify({ error: 'Internal hook error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
