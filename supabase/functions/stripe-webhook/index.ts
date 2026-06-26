/**
 * stripe-webhook — Stripe event ingestion edge function
 *
 * Security model (ADR-0010 Q2, AC 13-18):
 *   * verify_jwt = false (set in config.toml): Stripe is not a Supabase-authenticated
 *     caller. Its identity is proved by HMAC signature on the raw body.
 *   * Raw body is read via req.text() BEFORE any parsing — parsing corrupts the
 *     bytes that Stripe signed.
 *   * Signature verified with constructEventAsync + createSubtleCryptoProvider
 *     (Web Crypto API, required in Deno). Invalid signature → 4xx, no state change.
 *   * Tenant resolved from OUR stored stripe_customer_id → tenant_id map.
 *     The event body is NEVER trusted to name the tenant (AC 16).
 *   * State change goes through apply_stripe_subscription_event (SECURITY DEFINER,
 *     service-role only): idempotent on event_id, sets tenant_id explicitly,
 *     UPDATE ... WHERE stripe_customer_id = :customer (cannot cross tenants).
 *   * 2xx returned ONLY after the RPC commits durably (non-2xx → Stripe retries).
 *
 * Handled events:
 *   checkout.session.completed          — subscription activation hint + ID bind
 *   customer.subscription.created|updated|deleted — authoritative status sync
 *   invoice.payment_failed              — drives past_due
 *
 * Env (server-side only; NEVER in client bundle):
 *   STRIPE_SECRET_KEY              Stripe secret key (test-mode for now)
 *   STRIPE_WEBHOOK_SIGNING_SECRET  Webhook signing secret from Stripe dashboard
 *   SUPABASE_URL                   Injected by Supabase runtime
 *   SUPABASE_SERVICE_ROLE_KEY      Injected by Supabase runtime
 *
 * SECURITY REVIEWER: required sign-off on this file (webhook trust boundary).
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'https://esm.sh/stripe@14.21.0?target=deno&no-check';

// Our DB enum values — mirrors public.subscription_status in migration 0010.
type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled' | 'incomplete';

/** Map Stripe's subscription status to our enum (Q4 decision table). */
function mapStripeStatus(status: string): SubscriptionStatus {
  switch (status) {
    case 'trialing':           return 'trialing';
    case 'active':             return 'active';
    case 'past_due':
    case 'unpaid':             return 'past_due';
    case 'canceled':           return 'canceled';
    case 'incomplete':
    case 'incomplete_expired':
    case 'paused':
    default:                   return 'incomplete';
  }
}

/** Call the SECURITY DEFINER write RPC via the service-role client. */
async function syncSubscription(
  serviceClient: ReturnType<typeof createClient>,
  eventId: string,
  eventType: string,
  eventCreated: number,       // Unix timestamp from Stripe event
  customerId: string,
  sub: Stripe.Subscription,
  statusOverride?: SubscriptionStatus,
): Promise<string> {
  const status    = statusOverride ?? mapStripeStatus(sub.status);
  const priceId   = sub.items?.data?.[0]?.price?.id ?? null;
  const periodEnd = sub.current_period_end
    ? new Date(sub.current_period_end * 1000).toISOString()
    : null;
  const trialEnd  = sub.trial_end
    ? new Date(sub.trial_end * 1000).toISOString()
    : null;
  const amount    = sub.items?.data?.[0]?.price?.unit_amount ?? null;
  const currency  = sub.currency ?? null;

  const { data, error } = await serviceClient.rpc('apply_stripe_subscription_event', {
    p_event_id:             eventId,
    p_event_type:           eventType,
    p_event_created:        new Date(eventCreated * 1000).toISOString(),
    p_customer_id:          customerId,
    p_subscription_id:      sub.id,
    p_status:               status,
    p_price_id:             priceId,
    p_current_period_end:   periodEnd,
    p_trial_end:            trialEnd,
    p_cancel_at_period_end: sub.cancel_at_period_end ?? false,
    p_amount:               amount,
    p_currency:             currency,
  });

  if (error) throw new Error(`apply_stripe_subscription_event failed: ${error.message}`);
  console.log(`[stripe-webhook] event=${eventId} type=${eventType} result=${data}`);
  return data as string;
}

serve(async (req: Request): Promise<Response> => {
  const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
    apiVersion: '2024-06-20',
    httpClient: Stripe.createFetchHttpClient(),
  });

  // Read the raw body BEFORE any parsing — required for signature verification.
  // Parsing JSON first would corrupt the bytes Stripe signed.
  const body       = await req.text();
  const sig        = req.headers.get('stripe-signature') ?? '';
  const sigSecret  = Deno.env.get('STRIPE_WEBHOOK_SIGNING_SECRET') ?? '';

  // Verify the Stripe signature using the Web Crypto API (Deno-compatible).
  // Invalid/missing signature → 400; no state change.
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      sig,
      sigSecret,
      undefined,
      Stripe.createSubtleCryptoProvider(),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[stripe-webhook] signature verification failed:', msg);
    return jsonError(400, `Webhook signature verification failed: ${msg}`);
  }

  const serviceClient = createClient(
    Deno.env.get('SUPABASE_URL')              ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        // Belt-and-suspenders activation hint (Q4). The session has subscription as
        // a string ID; retrieve the full object to get status/period/price fields.
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode !== 'subscription' || !session.subscription) break;
        const customerId = session.customer as string;
        const sub = await stripe.subscriptions.retrieve(session.subscription as string);
        await syncSubscription(serviceClient, event.id, event.type, event.created, customerId, sub);
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        // Authoritative status sync: the full subscription object is embedded in the event.
        const sub        = event.data.object as Stripe.Subscription;
        const customerId = sub.customer as string;
        await syncSubscription(serviceClient, event.id, event.type, event.created, customerId, sub);
        break;
      }

      case 'invoice.payment_failed': {
        // Drives past_due. Retrieve the subscription for full current state.
        const invoice = event.data.object as Stripe.Invoice;
        if (!invoice.subscription) break;
        const customerId = invoice.customer as string;
        const sub = await stripe.subscriptions.retrieve(invoice.subscription as string);
        // Pass 'past_due' override: we know the intent regardless of current sub.status.
        await syncSubscription(serviceClient, event.id, event.type, event.created, customerId, sub, 'past_due');
        break;
      }

      default:
        // Unhandled event type — log and acknowledge (Stripe does not need a retry).
        console.log(`[stripe-webhook] unhandled event type: ${event.type}`);
    }

    // Return 2xx ONLY after the RPC has committed durably.
    // Non-2xx here would cause Stripe to retry (at-least-once delivery is idempotent).
    return new Response(JSON.stringify({ received: true }), {
      status:  200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[stripe-webhook] handler error:', msg);
    // 500 → Stripe retries. The RPC is idempotent on event_id, so retries are safe.
    return jsonError(500, 'Internal error processing webhook');
  }
});

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
