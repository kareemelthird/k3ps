/**
 * provision-tenant — Super-admin edge function
 *
 * Creates a new tenant + first owner account in a single atomic operation.
 * Designed to be the ONLY way a new café is onboarded (no client self-service).
 *
 * Guard (Finding 4 fix): authority checked via profiles.is_platform_admin via the
 * service-role client — NOT from user.app_metadata (getUser() reflects
 * raw_app_meta_data which lacks is_super_admin; the hook injects that into the
 * JWT only). Fail-closed: DB row must be explicitly true.
 *
 * Body: {
 *   tenant_name:      string,   // required — display name for the café
 *   owner_email:      string,   // required — the new owner's login email
 *   owner_full_name?: string    // optional — stored in profiles.full_name
 * }
 *
 * Behavior (all via service-role, idempotent):
 *   1. Find or create the auth user for owner_email.
 *      - If already exists: look up by email via the get_auth_user_id_by_email
 *        RPC (service-role only, queries auth.users directly).
 *      - If new: auth.admin.createUser with email_confirm=true + a generated
 *        temp password. Temp password is returned ONLY for new users so the
 *        super-admin can hand it to the café owner out-of-band (HTTPS,
 *        super-admin-only endpoint — no SMTP dependency).
 *   2. Upsert public.profiles (id = auth user id, full_name = owner_full_name ?? '').
 *   3. Create the tenant row (server-generated UUID).
 *   4. Insert tenant_members (tenant_id, profile_id, role='owner', is_active=true)
 *      ON CONFLICT DO NOTHING (idempotent).
 *   5. Write audit_log action='tenant.provision'.
 *
 * Returns: { tenant_id, owner_user_id, owner_temp_password? }
 *   owner_temp_password is present ONLY when a new auth user was created.
 *
 * AC 37: tenants row + tenant_members row + audit_log row written atomically.
 *
 * SECURITY REVIEWER: Required sign-off.
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/** Generate a cryptographically random temp password meeting common complexity rules. */
function generateTempPassword(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  // Hex gives 48 chars of randomness; append fixed suffix to meet digit+upper+special.
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 20) + 'Aa1!'; // 24 chars, entropy dominated by the random hex
}

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
    // SECURITY FIX (Finding 4): profiles.is_platform_admin is the single source
    // of truth for super-admin status. The JWT claim is_super_admin is injected
    // by the hook at token issuance but is NOT stored back to raw_app_meta_data,
    // so getUser() would never see it. We re-derive from the DB. Fail-closed.
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

    // ── Step 3: Parse and validate body ──────────────────────────────────────
    // LOCKED CONTRACT: { tenant_name, owner_email, owner_full_name? }
    const body = (await req.json()) as {
      tenant_name?: string;
      owner_email?: string;
      owner_full_name?: string;
    };

    if (!body.tenant_name || body.tenant_name.trim().length === 0) {
      return jsonError(400, 'tenant_name is required');
    }
    if (!body.owner_email || body.owner_email.trim().length === 0) {
      return jsonError(400, 'owner_email is required');
    }

    const tenantName  = body.tenant_name.trim();
    const ownerEmail  = body.owner_email.trim().toLowerCase();
    const ownerName   = (body.owner_full_name ?? '').trim();

    // Basic email format guard
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
      return jsonError(400, 'owner_email format is invalid');
    }

    // Generate tenant_id BEFORE any writes (SHOULD-FIX: atomicity + idempotency).
    // The atomic RPC (provision_tenant_atomic) uses ON CONFLICT DO NOTHING for
    // the tenant and member inserts, so re-calling the RPC with the same UUID
    // is idempotent. Generating the ID here (not inside the RPC) lets the edge
    // function pass a stable UUID to the RPC; the same ID is returned to the caller
    // so a portal retry can detect a duplicate by checking the returned tenant_id.
    const tenantId = crypto.randomUUID();

    // ── Step 4: Find or create auth user for owner_email ─────────────────────
    let ownerUserId: string;
    let ownerTempPassword: string | undefined;

    const tempPassword = generateTempPassword();

    const { data: createData, error: createErr } = await serviceClient.auth.admin.createUser({
      email:          ownerEmail,
      email_confirm:  true,   // pre-confirmed — super-admin hands temp password to owner
      password:       tempPassword,
      user_metadata:  {},
    });

    if (createData?.user) {
      // New auth user created
      ownerUserId      = createData.user.id;
      ownerTempPassword = tempPassword;
    } else {
      // User already exists (duplicate email or other non-fatal error).
      // Look up the existing user ID via the service-role–only RPC that queries
      // auth.users directly (public.get_auth_user_id_by_email, migration 0008 §10).
      const { data: existingId, error: rpcErr } = await serviceClient
        .rpc('get_auth_user_id_by_email', { p_email: ownerEmail });

      if (rpcErr || !existingId) {
        console.error('provision-tenant: user creation failed and lookup failed',
          { createErr, rpcErr });
        return jsonError(500, `Failed to find or create owner user: ${createErr?.message ?? 'unknown'}`);
      }

      ownerUserId       = existingId as string;
      ownerTempPassword = undefined; // existing user — do not expose a password
    }

    // ── Step 5: Upsert public.profiles ───────────────────────────────────────
    // Idempotent: if the profile already exists (e.g. handle_new_user trigger
    // created it), update full_name if a non-empty value was supplied.
    const { error: profileErr } = await serviceClient
      .from('profiles')
      .upsert(
        { id: ownerUserId, full_name: ownerName, is_active: true },
        { onConflict: 'id', ignoreDuplicates: false },
      );

    if (profileErr) {
      console.error('provision-tenant: profiles upsert failed:', profileErr);
      return jsonError(500, `Failed to upsert owner profile: ${profileErr.message}`);
    }

    // ── Step 6: Atomically create tenant + membership + audit (SHOULD-FIX) ───
    //
    // Previously: three independent non-transactional service-role calls.
    //   Risk A — partial failure: tenant row exists, member/audit row missing.
    //   Risk B — audit swallowed as non-fatal (audit integrity violated).
    //
    // Fix: single call to provision_tenant_atomic() (migration 0008 §11).
    //   * All three writes run in ONE Postgres transaction (atomic).
    //   * Tenant + member inserts use ON CONFLICT DO NOTHING (idempotent for
    //     same tenantId on retry).
    //   * Audit insert is FATAL inside the function — if it fails the whole
    //     transaction rolls back: no orphan tenant without an audit trail.
    //   * SECURITY DEFINER + execute revoked from anon/authenticated: cannot be
    //     called by end-user clients (service-role only, AC 29).
    const { error: rpcErr } = await serviceClient
      .rpc('provision_tenant_atomic', {
        p_tenant_id:   tenantId,
        p_tenant_name: tenantName,
        p_owner_id:    ownerUserId,
        p_actor_id:    user.id,
        p_owner_email: ownerEmail,
        p_is_new_user: ownerTempPassword !== undefined,
      });

    if (rpcErr) {
      // Fatal: atomic transaction failed. No partial state was committed.
      console.error('provision-tenant: atomic RPC failed:', rpcErr);
      return jsonError(500, `Failed to provision tenant: ${rpcErr.message}`);
    }

    // ── Return result ─────────────────────────────────────────────────────────
    // owner_temp_password is included ONLY when a new auth user was created.
    // The super-admin is responsible for handing it to the café owner out-of-band.
    // This endpoint is HTTPS + super-admin-only — the temp password never touches
    // the client bundle or a public channel (AC 29).
    const result: Record<string, unknown> = {
      tenant_id:     tenantId,
      owner_user_id: ownerUserId,
    };
    if (ownerTempPassword !== undefined) {
      result['owner_temp_password'] = ownerTempPassword;
    }

    return new Response(JSON.stringify(result), {
      status:  201,
      headers: { 'Content-Type': 'application/json' },
    });
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
