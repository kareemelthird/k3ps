/**
 * reactivate-tenant — Super-admin edge function (ADR-0008 Decision Q6)
 *
 * Sets tenants.status='active' and writes audit_log tenant.reactivate.
 * Mirror of suspend-tenant with single-responsibility (no overloaded toggle).
 *
 * Guard (Finding 4 fix): authority checked via profiles.is_platform_admin via the
 * service-role client — NOT from user.app_metadata (getUser() reflects
 * raw_app_meta_data which lacks is_super_admin; the hook injects that into the
 * JWT only). Fail-closed: DB row must be explicitly true.
 *
 * Effect is immediate: is_active_member() joins tenants.status='active', so
 * previously-suspended members regain access on their next request —
 * no waiting for token expiry (same mechanism as suspension, just reversed).
 *
 * Audit taxonomy: tenant.reactivate (consistent with tenant.provision and
 * tenant.suspend — ADR-0008 Decision Q6).
 *
 * Body: { tenant_id: string, reason: string }  // reason min 5 chars for audit
 *
 * SECURITY REVIEWER: Required sign-off on super-admin guard.
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

serve(async (req: Request): Promise<Response> => {
  try {
    // ── Step 1: Verify JWT identity ──────────────────────────────────────────
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return jsonError(401, 'Missing Authorization header');

    const callerClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: { user }, error: authErr } = await callerClient.auth.getUser();
    if (authErr || !user) return jsonError(401, 'Unauthenticated');

    // ── Step 2: Guard — check authority via authoritative DB record ─────────
    // SECURITY FIX (Finding 4): profiles.is_platform_admin is the authoritative
    // source. The JWT claim is_super_admin is injected by the hook at token
    // issuance but is NOT stored back to raw_app_meta_data, so getUser() would
    // never see it. We re-derive from the DB. Fail-closed.
    const serviceClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const { data: callerProfile } = await serviceClient
      .from('profiles')
      .select('is_platform_admin')
      .eq('id', user.id)
      .maybeSingle();

    if (callerProfile?.is_platform_admin !== true) {
      return jsonError(403, 'Forbidden: super_admin required');
    }

    // ── Step 3: Parse and validate request body ───────────────────────────────
    const body = (await req.json()) as { tenant_id?: string; reason?: string };

    if (!body.tenant_id) return jsonError(400, 'tenant_id is required');
    if (!body.reason || body.reason.trim().length < 5) {
      return jsonError(400, 'reason is required (min 5 chars) for audit trail');
    }

    // ── Step 4: Verify tenant exists ─────────────────────────────────────────
    const { data: tenant } = await serviceClient
      .from('tenants')
      .select('id, status')
      .eq('id', body.tenant_id)
      .maybeSingle();

    if (!tenant) return jsonError(404, 'Tenant not found');

    // ── Step 5: Set status='active' ──────────────────────────────────────────
    const { error: updateErr } = await serviceClient
      .from('tenants')
      .update({ status: 'active' })
      .eq('id', body.tenant_id);

    if (updateErr) {
      return jsonError(500, `Failed to reactivate tenant: ${updateErr.message}`);
    }

    // ── Step 6: Write audit_log tenant.reactivate ─────────────────────────────
    await serviceClient.from('audit_log').insert({
      tenant_id: body.tenant_id,
      actor_id:  user.id,
      action:    'tenant.reactivate',
      entity:    'tenants',
      entity_id: body.tenant_id,
      meta: {
        reason:          body.reason.trim(),
        previous_status: tenant.status,
      },
    });

    return new Response(
      JSON.stringify({ tenant_id: body.tenant_id, status: 'active' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('reactivate-tenant error:', err);
    return jsonError(500, 'Internal error');
  }
});

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
