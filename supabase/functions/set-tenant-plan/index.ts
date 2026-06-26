/**
 * set-tenant-plan — Super-admin plan comp/override edge function
 *
 * Security model (ADR-0010, ADR-0008 pattern):
 *   * Guard: profiles.is_platform_admin checked via service-role client (DB-authoritative,
 *     same pattern as provision-tenant). The JWT is_super_admin claim is NOT trusted alone.
 *   * Action: calls set_tenant_plan() SECURITY DEFINER RPC (service-role only).
 *     comped=true bypasses Stripe billing and sets status='active' immediately.
 *   * Audit: the RPC writes to audit_log inside the same transaction (fatal if it fails).
 *
 * Body: {
 *   tenant_id: string (UUID)          — required
 *   plan_key:  'trial'|'basic'|'pro'  — required
 *   reason:    string                  — required (audit trail)
 *   comped?:   boolean                 — default true
 *   trial_extension_days?: number|null — optional trial extension
 * }
 *
 * Returns: { success: true }
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

serve(async (req: Request): Promise<Response> => {
  try {
    // ── Step 1: Verify JWT identity ──────────────────────────────────────────
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return jsonError(401, 'Missing Authorization header');

    const callerClient = createClient(
      Deno.env.get('SUPABASE_URL')      ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: { user }, error: authErr } = await callerClient.auth.getUser();
    if (authErr || !user) return jsonError(401, 'Unauthenticated');

    // ── Step 2: Guard — platform_admin only (DB-authoritative, ADR-0008 pattern) ─
    const serviceClient = createClient(
      Deno.env.get('SUPABASE_URL')              ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const { data: profile } = await serviceClient
      .from('profiles')
      .select('is_platform_admin')
      .eq('id', user.id)
      .maybeSingle();

    if (profile?.is_platform_admin !== true) {
      return jsonError(403, 'Forbidden: super_admin required');
    }

    // ── Step 3: Parse and validate body ──────────────────────────────────────
    let body: {
      tenant_id?: string;
      plan_key?: string;
      reason?: string;
      comped?: boolean;
      trial_extension_days?: number | null;
    };
    try {
      body = await req.json();
    } catch {
      return jsonError(400, 'Invalid JSON body');
    }

    if (!body.tenant_id)         return jsonError(400, 'tenant_id is required');
    if (!body.plan_key)          return jsonError(400, 'plan_key is required');
    if (!body.reason?.trim())    return jsonError(400, 'reason is required');

    // ── Step 4: Call the SECURITY DEFINER RPC (service-role only) ────────────
    const { error: rpcErr } = await serviceClient.rpc('set_tenant_plan', {
      p_tenant_id:            body.tenant_id,
      p_plan:                 body.plan_key,
      p_actor_id:             user.id,
      p_reason:               body.reason.trim(),
      p_comped:               body.comped ?? true,
      p_trial_extension_days: body.trial_extension_days ?? null,
    });

    if (rpcErr) {
      console.error('[set-tenant-plan] RPC failed:', rpcErr);
      return jsonError(500, `Failed to set plan: ${rpcErr.message}`);
    }

    return new Response(JSON.stringify({ success: true }), {
      status:  200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[set-tenant-plan] error:', msg);
    return jsonError(500, 'Internal error');
  }
});

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
