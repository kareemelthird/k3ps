/**
 * impersonate-tenant — Super-admin edge function (ADR-0008 Decision Q2, completed)
 *
 * Completes the impersonation flow:
 *   1. Validates caller is a super-admin (authoritative DB check — Finding 4 fix).
 *   2. Validates the target tenant is active (rejects suspended targets — AC 22).
 *   3. Clamps TTL to platform_settings.impersonation_max_ttl_seconds (AC 23).
 *   4. INSERTs an impersonation_sessions row (the hook's server-side source of truth).
 *   5. Writes impersonation.start to audit_log (AC 28).
 *   6. Returns success; the CLIENT calls supabase.auth.refreshSession() to obtain
 *      the impersonated token (the hook derives it from the sessions row — AC 21).
 *
 * Mechanism (Decision Q2): the super-admin's auth.uid() is PRESERVED. The token
 * is their own session; the hook stamps the target tenant claim FROM the sessions
 * table row on the next refresh. No "sign-in-as-user" — accountability intact.
 * No service-role key reaches the client (AC 29).
 *
 * Guard (Finding 4 fix): authority checked via profiles.is_platform_admin via the
 * service-role client — NOT from user.app_metadata (getUser() reflects
 * raw_app_meta_data which lacks is_super_admin; the hook injects that only into
 * the JWT). Fail-closed: DB row must be explicitly true.
 *
 * Body: {
 *   target_tenant_id: string,
 *   reason: string,              // min 5 chars (audit trail)
 *   ttl_seconds?: number,        // clamped to platform max (default 900)
 *   role?: 'owner'|'manager'|'staff'  // default 'owner'
 * }
 *
 * SECURITY REVIEWER: Required sign-off — most sensitive path.
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const DEFAULT_TTL_SECONDS = 900;   // 15 minutes when caller does not specify
const HARD_CAP_SECONDS    = 3600;  // absolute hard cap (platform_settings may lower)
const MIN_TTL_SECONDS     = 60;    // floor: 0 / negative / near-zero → immediately dead session

serve(async (req: Request): Promise<Response> => {
  try {
    // ── Step 1: Verify JWT identity via caller client ────────────────────────
    // getUser() validates the JWT signature and returns the user's identity
    // (auth.uid()). We do NOT read app_metadata from this result to check
    // super-admin status — raw_app_meta_data in auth.users does not carry
    // is_super_admin; that claim is injected into the JWT only by the hook.
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
    // of truth for super-admin status. The custom-access-token-hook derives
    // is_super_admin from this column on every token issuance; we re-check here
    // to avoid a dependency on the JWT claim being present in raw_app_meta_data.
    // Service-role client bypasses RLS — intentional; we need a trusted read.
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
    const body = (await req.json()) as {
      target_tenant_id?: string;
      reason?: string;
      ttl_seconds?: number;
      role?: string;
    };

    if (!body.target_tenant_id) {
      return jsonError(400, 'target_tenant_id is required');
    }
    if (!body.reason || body.reason.trim().length < 5) {
      return jsonError(400, 'reason is required (min 5 chars) for audit trail');
    }

    const requestedRole = body.role ?? 'owner';
    if (!['owner', 'manager', 'staff'].includes(requestedRole)) {
      return jsonError(400, 'role must be one of: owner, manager, staff');
    }

    // ── Step 4: Resolve TTL cap from platform_settings (AC 23) ──────────────
    const { data: ttlSetting } = await serviceClient
      .from('platform_settings')
      .select('value')
      .eq('key', 'impersonation_max_ttl_seconds')
      .maybeSingle();

    const platformMaxTtl = ttlSetting?.value != null
      ? Math.min(parseInt(String(ttlSetting.value), 10) || HARD_CAP_SECONDS, HARD_CAP_SECONDS)
      : HARD_CAP_SECONDS;

    // Validate and clamp TTL (NIT fix):
    //   * non-finite (NaN, Infinity, -Infinity) → reject 400
    //   * <= 0 → reject 400 (immediately-dead or negative session makes no sense)
    //   * [1, MIN_TTL_SECONDS) → clamped up to MIN_TTL_SECONDS (floor)
    //   * (MIN_TTL_SECONDS, platformMaxTtl] → accepted as-is
    //   * > platformMaxTtl → clamped down to platformMaxTtl (cap)
    const rawTtl = body.ttl_seconds ?? DEFAULT_TTL_SECONDS;
    if (!Number.isFinite(rawTtl) || rawTtl <= 0) {
      return jsonError(400, 'ttl_seconds must be a positive finite number');
    }
    const ttl = Math.max(MIN_TTL_SECONDS, Math.min(platformMaxTtl, rawTtl));
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

    // ── Step 5: Verify target tenant exists and is active (AC 22) ───────────
    const { data: tenant } = await serviceClient
      .from('tenants')
      .select('id, name, status')
      .eq('id', body.target_tenant_id)
      .maybeSingle();

    if (!tenant) return jsonError(404, 'Target tenant not found');
    if (tenant.status !== 'active') {
      return jsonError(422, 'Target tenant is suspended — cannot impersonate');
    }

    // ── Step 6: End any existing live sessions first (defense-in-depth) ─────
    // Without this, a super-admin could accumulate multiple concurrent live
    // sessions pointing to different tenants. The hook would take the one with the
    // highest expires_at; any remaining sessions are ghost sessions that reactivate
    // impersonation on the next token refresh after the top session ends.
    //
    // Defense-in-depth: the DB-level unique partial index on (impersonator_id)
    // WHERE ended_at IS NULL (migration 0008 §8) enforces at most one live session
    // at the DB level. This application-level step runs first to provide a clean
    // UX (no unique-constraint error) and to immediately close stale sessions.
    const { error: dedupErr } = await serviceClient
      .from('impersonation_sessions')
      .update({ ended_at: new Date().toISOString() })
      .eq('impersonator_id', user.id)
      .is('ended_at', null);

    if (dedupErr) {
      // Non-fatal for normal operation (e.g. no existing sessions). Log and continue.
      console.warn('impersonate-tenant: dedup update warning:', dedupErr.message);
    }

    // ── Step 7: INSERT impersonation_sessions row (hook's source of truth) ──
    // The hook will find this row on the next refreshSession() call and stamp
    // the impersonation claims into the token (Decision Q2).
    const { data: session, error: sessionErr } = await serviceClient
      .from('impersonation_sessions')
      .insert({
        impersonator_id:  user.id,
        target_tenant_id: body.target_tenant_id,
        role:             requestedRole,
        reason:           body.reason.trim(),
        expires_at:       expiresAt,
        // ended_at: null (active by default)
      })
      .select('id')
      .single();

    if (sessionErr || !session) {
      console.error('impersonation_sessions insert failed:', sessionErr);
      return jsonError(500, 'Failed to create impersonation session');
    }

    // ── Step 8: Write impersonation.start to audit_log (AC 28) ───────────────
    // Written against the TARGET tenant so it appears in that tenant's audit trail.
    await serviceClient.from('audit_log').insert({
      tenant_id: body.target_tenant_id,
      actor_id:  user.id,
      action:    'impersonation.start',
      entity:    'tenants',
      entity_id: body.target_tenant_id,
      meta: {
        impersonation_session_id: session.id,
        impersonator_id:          user.id,
        target_tenant_id:         body.target_tenant_id,
        target_tenant_name:       tenant.name,
        role:                     requestedRole,
        expires_at:               expiresAt,
        ttl_seconds:              ttl,
        reason:                   body.reason.trim(),
      },
    });

    // ── Return success — client calls supabase.auth.refreshSession() ─────────
    // The hook picks up the live sessions row on refresh and stamps the claim.
    // NO service-role key, NO custom JWT reaches the client (AC 29).
    return new Response(
      JSON.stringify({
        session_id:  session.id,
        expires_at:  expiresAt,
        ttl_seconds: ttl,
        // Instruct the client to refresh immediately to receive the impersonated token.
        next_action: 'call supabase.auth.refreshSession()',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('impersonate-tenant error:', err);
    return jsonError(500, 'Internal error');
  }
});

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
