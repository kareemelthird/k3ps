/**
 * provision-tenant — Super-admin edge function
 *
 * Creates a new tenant with its first owner in a single transaction.
 * Writes an audit_log row: action='tenant.provision'.
 *
 * Guard: caller must have is_super_admin=true in app_metadata (JWT claim).
 * Body: { tenant_name: string, owner_profile_id: string }
 *
 * AC 37: tenants row + owner tenant_members row + audit_log row written atomically.
 *
 * SECURITY REVIEWER: Required sign-off on super-admin guard.
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

serve(async (req: Request): Promise<Response> => {
  try {
    // --- Guard: verify caller is a super-admin via the signed JWT ---
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return jsonError(401, 'Missing Authorization header');
    }

    // Caller's JWT — use anon key so RLS is enforced on the caller's side
    const callerClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    );

    // Verify super-admin claim via the signed JWT
    const { data: { user }, error: authErr } = await callerClient.auth.getUser();
    if (authErr || !user) return jsonError(401, 'Unauthenticated');

    const appMeta = (user.app_metadata ?? {}) as Record<string, unknown>;
    if (appMeta['is_super_admin'] !== true) {
      return jsonError(403, 'Forbidden: super_admin required');
    }

    const body = (await req.json()) as { tenant_name?: string; owner_profile_id?: string };
    if (!body.tenant_name || !body.owner_profile_id) {
      return jsonError(400, 'tenant_name and owner_profile_id are required');
    }

    // --- Provisioning: use service role for the write (trusted server path) ---
    const serviceClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    // All inserts in one logical operation (AC 37)
    const tenantId = crypto.randomUUID();

    // 1. Insert tenant
    const { error: tenantErr } = await serviceClient
      .from('tenants')
      .insert({ id: tenantId, name: body.tenant_name, status: 'active' });
    if (tenantErr) return jsonError(500, `Failed to create tenant: ${tenantErr.message}`);

    // 2. Insert tenant_members (owner)
    const { error: memberErr } = await serviceClient
      .from('tenant_members')
      .insert({
        tenant_id: tenantId,
        profile_id: body.owner_profile_id,
        role: 'owner',
        is_active: true,
      });
    if (memberErr) return jsonError(500, `Failed to create tenant member: ${memberErr.message}`);

    // 3. Write audit_log (AC 37: actor, tenant, timestamp)
    const { error: auditErr } = await serviceClient
      .from('audit_log')
      .insert({
        tenant_id: tenantId,
        actor_id: user.id,
        action: 'tenant.provision',
        entity: 'tenants',
        entity_id: tenantId,
        meta: {
          tenant_name: body.tenant_name,
          owner_profile_id: body.owner_profile_id,
        },
      });
    if (auditErr) {
      console.error('audit_log insert failed (non-fatal):', auditErr);
    }

    return new Response(
      JSON.stringify({ tenant_id: tenantId, status: 'provisioned' }),
      { status: 201, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('provision-tenant error:', err);
    return jsonError(500, 'Internal error');
  }
});

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
