/**
 * suspend-tenant — Super-admin edge function
 *
 * Sets tenants.status='suspended' and writes an audit_log row.
 * Suspension takes immediate effect via is_active_member() gating —
 * no token-freshness dependency.
 *
 * Guard: caller must have is_super_admin=true in app_metadata.
 * Body: { tenant_id: string, reason: string }
 *
 * SECURITY REVIEWER: Required sign-off on super-admin guard.
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

serve(async (req: Request): Promise<Response> => {
  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return jsonError(401, 'Missing Authorization header');

    const callerClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: { user }, error: authErr } = await callerClient.auth.getUser();
    if (authErr || !user) return jsonError(401, 'Unauthenticated');

    const appMeta = (user.app_metadata ?? {}) as Record<string, unknown>;
    if (appMeta['is_super_admin'] !== true) {
      return jsonError(403, 'Forbidden: super_admin required');
    }

    const body = (await req.json()) as { tenant_id?: string; reason?: string };
    if (!body.tenant_id) return jsonError(400, 'tenant_id is required');
    if (!body.reason || body.reason.trim().length < 5) {
      return jsonError(400, 'reason is required (min 5 chars) for audit trail');
    }

    const serviceClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    // Update tenant status
    const { error: updateErr } = await serviceClient
      .from('tenants')
      .update({ status: 'suspended' })
      .eq('id', body.tenant_id);

    if (updateErr) return jsonError(500, `Failed to suspend tenant: ${updateErr.message}`);

    // Write audit log
    await serviceClient.from('audit_log').insert({
      tenant_id: body.tenant_id,
      actor_id: user.id,
      action: 'tenant.suspend',
      entity: 'tenants',
      entity_id: body.tenant_id,
      meta: { reason: body.reason },
    });

    return new Response(
      JSON.stringify({ tenant_id: body.tenant_id, status: 'suspended' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('suspend-tenant error:', err);
    return jsonError(500, 'Internal error');
  }
});

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
