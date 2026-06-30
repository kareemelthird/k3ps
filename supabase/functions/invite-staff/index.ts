/**
 * invite-staff — Tenant-owner edge function (ADR-0012 Slice 2)
 *
 * Invites a new staff/manager to a tenant by finding or creating their auth
 * user account, then atomically creating/updating the tenant membership.
 *
 * Authorization (ADR-0012 "Finding 4" lesson — mirrors provision-tenant):
 * The caller's authority is verified against the AUTHORITATIVE tenant_members
 * row in the DB via the service-role client — NOT from getUser().app_metadata
 * (which reflects raw_app_meta_data and lacks the hook-injected claims).
 * Fail-closed: the DB row must explicitly show an active owner of the tenant.
 *
 * Body: {
 *   tenant_id:    string (uuid),            // required — target tenant
 *   email:        string,                   // required — new member login
 *   role:         'manager' | 'staff',      // required — owners not mintable here
 *   full_name?:   string,
 *   permissions?: {
 *     can_restock?:      boolean,
 *     can_void?:         boolean,
 *     can_manage_debts?: boolean,
 *     can_discount?:     boolean,
 *   }
 * }
 *
 * Returns:
 *   201 { profile_id: string, temp_password?: string }
 *   temp_password is present ONLY when a new auth user was created. The owner
 *   is responsible for handing it to the new staff member out-of-band.
 *   It is never logged and never in the client bundle.
 *
 * This endpoint does NOT handle:
 *   - Changing an existing member's role/permissions/is_active (direct client
 *     UPDATE on tenant_members under tenant_members_owner_write RLS policy).
 *   - Deactivating a member (set is_active=false via the above client UPDATE).
 *
 * SECURITY REVIEWER: Required sign-off. Verify:
 *   * Authority check uses service-role client against authoritative DB row.
 *   * Role validation rejects 'owner' and 'super_admin'.
 *   * Permission key validation rejects unknown keys / non-boolean values.
 *   * temp_password is never returned for existing users.
 *   * invite_staff_atomic() is service-role-only (cannot be called by clients).
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── Constants ─────────────────────────────────────────────────────────────────

const ALLOWED_ROLES: ReadonlySet<string> = new Set(['manager', 'staff']);

const ALLOWED_PERMISSION_KEYS: ReadonlySet<string> = new Set([
  'can_restock',
  'can_void',
  'can_manage_debts',
  'can_discount',
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Generate a cryptographically random temp password meeting common complexity rules. */
function generateTempPassword(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  // Hex gives 48 chars of randomness; append suffix to meet digit+upper+special.
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 20) + 'Aa1!'; // 24 chars, entropy dominated by random hex
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── Handler ───────────────────────────────────────────────────────────────────

