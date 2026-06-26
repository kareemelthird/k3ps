/**
 * create-portal-session — Owner-authenticated Stripe Customer Portal URL minter
 *
 * Security model (ADR-0010 Q2, AC 20, 25):
 *   * Same ADR-0008 owner guard as create-checkout-session: DB membership verified,
 *     not JWT claim alone.
 *   * Returns only the server-minted portal URL — no secret reaches the client.
 *   * If the tenant has no Stripe customer yet (never subscribed), returns 400.
 *     The owner must subscribe first via create-checkout-session.
 *
 * Returns: { url: string }
 *
 * Env (server-side only):
 *   STRIPE_SECRET_KEY          Stripe secret key
 *   SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY — injected
 *   SITE_URL                   Fallback for portal return URL base
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'https://esm.sh/stripe@14.21.0?target=deno&no-check';

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

    // ── Step 2: Guard — owner-only, tenant pinned to signed JWT claim ─────────
    // MULTI-TENANT FIX: resolve tenant_id from the signed app_metadata claim
    // (stamped by the custom-access-token hook — not from the request body).
    // Then verify the caller is an active OWNER of EXACTLY that tenant.
    // This handles owners who belong to >1 tenant (maybeSingle() would 403 them).
    const claimTenantId = (user.app_metadata?.['tenant_id'] ?? null) as string | null;
    if (!claimTenantId) {
      return jsonError(403, 'Forbidden: no tenant claim — token may be stale, please sign in again');
    }

    const serviceClient = createClient(
      Deno.env.get('SUPABASE_URL')              ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const { data: membership, error: memberErr } = await serviceClient
      .from('tenant_members')
      .select('tenant_id, role')
      .eq('profile_id', user.id)
      .eq('tenant_id', claimTenantId)
      .eq('role', 'owner')
      .eq('is_active', true)
      .single();

    if (memberErr || !membership) {
      return jsonError(403, 'Forbidden: active owner membership required');
    }

    const tenantId = membership.tenant_id as string;

    // ── Step 3: Get the tenant's Stripe customer ID ───────────────────────────
    const { data: sub } = await serviceClient
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    const customerId = sub?.stripe_customer_id as string | null | undefined;
    if (!customerId) {
      return jsonError(
        400,
        'No Stripe customer yet. Please subscribe first via the billing page.',
      );
    }

    // ── Step 4: Create Stripe Customer Portal Session ─────────────────────────
    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
      apiVersion: '2024-06-20',
      httpClient: Stripe.createFetchHttpClient(),
    });

    const origin    = req.headers.get('origin') || Deno.env.get('SITE_URL') || 'http://localhost:3000';
    // URL param matches EXACTLY what the web billing page reads:
    //   searchParams.get('portal') === 'return'
    const returnUrl = `${origin}/dashboard/billing?portal=return`;

    const portalSession = await stripe.billingPortal.sessions.create({
      customer:   customerId,
      return_url: returnUrl,
    });

    // ── Audit ─────────────────────────────────────────────────────────────────
    await serviceClient.from('audit_log').insert({
      tenant_id: tenantId,
      actor_id:  user.id,
      action:    'subscription.portal_opened',
      entity:    'subscriptions',
      meta:      { stripe_customer_id: customerId },
    });

    return new Response(JSON.stringify({ url: portalSession.url }), {
      status:  200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[create-portal-session] error:', msg);
    return jsonError(500, 'Internal error');
  }
});

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
