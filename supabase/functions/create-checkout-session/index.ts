/**
 * create-checkout-session — Owner-authenticated Stripe Checkout URL minter
 *
 * Security model (ADR-0010 Q2, AC 20, 25):
 *   * Caller must be an authenticated OWNER (verified via DB tenant_members, not
 *     JWT claim alone — same ADR-0008 guard pattern as provision-tenant).
 *   * Stripe customer is found-or-created idempotently (search by metadata first),
 *     then persisted via service-role (no client write policy on subscriptions).
 *   * Returns only the server-minted Checkout session URL — no Stripe secret reaches
 *     the client (AC 20). The publishable key is a separate NEXT_PUBLIC env var.
 *   * Checkout Session carries metadata.tenant_id for belt-and-suspenders audit;
 *     the webhook NEVER trusts metadata — it resolves tenant from stripe_customer_id.
 *
 * Body: { plan_key: 'basic' | 'pro' }
 * Returns: { url: string }
 *
 * Env (server-side only):
 *   STRIPE_SECRET_KEY          Stripe secret key
 *   SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY — injected
 *   SITE_URL                   Fallback for success/cancel redirect base URL
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

    // ── Step 3: Parse and validate body ──────────────────────────────────────
    let body: { plan_key?: string };
    try {
      body = await req.json();
    } catch {
      return jsonError(400, 'Invalid JSON body');
    }

    const planKey = body.plan_key?.trim();
    if (!planKey) return jsonError(400, 'plan_key is required');

    // ── Step 4: Get the plan's Stripe price ID ────────────────────────────────
    const { data: plan, error: planErr } = await serviceClient
      .from('plans')
      .select('stripe_price_id')
      .eq('key', planKey)
      .eq('is_active', true)
      .maybeSingle();

    if (planErr || !plan) return jsonError(400, `Unknown plan: ${planKey}`);
    if (!plan.stripe_price_id) {
      return jsonError(
        400,
        `Plan '${planKey}' has no Stripe price configured yet. ` +
        'The administrator must populate plans.stripe_price_id first.',
      );
    }

    // ── Step 5: Find or create Stripe customer for this tenant ────────────────
    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
      apiVersion: '2024-06-20',
      httpClient: Stripe.createFetchHttpClient(),
    });

    const { data: sub } = await serviceClient
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    let customerId = sub?.stripe_customer_id as string | null | undefined;

    if (!customerId) {
      // Idempotency guard: search for an existing customer by metadata before creating.
      const existing = await stripe.customers.search({
        query: `metadata['tenant_id']:'${tenantId}'`,
        limit: 1,
      });

      if (existing.data.length > 0) {
        customerId = existing.data[0].id;
      } else {
        const customer = await stripe.customers.create({
          email:    user.email,
          metadata: { tenant_id: tenantId },
        });
        customerId = customer.id;
      }

      // Persist stripe_customer_id via service-role (bypasses the no-client-write RLS).
      const { error: updateErr } = await serviceClient
        .from('subscriptions')
        .update({ stripe_customer_id: customerId })
        .eq('tenant_id', tenantId);

      if (updateErr) {
        console.error('[create-checkout-session] failed to persist stripe_customer_id:', updateErr);
        return jsonError(500, 'Failed to persist customer ID');
      }
    }

    // ── Step 6: Create Stripe Checkout Session (subscription mode) ────────────
    const origin     = req.headers.get('origin') || Deno.env.get('SITE_URL') || 'http://localhost:3000';
    // URL params match EXACTLY what the web billing page reads:
    //   searchParams.get('checkout') === 'success' | 'cancel'
    const successUrl = `${origin}/dashboard/billing?checkout=success`;
    const cancelUrl  = `${origin}/dashboard/billing?checkout=cancel`;

    const session = await stripe.checkout.sessions.create({
      mode:       'subscription',
      customer:   customerId,
      line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
      success_url: successUrl,
      cancel_url:  cancelUrl,
      // Belt-and-suspenders metadata: the webhook NEVER trusts this to name the tenant;
      // it resolves via stripe_customer_id. This is for dashboard visibility only.
      metadata:   { tenant_id: tenantId },
    });

    // ── Audit ─────────────────────────────────────────────────────────────────
    await serviceClient.from('audit_log').insert({
      tenant_id: tenantId,
      actor_id:  user.id,
      action:    'subscription.checkout_started',
      entity:    'subscriptions',
      meta:      { plan_key: planKey, stripe_session_id: session.id },
    });

    // Return only the server-minted URL — no secret reaches the client (AC 20).
    return new Response(JSON.stringify({ url: session.url }), {
      status:  200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[create-checkout-session] error:', msg);
    return jsonError(500, 'Internal error');
  }
});

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
