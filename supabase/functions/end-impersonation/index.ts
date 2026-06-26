/**
 * end-impersonation — Super-admin edge function (ADR-0008 Decision Q6)
 *
 * Ends an active impersonation session:
 *   1. Validates caller is a super-admin (authoritative DB check — Finding 4 fix).
 *   2. Finds the live impersonation session for the caller (or a specific one
 *      if session_id is provided).
 *   3. Sets ended_at = now() on the session row.
 *   4. Writes impersonation.stop to audit_log (AC 26, AC 28).
 *   5. Returns success; the client calls supabase.auth.refreshSession() to
 *      revert to the super-admin's own token (hook finds no live session → normal claim).
 *
 * After this call, the hook will find NO live session row for the super-admin
 * and will return their normal super-admin claims (tenant_id=null, no impersonator_id).
 * Revocation takes effect on the next refreshSession() call (sub-second).
 *
 * Guard (Finding 4 fix): authority checked via profiles.is_platform_admin via the
 * service-role client — NOT from user.app_metadata.
 *
 * Body: { session_id?: string }  // optional; if absent, ends the caller's live session
 *
 * SECURITY REVIEWER: Required sign-off.
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
    // source. getUser() reflects raw_app_meta_data which does not carry
    // is_super_admin (that claim lives in the JWT only, injected by the hook).
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

    const body = (await req.json().catch(() => ({}))) as { session_id?: string };

    // ── Step 3: Find the live impersonation session ───────────────────────────
    let query = serviceClient
      .from('impersonation_sessions')
      .select('id, target_tenant_id, role, started_at, expires_at')
      .eq('impersonator_id', user.id)
      .is('ended_at', null)
      .gt('expires_at', new Date().toISOString());

    if (body.session_id) {
      query = query.eq('id', body.session_id);
    }

    const { data: session } = await query.order('expires_at', { ascending: false }).limit(1).maybeSingle();

    if (!session) {
      // No live session found — already ended or never started. Idempotent.
      return new Response(
        JSON.stringify({ status: 'no_active_session' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // ── Step 4: Set ended_at on the session row (immediate revocation) ────────
    const endedAt = new Date().toISOString();
    const { error: updateErr } = await serviceClient
      .from('impersonation_sessions')
      .update({ ended_at: endedAt })
      .eq('id', session.id);

    if (updateErr) {
      console.error('impersonation_sessions update failed:', updateErr);
      return jsonError(500, 'Failed to end impersonation session');
    }

    // ── Step 5: Write impersonation.stop to audit_log (AC 26, AC 28) ─────────
    await serviceClient.from('audit_log').insert({
      tenant_id: session.target_tenant_id,
      actor_id:  user.id,
      action:    'impersonation.stop',
      entity:    'tenants',
      entity_id: session.target_tenant_id,
      meta: {
        impersonation_session_id: session.id,
        impersonator_id:          user.id,
        target_tenant_id:         session.target_tenant_id,
        started_at:               session.started_at,
        ended_at:                 endedAt,
      },
    });

    return new Response(
      JSON.stringify({
        session_id: session.id,
        ended_at:   endedAt,
        next_action: 'call supabase.auth.refreshSession() to revert to super-admin context',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('end-impersonation error:', err);
    return jsonError(500, 'Internal error');
  }
});

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