serve(async (req: Request): Promise<Response> => {
  try {
    // ── Step 1: Verify JWT identity ──────────────────────────────────────────
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return jsonError(401, 'Missing Authorization header');

    // Use the caller's token to identify who is making the request.
    const callerClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: { user }, error: authErr } = await callerClient.auth.getUser();
    if (authErr || !user) return jsonError(401, 'Unauthenticated');
    const callerId = user.id;

    // ── Step 2: Parse and validate body ──────────────────────────────────────
    let body: {
      tenant_id?: string;
      email?: string;
      role?: string;
      full_name?: string;
      permissions?: Record<string, unknown>;
    };

    try {
      body = (await req.json()) as typeof body;
    } catch {
      return jsonError(400, 'Request body must be valid JSON');
    }

    // tenant_id — required, must look like a UUID
    if (!body.tenant_id || typeof body.tenant_id !== 'string') {
      return jsonError(400, 'tenant_id is required');
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.tenant_id)) {
      return jsonError(400, 'tenant_id must be a valid UUID');
    }

    // email — required
    if (!body.email || body.email.trim().length === 0) {
      return jsonError(400, 'email is required');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) {
      return jsonError(400, 'email format is invalid');
    }

    // role — must be manager or staff (owners cannot be minted here)
    if (!body.role || !ALLOWED_ROLES.has(body.role)) {
      return jsonError(400, 'role must be "manager" or "staff"');
    }

    // permissions — optional; validate keys and value types
    if (body.permissions != null) {
      if (typeof body.permissions !== 'object' || Array.isArray(body.permissions)) {
        return jsonError(400, 'permissions must be an object');
      }
      for (const [key, val] of Object.entries(body.permissions)) {
        if (!ALLOWED_PERMISSION_KEYS.has(key)) {
          return jsonError(400, `unknown permission key: "${key}"`);
        }
        if (typeof val !== 'boolean') {
          return jsonError(400, `permission "${key}" must be a boolean`);
        }
      }
    }

    const tenantId    = body.tenant_id.trim();
    const email       = body.email.trim().toLowerCase();
    const role        = body.role;
    const fullName    = (body.full_name ?? '').trim();
    const permissions = body.permissions ?? {};

    // ── Step 3: Guard — authoritative DB check (never trust app_metadata) ───
    //
    // ADR-0012 "Finding 4": getUser().app_metadata reflects raw_app_meta_data
    // which lacks the hook-injected claims (tenant_id, roles). The only
    // authoritative source is the DB row itself, read via the service-role client.
    const serviceClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const { data: membership, error: memberErr } = await serviceClient
      .from('tenant_members')
      .select('role')
      .eq('profile_id', callerId)
      .eq('tenant_id', tenantId)
      .eq('role', 'owner')
      .eq('is_active', true)
      .maybeSingle();

    if (memberErr) {
      console.error('invite-staff: membership check failed:', memberErr);
      return jsonError(500, 'Internal error during authorization check');
    }

    // Fail-closed: the row must be explicitly present and active-owner.
    if (!membership) {
      return jsonError(403, 'Forbidden: active owner of the target tenant required');
    }

    // ── Step 4: Find or create the auth user for the invitee ────────────────
    let profileId: string;
    let tempPassword: string | undefined;

    const generatedPassword = generateTempPassword();

    const { data: createData, error: createErr } = await serviceClient.auth.admin.createUser({
      email:         email,
      email_confirm: true,    // pre-confirmed; owner hands temp_password out-of-band
      password:      generatedPassword,
      user_metadata: {},
    });

    if (createData?.user) {
      // New auth user created — return the temp password to the owner.
      profileId    = createData.user.id;
      tempPassword = generatedPassword;
    } else {
      // Auth user already exists (duplicate email) — look up existing ID.
      // Uses the service-role-only RPC that queries auth.users directly.
      const { data: existingId, error: lookupErr } = await serviceClient
        .rpc('get_auth_user_id_by_email', { p_email: email });

      if (lookupErr || !existingId) {
        console.error('invite-staff: user lookup failed', { createErr, lookupErr });
        return jsonError(500, `Failed to find or create user: ${createErr?.message ?? 'unknown'}`);
      }

      profileId    = existingId as string;
      tempPassword = undefined; // existing user — do not expose a password
    }

    // ── Step 5: Upsert public.profiles ───────────────────────────────────────
    // Idempotent: if handle_new_user() already created the profile row,
    // update full_name if a non-empty value was provided.
    const { error: profileErr } = await serviceClient
      .from('profiles')
      .upsert(
        { id: profileId, full_name: fullName, is_active: true },
        { onConflict: 'id', ignoreDuplicates: false },
      );

    if (profileErr) {
      console.error('invite-staff: profiles upsert failed:', profileErr);
      return jsonError(500, `Failed to upsert profile: ${profileErr.message}`);
    }

    // ── Step 6: Atomically upsert membership + write fatal audit ─────────────
    // invite_staff_atomic() is SECURITY DEFINER + service-role-only.
    // It refuses to demote an existing owner (ON CONFLICT DO UPDATE WHERE role<>'owner').
    // The audit INSERT is fatal — any failure rolls back the membership upsert too.
    const { error: rpcErr } = await serviceClient
      .rpc('invite_staff_atomic', {
        p_tenant_id:   tenantId,
        p_profile_id:  profileId,
        p_actor_id:    callerId,
        p_role:        role,
        p_permissions: permissions,
        p_email:       email,
        p_is_new_user: tempPassword !== undefined,
      });

    if (rpcErr) {
      console.error('invite-staff: atomic RPC failed:', rpcErr);
      return jsonError(500, `Failed to invite staff: ${rpcErr.message}`);
    }

    // ── Return result ─────────────────────────────────────────────────────────
    // temp_password is included ONLY when a new auth user was created.
    // This endpoint is HTTPS + owner-only; the password is never logged.
    const result: Record<string, unknown> = { profile_id: profileId };
    if (tempPassword !== undefined) {
      result['temp_password'] = tempPassword;
    }

    return new Response(JSON.stringify(result), {
      status:  201,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('invite-staff unexpected error:', err);
    return jsonError(500, 'Internal error');
  }
});
