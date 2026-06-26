# ADR-0010: SaaS billing — Stripe subscriptions, the no-JWT webhook trust boundary & tenant mapping, entitlement enforcement, and the plan/subscription/dedupe schema

- **Status:** Accepted (Phase-9 design gate. **`security-reviewer` sign-off REQUIRED — release blocker** on: (a) the Stripe **webhook trust boundary** — signature verification on the raw body, idempotency on `event.id`, the server-side `stripe_customer_id → tenant_id` mapping, and the SECURITY DEFINER write RPC that sets `tenant_id` explicitly — spec Block C AC 13–20, AC 38; (b) the **subscription/plans/stripe_events RLS** — owner reads own, super-admin reads all, **no client write** — spec Block B AC 7–12, AC 39; (c) the **plan-cap enforcement trigger** and proof it does not regress Phase 2–8 isolation — AC 11, 30–32; and (d) no secret/signing key in any client bundle — AC 20. The human project owner approves at the Phase-9 gate: the **tier definitions + prices + currency** (Q1/Q5), the **webhook isolation model** (Q2), the **entitlement enforcement model** (Q3), and the **grace/lapse/lifecycle policy** (Q6). All work is **Stripe test-mode**; the live-key cutover is a separate human step.)
- **Date:** 2026-06-26
- **Deciders:** architect (deciding — tenant-isolation authority) · `security-reviewer` (webhook trust boundary / subscription RLS / cap-trigger / no-secret-leak sign-off — **required**) · backend / supabase-migrate (authors `0010` + the four edge functions from the normative SQL/contracts below) · core-engineer (the pure `@ps/core/entitlements` resolver) · web-engineer (`/dashboard/billing` owner UI + `/admin` subscriptions view + cap messaging) · ux-designer (billing page, plan-picker, limit-reached dialog, paywall banners, super-admin table + comp dialog) · product-manager (tier/price/grace ratification) · human project owner (Phase-9 gate)
- **Builds on:** [ADR-0002 — isolation model](0002-tenant-isolation-model-ratified.md) (shared-DB + `tenant_id` + RLS; `current_tenant_id()` is the only tenant resolver) · [ADR-0003 — auth claim & impersonation model](0003-auth-claim-and-impersonation-model.md) (scalar signed `app_metadata` claims; `is_super_admin` from `profiles.is_platform_admin`) · [ADR-0007 — reporting RLS read path](0007-reporting-aggregation-and-rls.md) (no `SECURITY DEFINER` on tenant-visible read paths; the grep-for-`OR is_super_admin()` invariant) · [ADR-0008 — super-admin platform ops](0008-super-admin-and-impersonation.md) (the `is_platform_admin`-via-service-role edge-fn guard; the SECURITY DEFINER + `execute`-revoked-from-anon/authenticated, service-role-only RPC pattern — `provision_tenant_atomic`/`get_auth_user_id_by_email`; the `request.jwt.claims` context-skip guard for triggers; audit-insert-fatal-inside-the-txn) · [ADR-0009 — offline hardening](0009-offline-outbox-and-realtime.md) (the **Phase-8 lesson**: privileged writes that bypass RLS are idempotent on a **dedupe key** and set `tenant_id` **explicitly**; a replay is a no-op).
- **Reference:** `docs/specs/phase-9-saas-billing-stripe.md` §6 (acceptance criteria) / §7 (Q1–Q10) · `supabase/migrations/0001_tenancy_core.sql` (`tenants.status`, `tenant_members(tenant_id, profile_id, role, is_active)`, `branches.is_active`, `profiles.is_platform_admin`, `platform_settings`) · `0002_operational_tables.sql` (`devices.is_active`, `audit_log(tenant_id, branch_id, actor_id, action, entity, entity_id, amount, meta, created_at)`) · `0003_claim_helpers.sql` (`current_tenant_id()`, `is_super_admin()`, `is_tenant_owner()`, `is_tenant_staff()`, `is_active_member()`) · `0004_rls_policies.sql` · `0008_super_admin_and_impersonation.sql` (`provision_tenant_atomic`, `is_impersonating()`, the trigger context-skip pattern) · `supabase/functions/{provision-tenant,suspend-tenant,reactivate-tenant}/index.ts` · `CLAUDE.md` §2.1 (money integer minor units), §2.7 (auditable money), §2.8 (idempotent writes), §5 (tenancy/security; no secret in client).

## Context

PS-Managment has the full operational stack (Phases 2–8) and a super-admin portal (Phase 7) but **no way to charge for itself** (spec §1). Phase 9 adds the monetization layer in **Stripe test-mode**: a plan/tier catalog with feature limits, a per-tenant subscription record, a trial→paid flow via **Stripe Checkout** + **Customer Portal** (both reached only through server-minted redirect URLs), a **webhook** that is the single source of truth syncing Stripe state into our DB, an **entitlement/paywall** layer, and super-admin plan management.

The novel risk is a **new external trust boundary**: Stripe. The webhook arrives **with no user JWT**, so its writes run as the **service-role and bypass RLS** — exactly the situation ADR-0008/0009 warned about. Correctness depends entirely on the function verifying Stripe's signature, mapping the event to a tenant **from our own stored data** (never the event's claimed tenant), writing through a **SECURITY DEFINER RPC that sets `tenant_id` explicitly and is idempotent on `event.id`**, and tolerating Stripe's at-least-once, **out-of-order** delivery.

**Hard constraints (`CLAUDE.md`):** §5 — tenant identity is the signed claim, never client/event input; RLS on every table; the Stripe **secret key and signing secret are server-only** (edge-function env), never in any client bundle; the browser receives only a server-minted Checkout/Portal URL (+ at most the publishable key). §2.1 — money is integer minor units; the subscription charge is a **separate money axis** from the café's EGP piastres and never touches `@ps/core` pricing. §2.7 — every billing state change writes `audit_log`. §2.8 — idempotent writes (replay/duplicate is a no-op). §2.6 — Arabic-first RTL UI (Stripe's hosted pages are external/exempt).

**Forces in tension:** a no-JWT service-role write that bypasses RLS vs. the "one isolation surface" rule; DB-enforced plan caps (un-bypassable) vs. not breaking the subtle Phase 2–8 RLS/`WITH CHECK` policies and never bricking a tenant; Stripe-as-source-of-truth vs. out-of-order events regressing newer state; gating a lapsed tenant read-only vs. **never** locking an owner out of the page where they pay.

The ten open questions (spec §7) are locked below.

---

## Decisions (Q1–Q10, locked)

### Decision Q2 (decided first — it is the central security call) — Webhook → tenant mapping & the no-JWT isolation model: **verify the Stripe signature on the raw body, then write via a SECURITY DEFINER RPC that resolves the tenant from OUR stored `stripe_customer_id → tenant_id` map, sets `tenant_id` explicitly, and is idempotent on `event.id`**

**Evidence established (verified):** Stripe webhook security has four non-negotiables — verify the `stripe-signature` header against the **raw** request body (parse JSON *after* verification, or you corrupt the bytes Stripe signed), make fulfillment **idempotent on `event.id`** (store each processed id behind a UNIQUE constraint and short-circuit), return **2xx only after** the state is durably persisted, and tolerate **at-least-once** delivery with retries for up to ~72h. In a Deno/Supabase edge function this is `const body = await req.text(); const event = await stripe.webhooks.constructEventAsync(body, sig, signingSecret);`. The webhook function must run with **`verify_jwt = false`** (`auth: 'none'`) — Stripe is not a Supabase-authenticated caller; it signs with its own shared secret, which we verify **inside** the handler. (Sources at end: Stripe — Receive events / Signature; Supabase — Handling Stripe Webhooks / Function Configuration.)

**Mechanism (locked):**
1. **The webhook is the only no-JWT write path.** `supabase/functions/stripe-webhook` runs `verify_jwt = false`. It reads the **raw** body via `req.text()`, verifies the signature with `constructEventAsync` against `STRIPE_WEBHOOK_SIGNING_SECRET` (edge-env, server-only). **Invalid/missing signature → 4xx, no state change** (AC 13).
2. **Tenant is resolved from OUR data, never the event.** Every Stripe **customer** we create is stamped (a) with `metadata.tenant_id` at creation (cross-check) **and** (b) recorded as `subscriptions.stripe_customer_id` (the authoritative reverse map; `stripe_customer_id` is `UNIQUE`). The handler extracts the `customer` id from the verified event and passes it to the write RPC, which resolves `tenant_id` by **looking up `subscriptions WHERE stripe_customer_id = :customer`** — it never reads any tenant field from the event body.
3. **The write goes through one SECURITY DEFINER RPC** — `apply_stripe_subscription_event(...)` (normative SQL below). It (a) records the event in `stripe_events` (PK `event_id`) `ON CONFLICT DO NOTHING` — **if the row already existed, it returns `'duplicate'` and changes nothing** (idempotency on `event.id`, AC 15); (b) resolves `tenant_id` server-side from `stripe_customer_id`; (c) applies the out-of-order guard (Q4); (d) updates the `subscriptions` row **`WHERE tenant_id = <resolved> AND stripe_customer_id = :customer`** — so it is **structurally impossible** to touch a different tenant's row; (e) writes `audit_log`. `execute` is **revoked from anon/authenticated, granted only to `service_role`**.

**The exact isolation guarantee for these no-JWT writes (the crux):** the webhook bypasses RLS (service-role + SECURITY DEFINER), so isolation is *not* enforced by a policy on this path — it is enforced by **construction**: (i) a forged event cannot pass signature verification; (ii) the target tenant is **derived by lookup of our own `stripe_customer_id` map**, never trusted from the event, so an attacker cannot name a victim tenant; (iii) the `UPDATE … WHERE stripe_customer_id = :customer` predicate means the only row that can change is the one already bound to that exact Stripe customer; (iv) replay/duplicate delivery is a no-op via the `stripe_events` dedupe key; (v) an unmappable customer (no `subscriptions` row) is recorded and **no-ops** (`'unmapped'`) rather than guessing a tenant. There is **no event-supplied field that can redirect a write to another tenant.** This is the Phase-8 lesson (ADR-0009) applied verbatim: privileged no-JWT writes set `tenant_id` explicitly and are idempotent on a dedupe key.

### Decision Q1 — Plan catalog: **a DB-seeded `plans` table; limits as explicit integer columns (for the cap trigger), features as JSONB; tiers `trial`/`basic`/`pro`; monthly-only**

`public.plans` (normative DDL below) is seeded by the migration. **Limits are explicit `int` columns** (`max_branches`, `max_devices`, `max_staff`) — not a JSONB blob — because the DB cap trigger (Q3) must read a single limit cheaply and a typed column is greppable/constrainable; **`features` is a JSONB flag set** for forward flexibility. `key text PRIMARY KEY` (referenced by `subscriptions.plan`) so adding a tier is a seed row, not an enum migration. `stripe_price_id text UNIQUE` is **nullable** — `trial` has no Stripe price. Interval is `'month'` this phase (column present for the future). The **proposed** catalog (human approves the numbers + prices at the gate):

| key | max_branches | max_devices (per tenant) | max_staff (incl. owner) | stripe_price_id | price |
|---|---|---|---|---|---|
| `trial` | 1 | 5 | 3 | NULL | free (app-side trial) |
| `basic` | 1 | 10 | 8 | `price_…` (user-supplied) | monthly |
| `pro` | 5 | 50 | 50 | `price_…` (user-supplied) | monthly |

`max_devices` is **per-tenant total** (not per-branch) this phase — it is the count the cap trigger evaluates; per-branch device limits are deferred. `stripe_price_id` values are **environment-specific and supplied by the user post-seed** (test-mode now, live at cutover); the migration seeds the rows with `NULL` price ids and the user populates them (a user-only action, §User-only). The plan catalog is the single source of truth for limits — both the `@ps/core` resolver (Q7) and the DB cap trigger (Q3) read the **same** `plans` rows.

### Decision Q3 (central call) — Entitlement enforcement: **BOTH layers, with a DB trigger as the authoritative backstop for count caps and the app resolver for UX; the trigger is additive and cannot regress Phase 2–8 RLS**

Plan **count caps** (branch/device/staff creation) are enforced at **both** layers:
- **App layer (UX):** the `@ps/core` resolver (Q7) tells the web UI the limits and current usage so it can show "you've reached your plan limit — upgrade" *before* a doomed request (AC 30, friendly message).
- **DB layer (authoritative backstop):** a **`BEFORE INSERT` trigger** — `enforce_plan_cap()` (normative SQL below) — on `branches`, `devices`, and `tenant_members` counts the tenant's current **active** rows against the resolved plan limit and `raise`s on exceed. Because it is a DB trigger, the cap holds **even if the client bypasses the web app** (direct PostgREST) — AC 30's "the cap must hold even if the client is bypassed."

**Why this does not break Phase 2–8 RLS (the riskiest interaction, resolved):**
- The trigger is **purely additive** — it alters **no** existing policy and adds **no** `WITH CHECK` that counts rows (the spec's Phase-8 nested-guard hazard is avoided entirely; a counting `WITH CHECK` is subtle and was explicitly rejected). It only *rejects* an insert that exceeds the cap; an insert under the cap proceeds to the unchanged RLS `WITH CHECK`.
- It is **`SECURITY DEFINER`** so it can read `subscriptions`/`plans` for `NEW.tenant_id` regardless of the caller's read grants, with `set search_path = public` (injection-safe, ADR-0008 pattern).
- It **skips non-end-user contexts** using the exact ADR-0008 guard: if `request.jwt.claims` is empty (migration/seed/`psql`) **or** the JWT `role` is `service_role`, it returns `NEW` immediately. So **provisioning, backfill, comp/override, and seeds are never blocked** — the cap applies **only** to authenticated PostgREST inserts (the bypass we actually care about). This is what "doesn't lock out billing management" means at the DB layer.
- It **fails open if no subscription row resolves** (returns `NEW`): only service-role paths create/remove `subscriptions` rows (no client write policy, Q-RLS), so a missing row can never be attacker-induced, and we must never brick a tenant's operations over a billing-row gap.
- Caps are scoped to **creation count only**. The trigger raises `errcode = 'check_violation'` (`23514`) — which the offline outbox (ADR-0009) already classifies **permanent**, and the web maps to the upgrade message. Comp/raise a plan and the **next** insert sees the higher limit immediately (the trigger re-reads `plans` each call) — AC 32.

The **payment-state read-only gate** (past_due-after-grace / canceled → read-only) is enforced at the **app layer** by the resolver, **not** the DB, this phase. Rationale: tenant **isolation** remains fully DB-enforced by the unchanged RLS (the safety property the "defense in depth" rule protects); the read-only paywall is a softer **business** gate whose failure mode is "a lapsed tenant can still operate," not a cross-tenant leak. Retrofitting a status check into every operational `WITH CHECK` is exactly the broad, error-prone change ADR-0008/0009 avoid; a DB-level operational lockout on lapse is **deferred** (noted as a known gap, not a security gap).

### Decision Q4 — Status model + out-of-order handling: **a five-value enum mapped from Stripe; a `last_stripe_event_at` high-water mark discards older events; `customer.subscription.*` is authoritative for status/period**

`public.subscription_status` enum = `'trialing' | 'active' | 'past_due' | 'canceled' | 'incomplete'`. Stripe → ours mapping (computed in the edge function, passed to the RPC):

| Stripe subscription status | ours |
|---|---|
| `trialing` | `trialing` |
| `active` | `active` |
| `past_due`, `unpaid` | `past_due` |
| `canceled` | `canceled` |
| `incomplete`, `incomplete_expired`, `paused` | `incomplete` |

**Out-of-order safeguard (verified necessity):** Stripe **does not guarantee event order** — a `subscription.deleted` can arrive before `subscription.updated`. The `subscriptions` row carries a `last_stripe_event_at timestamptz` high-water mark. The write RPC applies the state change **only if the incoming event's `created` timestamp ≥ `last_stripe_event_at`**; an older event is recorded in `stripe_events` (deduped/processed) but **does not regress** the row — it returns `'stale'`. Source-of-truth split: **`customer.subscription.created|updated|deleted`** are authoritative for `status`, `current_period_end`, `plan` (via the price id), and `cancel_at_period_end`; **`checkout.session.completed`** binds `stripe_subscription_id` and is a belt-and-suspenders activation hint; **`invoice.payment_failed`** drives `past_due`. (We use the event payload + timestamp guard for test-mode; re-fetching the live object from the Stripe API on each event is noted as a future hardening.) (Source: Stripe — Receive events / ordering.)

### Decision Q5 — Currency / amount model: **a single platform charge currency (recommend EGP minor units = piastres) stored on `plans`, a SEPARATE axis from café operational money, never touching `@ps/core` pricing; tax/VAT + multi-currency deferred**

The platform charges tenants in **one** currency this phase — **recommended EGP** (tenants are Egyptian cafés), human-approved at the gate. The subscription amount lives on `plans` as `price_amount int` (**minor units**, e.g. piastres for EGP) + `price_currency text default 'egp'`. This is a **separate money axis** from the café's operational EGP piastres: both are integer minor units (never floats, §2.1), but the subscription amount is **platform → tenant** and **does not touch `@ps/core` pricing** (which prices café → customer sessions). The canonical billed price is the **Stripe Price object** (the `stripe_price_id`); `plans.price_amount/currency` is a **display mirror** for the in-app plan card/picker, explicitly not the billing source of truth (drift between the mirror and Stripe is informational only). Display reuses `formatEgp`/`toArabicDigits` (since EGP minor unit = piastre, the existing helper applies directly; a generalized minor-units formatter is a trivial wrapper if a non-EGP currency is ever chosen). **Deferred (noted, not solved):** Egyptian **VAT** on SaaS may require Stripe Tax later (no tax lines/computation this phase); **multi-currency** stays deferred (single currency now).

### Decision Q6 — Trial, grace & lifecycle: **app-side trial set at provision (no Stripe until Checkout); a `graceUntil = current_period_end + grace_days` window; lapse drives app-layer read-only, NEVER auto-suspend; billing page always reachable**

- **Trial is app-side.** At provision (Q8) the `subscriptions` row is created `status='trialing'`, `trial_end = now() + trial_days` (default **14**, from `platform_settings`), with **no** Stripe customer/subscription. Stripe is involved only once the owner clicks Subscribe (the customer is created **lazily** at first Checkout). After Checkout, Stripe is the source of truth.
- **Grace.** `past_due` → a grace window of **`grace_days` (default 7, `platform_settings`)**. The resolver computes `graceUntil = current_period_end + grace_days`. While `now ≤ graceUntil`: **full access** + a persistent warning banner. After `now > graceUntil`: **read-only** operational mode (view yes; start sessions / take orders no). `canceled` → read-only. A trial that expires unpaid (`trialing` && `now > trial_end`) → read-only. `incomplete` → read-only. In **every** gated state the **billing screen / Checkout / Portal remain reachable** — the resolver never marks the billing path blocked (AC 4, AC 28). Staff see a banner directing them to the owner.
- **Lifecycle interaction with Phase-7 suspend/reactivate (locked):** a billing lapse **does NOT auto-suspend** the tenant — `tenants.status` stays `'active'`. **Why:** suspension flips `is_active_member()` to false (ADR-0008), which would lock the owner out of **everything including the billing page** — violating "never trap an owner unable to pay." Lapse is therefore handled by the **app-layer read-only resolver** (billing always reachable), while **suspension stays a separate, deliberate super-admin action** (abuse/legal, the heavier hammer). Suspending a tenant **does not** pause/cancel its Stripe subscription this phase (a future enhancement could pause Stripe on suspend — deferred).

### Decision Q7 — Entitlements helper: **a pure `@ps/core/entitlements` resolver (plan + status + now → limits/features/read-only/grace); the DB cap trigger reads the same `plans` rows**

The decision logic is a **pure `@ps/core/entitlements`** module — no Supabase/React imports, **no `Date.now()` inside decisions** (the clock is an argument), >90% line coverage (AC 1–6, §2.4). It is reused by web (paywall + usage meters) and optionally mobile. The DB cap trigger (Q3) is the un-bypassable backstop reading the **same** `plans` limits, so the two layers cannot disagree. **Normative API surface (core-engineer builds exactly this):**

```ts
// packages/core/src/entitlements/
export type PlanKey = 'trial' | 'basic' | 'pro';
export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled' | 'incomplete';
export type CapResource = 'branch' | 'device' | 'staff';

export interface PlanLimits { maxBranches: number; maxDevices: number; maxStaff: number; }
export interface PlanFeatures { [flag: string]: boolean; }

export interface PlanDef { key: PlanKey; limits: PlanLimits; features: PlanFeatures; }

/** A snapshot of the tenant's subscriptions row (ISO strings; no Date objects). */
export interface SubscriptionSnapshot {
  status: SubscriptionStatus;
  planKey: PlanKey;
  comped: boolean;
  trialEnd: string | null;          // ISO
  currentPeriodEnd: string | null;  // ISO
  cancelAtPeriodEnd: boolean;
}

export interface EntitlementConfig { graceDays: number; }   // platform default, injected

export interface Entitlement {
  status: SubscriptionStatus;
  planKey: PlanKey;
  limits: PlanLimits;
  features: PlanFeatures;
  isReadOnly: boolean;              // operational writes gated (NOT the billing path)
  graceUntil: string | null;       // ISO; non-null only inside the past_due grace window
  trialEnd: string | null;
  // The billing/Checkout/Portal path is ALWAYS reachable — never represented as blocked.
}

/** Pure. `nowIso` is an ARGUMENT (no internal clock). comped overrides payment-state gating. */
export function resolveEntitlement(
  sub: SubscriptionSnapshot, plan: PlanDef, cfg: EntitlementConfig, nowIso: string,
): Entitlement;

export function computeGraceUntil(sub: SubscriptionSnapshot, graceDays: number): string | null;
/** True iff currentCount is strictly below the plan cap for that resource (UX pre-check). */
export function canCreate(ent: Entitlement, resource: CapResource, currentCount: number): boolean;
```

Resolver truth table (read-only = operational writes blocked; billing path never blocked):

| status | condition | isReadOnly | graceUntil |
|---|---|---|---|
| any | `comped === true` | `false` | `null` |
| `active` | — | `false` | `null` |
| `trialing` | `now ≤ trialEnd` | `false` | `null` |
| `trialing` | `now > trialEnd` | `true` | `null` |
| `past_due` | `now ≤ currentPeriodEnd + graceDays` | `false` | that timestamp |
| `past_due` | `now > currentPeriodEnd + graceDays` | `true` | `null` |
| `canceled` | — | `true` | `null` |
| `incomplete` | — | `true` | `null` |

### Decision Q8 — Provision integration: **extend `provision_tenant_atomic` to create the `trialing` subscription row at provision; lazy Stripe customer at first Checkout; the migration backfills existing tenants**

`provision_tenant_atomic` (ADR-0008) is replaced (forward-only `CREATE OR REPLACE`) to also insert the `subscriptions` row `status='trialing'`, `trial_end = now() + p_trial_days` (default 14), `ON CONFLICT (tenant_id) DO NOTHING` (idempotent) — inside the same atomic transaction as the tenant/member/audit writes. **No Stripe call at provision** — the Stripe customer is created lazily by `create-checkout-session` on first Subscribe (find-or-create, idempotent, stamping `stripe_customer_id` + `metadata.tenant_id`). The migration **backfills** every existing tenant lacking a subscription row as **`comped=true` on `pro`, `status='active'`** (grandfathered — no surprise lockout of tenants that predate billing; the human may re-tier at the gate).

### Decision Q9 — Manager/staff billing visibility: **owner-only for management; staff get read-only status for the banner, never Checkout/Portal/comp**

Billing **management** (Subscribe/Upgrade → Checkout, Manage → Portal, comp/override) is **owner-only**, DB-authoritatively enforced in the edge functions (the ADR-0008 `is_tenant_owner`/`is_platform_admin` guard). Managers/staff **may SELECT** their tenant's `subscriptions` row (RLS allows tenant staff read) so the paywall/grace banner can render for them — but the web denies them the management route and renders an "ask the owner" state with **no** Checkout/Portal controls (AC 29). No staff member gains any cross-tenant billing reach.

### Decision Q10 — `stripe_events` dedupe table: **`event_id` PK + type + resolved tenant + timestamps + small meta (no full payload); retain indefinitely this phase**

`public.stripe_events` (normative DDL below): `event_id text PRIMARY KEY` (the dedupe key), `type text`, `tenant_id uuid` (resolved server-side, nullable for unmappable), `received_at`/`processed_at timestamptz`, and a small `meta jsonb` (customer id, subscription id, resulting status — for forensics) — **not** the full event payload (Stripe's dashboard retains the raw events; storing payloads adds size with little marginal auditability). Retention is **indefinite** this phase (café-scale volume is tiny); a cleanup policy is deferred. RLS: **super-admin SELECT only**; **no client write** (only the service-role RPC writes it).

---

## Options considered (the load-bearing choices)

### Webhook → tenant mapping & no-JWT isolation (Decision Q2)
- **Option A — verify signature on raw body, map via OUR stored `stripe_customer_id`, SECURITY DEFINER write idempotent on `event.id` (CHOSEN).** Pros: forgery-proof (signature), tenant resolved by lookup not trust, structurally cannot cross tenants (`WHERE stripe_customer_id =`), replay-safe (dedupe key), the single audited no-JWT write path — the exact Phase-8 lesson. Cons: bypasses RLS (mitigated by the explicit-tenant + dedupe construction); requires `verify_jwt=false` (a public function, mitigated by the in-handler signature check). Evidence: [Stripe — Receive events](https://docs.stripe.com/webhooks); [Stripe — Signature verification](https://docs.stripe.com/webhooks/signature); [Supabase — Handling Stripe Webhooks](https://supabase.com/docs/guides/functions/examples/stripe-webhooks); [Supabase — Function Configuration (`verify_jwt`)](https://supabase.com/docs/guides/functions/function-configuration).
- **Option B — trust a `tenant_id` carried in the event/metadata.** Pros: one less lookup. Cons: the event body is **attacker-influenceable** in the threat model (and metadata can be set on objects we don't fully control); naming the victim tenant is exactly the leak we must prevent. Rejected — metadata is a **cross-check**, never the source. Evidence: [Stripe — Signature verification (only the signature is trustworthy)](https://docs.stripe.com/webhooks/signature).
- **Option C — RLS policy on the webhook write (no service-role).** Cons: the webhook has no user JWT, so `current_tenant_id()` is null and every tenant policy denies — there is no JWT to carry the claim. Not viable for a no-JWT caller. Evidence: [Supabase — Securing Edge Functions](https://supabase.com/docs/guides/functions/auth).

### Entitlement enforcement point (Decision Q3)
- **Option A — app resolver for UX + additive `BEFORE INSERT` cap trigger as the authoritative backstop, with the ADR-0008 context-skip (CHOSEN).** Pros: un-bypassable at the DB; additive (no policy change → no isolation regression); never blocks service-role/provision/comp/seed; fails open on missing subscription (no bricking). Cons: a trigger per capped table to review. Evidence: [PostgreSQL — BEFORE ROW triggers & CHECK errcode](https://www.postgresql.org/docs/current/plpgsql-trigger.html); [PostgreSQL — RLS (policies unchanged)](https://www.postgresql.org/docs/current/ddl-rowsecurity.html).
- **Option B — counting `WITH CHECK` in the RLS policy.** Cons: a row-counting subquery inside `WITH CHECK` is the subtle Phase-8 nested-guard hazard; it entangles caps with isolation and is hard to audit. Rejected.
- **Option C — app-layer only.** Cons: trivially bypassed by a direct PostgREST insert; fails AC 30's "cap holds even if the client is bypassed." Rejected as the sole line.

### Status / out-of-order model (Decision Q4)
- **Option A — enum mapped from Stripe + `last_stripe_event_at` high-water mark, discard older events (CHOSEN).** Pros: deterministic; cheap; no API round-trip; matches Stripe's "record last event time, discard earlier" guidance. Cons: relies on event `created` accuracy (acceptable; API-refetch is the future hardening). Evidence: [Stripe — Receive events (ordering not guaranteed)](https://docs.stripe.com/webhooks); [cashier-stripe #1201 (out-of-order in practice)](https://github.com/laravel/cashier-stripe/issues/1201).
- **Option B — refetch the subscription from the Stripe API on every event.** Pros: always-current, order-independent. Cons: an external call inside the webhook (latency, rate-limit, a second failure mode) for marginal gain at café scale. Deferred as hardening. Evidence: [Stripe — Process undelivered events](https://docs.stripe.com/webhooks/process-undelivered-events).

### Lapse → lifecycle interaction (Decision Q6)
- **Option A — lapse = app-layer read-only, billing always reachable; suspend stays separate (CHOSEN).** Pros: never traps an owner; reuses the resolver; keeps `tenants.status` semantics clean. Cons: operational lockout is not DB-enforced (a known, non-isolation gap). 
- **Option B — lapse auto-suspends the tenant.** Cons: `is_active_member()` would deny the billing page too — the owner cannot pay to recover. Rejected outright (violates AC 4/28).

---

## Forward-only migration (`supabase/migrations/0010_billing.sql`) — NORMATIVE

backend/supabase-migrate authors the file from this spec. **`security-reviewer` sign-off required (AC 7–12, 38–39).** Forward-only. It creates **three** tables (`plans`, `subscriptions`, `stripe_events` — RLS at birth), **one** status enum, the cap-enforcement trigger (additive), the SECURITY DEFINER write RPC (service-role-only, idempotent), the comp/override RPC, replaces `provision_tenant_atomic` to seed the trial subscription, and backfills existing tenants. It **alters no existing operational policy** and adds **no** `SECURITY DEFINER` on any tenant-visible read path.

```sql
-- =============================================================================
-- Migration 0010 — Phase 9 SaaS billing (Stripe subscriptions)
--
-- Forward-only. RLS-safe by construction:
--   * plans:         RLS enabled; authenticated READ (catalog, for the picker);
--                    NO client write (seeded by migration only).
--   * subscriptions: RLS enabled; tenant staff READ own + super-admin READ all
--                    (not impersonating); NO client write policy — the ONLY writes
--                    are via the service-role SECURITY DEFINER RPCs (webhook + comp).
--   * stripe_events: RLS enabled; super-admin READ only; NO client write.
--   * apply_stripe_subscription_event(): SECURITY DEFINER, service-role only,
--                    idempotent on event_id, resolves tenant from OUR stored
--                    stripe_customer_id (never the event), sets tenant_id EXPLICITLY,
--                    UPDATE ... WHERE stripe_customer_id = :customer (cannot cross tenants),
--                    out-of-order guard via last_stripe_event_at.
--   * enforce_plan_cap(): additive BEFORE INSERT trigger; skips service-role/seed
--                    contexts; fails open on missing subscription; alters NO policy.
--   * NO operational policy gains OR is_super_admin(); NO read-path SECURITY DEFINER.
--
-- SECURITY REVIEWER: required sign-off (AC 7–12, 38–39). Verify:
--   * subscriptions/stripe_events have NO client write policy (service-role only);
--   * apply_stripe_subscription_event cannot write into the wrong tenant;
--   * the cap trigger cannot be used to read/regress another tenant's state and
--     cannot brick a tenant (fails open on missing sub; skips service-role).
-- =============================================================================

-- ── 0. Status enum ───────────────────────────────────────────────────────────
create type public.subscription_status as enum
  ('trialing', 'active', 'past_due', 'canceled', 'incomplete');

-- ── 1. plans (DB-seeded catalog; the single source of truth for limits) ──────
create table public.plans (
  key             text primary key,
  name_key        text not null,                 -- i18n key (Arabic-first display)
  stripe_price_id text unique,                    -- NULL for trial; user-populated post-seed
  interval        text not null default 'month',
  max_branches    int  not null,
  max_devices     int  not null,                  -- per-tenant total this phase
  max_staff       int  not null,                  -- counts ALL tenant_members (incl. owner)
  price_amount    int,                            -- minor units (display mirror; Stripe is canonical)
  price_currency  text not null default 'egp',
  features        jsonb not null default '{}'::jsonb,
  sort_order      int  not null default 0,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create trigger set_plans_updated_at before update on public.plans
  for each row execute function public.set_updated_at();

alter table public.plans enable row level security;
-- Catalog is readable by any authenticated user (needed for the plan picker).
create policy plans_authenticated_read on public.plans
  for select using ((select auth.uid()) is not null);
-- INTENTIONALLY no write policy: plans are seeded/changed by migration only.

-- Seed the catalog. stripe_price_id left NULL — user populates per environment
-- (test now, live at cutover) via a super-admin/DBA UPDATE (see User-only actions).
insert into public.plans (key, name_key, max_branches, max_devices, max_staff,
                          price_amount, price_currency, sort_order) values
  ('trial', 'billing.plan.trial', 1,  5,  3,  null, 'egp', 0),
  ('basic', 'billing.plan.basic', 1, 10,  8,  null, 'egp', 1),
  ('pro',   'billing.plan.pro',   5, 50, 50,  null, 'egp', 2);

-- ── 2. subscriptions (one per tenant; NO client write) ───────────────────────
create table public.subscriptions (
  tenant_id              uuid primary key references public.tenants (id) on delete cascade,
  plan                   text not null references public.plans (key),
  status                 public.subscription_status not null default 'trialing',
  stripe_customer_id     text unique,             -- the authoritative reverse map
  stripe_subscription_id text unique,
  comped                 boolean not null default false,
  trial_end              timestamptz,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,
  last_stripe_event_at   timestamptz,             -- out-of-order high-water mark (Q4)
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create trigger set_subscriptions_updated_at before update on public.subscriptions
  for each row execute function public.set_updated_at();

create index subscriptions_plan_idx     on public.subscriptions (plan);
create index subscriptions_status_idx   on public.subscriptions (status);
-- stripe_customer_id already UNIQUE (indexed) — the webhook's reverse-map lookup.

alter table public.subscriptions enable row level security;

-- Tenant staff (owner/manager/staff) READ their own subscription (for the banner).
create policy subscriptions_member_select on public.subscriptions
  for select using (
    tenant_id = (select public.current_tenant_id())
    and (select public.is_tenant_staff())
  );

-- Super-admin READS all (portal), suppressed during impersonation (ADR-0008 pattern).
create policy subscriptions_super_select on public.subscriptions
  for select using (
    (select public.is_super_admin())
    and not (select public.is_impersonating())
  );

-- INTENTIONALLY no INSERT/UPDATE/DELETE policy: clients NEVER write subscription
-- state. The only writers are the service-role SECURITY DEFINER RPCs below
-- (webhook sync + super-admin comp/override) and provision_tenant_atomic.

-- ── 3. stripe_events (idempotency dedupe + forensics) ────────────────────────
create table public.stripe_events (
  event_id     text primary key,                  -- the dedupe key (Stripe event.id)
  type         text not null,
  tenant_id    uuid references public.tenants (id) on delete set null,
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  meta         jsonb not null default '{}'::jsonb -- customer/subscription id, status; NOT full payload
);
create index stripe_events_tenant_idx on public.stripe_events (tenant_id);

alter table public.stripe_events enable row level security;
-- Super-admin READ only (support/forensics); NO client write (service-role only).
create policy stripe_events_super_select on public.stripe_events
  for select using (
    (select public.is_super_admin())
    and not (select public.is_impersonating())
  );

-- ── 4. enforce_plan_cap() — additive BEFORE INSERT count-cap backstop (Q3) ───
-- SECURITY DEFINER so it can read subscriptions/plans for NEW.tenant_id.
-- Skips migration/seed/service-role contexts (ADR-0008 pattern) so provisioning,
-- backfill, comp, and seeds are NEVER blocked. Fails OPEN on a missing
-- subscription row (no bricking). Alters NO policy — purely rejects over-cap inserts.
create or replace function public.enforce_plan_cap()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  _claims text;
  _kind   text := tg_argv[0];      -- 'branches' | 'devices' | 'staff'
  _limit  int;
  _count  int;
begin
  -- (a) Skip non-end-user contexts (migration/seed/psql, and service_role).
  _claims := current_setting('request.jwt.claims', true);
  if coalesce(_claims, '') = '' then return new; end if;
  if (_claims::jsonb ->> 'role') = 'service_role' then return new; end if;

  -- (b) Resolve the tenant's effective plan limit. Fail OPEN if no sub row.
  select case _kind
           when 'branches' then p.max_branches
           when 'devices'  then p.max_devices
           when 'staff'    then p.max_staff
         end
    into _limit
  from public.subscriptions s
  join public.plans p on p.key = s.plan
  where s.tenant_id = new.tenant_id;

  if _limit is null then return new; end if;     -- no plan resolved → no cap

  -- (c) Count current ACTIVE rows for the tenant.
  if _kind = 'branches' then
    select count(*) into _count from public.branches
      where tenant_id = new.tenant_id and is_active;
  elsif _kind = 'devices' then
    select count(*) into _count from public.devices
      where tenant_id = new.tenant_id and is_active;
  elsif _kind = 'staff' then
    select count(*) into _count from public.tenant_members
      where tenant_id = new.tenant_id and is_active;
  end if;

  if _count >= _limit then
    raise exception 'plan limit reached for % (max %)', _kind, _limit
      using errcode = 'check_violation';          -- 23514 → app shows upgrade CTA
  end if;
  return new;
end;
$$;

drop trigger if exists branches_plan_cap on public.branches;
create trigger branches_plan_cap before insert on public.branches
  for each row execute function public.enforce_plan_cap('branches');

drop trigger if exists devices_plan_cap on public.devices;
create trigger devices_plan_cap before insert on public.devices
  for each row execute function public.enforce_plan_cap('devices');

drop trigger if exists tenant_members_plan_cap on public.tenant_members;
create trigger tenant_members_plan_cap before insert on public.tenant_members
  for each row execute function public.enforce_plan_cap('staff');

-- ── 5. apply_stripe_subscription_event() — the no-JWT webhook write (Q2/Q4) ──
-- SECURITY DEFINER, service-role only. Idempotent on event_id. Resolves tenant
-- from OUR stored stripe_customer_id (never the event). Sets tenant_id explicitly.
-- UPDATE ... WHERE stripe_customer_id = :customer → cannot touch another tenant.
-- Out-of-order guard: applies only if p_event_created >= last_stripe_event_at.
-- Returns: 'duplicate' | 'unmapped' | 'stale' | 'applied'.
create or replace function public.apply_stripe_subscription_event(
  p_event_id           text,
  p_event_type         text,
  p_event_created      timestamptz,
  p_customer_id        text,
  p_subscription_id    text,
  p_status             public.subscription_status,
  p_price_id           text,                       -- mapped to a plan via plans.stripe_price_id
  p_current_period_end timestamptz,
  p_trial_end          timestamptz,
  p_cancel_at_period_end boolean,
  p_amount             int,                         -- minor units, nullable
  p_currency           text                         -- nullable
)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  _inserted boolean;
  _tenant   uuid;
  _hwm      timestamptz;
  _plan     text;
  _action   text;
begin
  -- (a) Dedupe on event_id. If the row already existed, this is a replay → no-op.
  insert into public.stripe_events (event_id, type, meta)
  values (p_event_id, p_event_type,
          jsonb_build_object('customer', p_customer_id, 'subscription', p_subscription_id))
  on conflict (event_id) do nothing;
  get diagnostics _inserted = row_count;           -- 1 = new, 0 = duplicate
  if _inserted = 0 then
    return 'duplicate';
  end if;

  -- (b) Resolve tenant from OUR stored map — NEVER from the event body.
  select tenant_id into _tenant
  from public.subscriptions
  where stripe_customer_id = p_customer_id;

  if _tenant is null then
    update public.stripe_events set processed_at = now() where event_id = p_event_id;
    return 'unmapped';                              -- no row to write; recorded, no guess
  end if;

  -- (c) Out-of-order guard.
  select last_stripe_event_at into _hwm
  from public.subscriptions where tenant_id = _tenant;
  if _hwm is not null and p_event_created < _hwm then
    update public.stripe_events
      set tenant_id = _tenant, processed_at = now() where event_id = p_event_id;
    return 'stale';                                -- older event must not regress newer state
  end if;

  -- (d) Map the price id to a plan key (keep existing plan if unknown/absent).
  select key into _plan from public.plans where stripe_price_id = p_price_id;

  -- (e) Apply — WHERE stripe_customer_id pins the write to exactly this customer's row.
  update public.subscriptions s set
    status                 = p_status,
    plan                   = coalesce(_plan, s.plan),
    stripe_subscription_id = coalesce(p_subscription_id, s.stripe_subscription_id),
    current_period_end     = coalesce(p_current_period_end, s.current_period_end),
    trial_end              = coalesce(p_trial_end, s.trial_end),
    cancel_at_period_end   = coalesce(p_cancel_at_period_end, s.cancel_at_period_end),
    last_stripe_event_at   = p_event_created,
    updated_at             = now()
  where s.tenant_id = _tenant and s.stripe_customer_id = p_customer_id;

  -- (f) Audit (service-role/DEFINER bypasses RLS). Action from resulting status/type.
  _action := case
    when p_event_type = 'invoice.payment_failed'        then 'subscription.past_due'
    when p_status     = 'canceled'                       then 'subscription.canceled'
    when p_status     = 'past_due'                       then 'subscription.past_due'
    when p_status     = 'active'                         then 'subscription.activated'
    else 'subscription.updated'
  end;
  insert into public.audit_log (tenant_id, actor_id, action, entity, entity_id, amount, meta)
  values (_tenant, null, _action, 'subscriptions', null, p_amount,
          jsonb_build_object('stripe_event_id', p_event_id, 'type', p_event_type,
                             'status', p_status::text, 'currency', p_currency,
                             'system', true));

  update public.stripe_events
    set tenant_id = _tenant, processed_at = now() where event_id = p_event_id;
  return 'applied';
end;
$$;

revoke execute on function public.apply_stripe_subscription_event(
  text,text,timestamptz,text,text,public.subscription_status,text,timestamptz,timestamptz,boolean,int,text) from public;
revoke execute on function public.apply_stripe_subscription_event(
  text,text,timestamptz,text,text,public.subscription_status,text,timestamptz,timestamptz,boolean,int,text) from anon;
revoke execute on function public.apply_stripe_subscription_event(
  text,text,timestamptz,text,text,public.subscription_status,text,timestamptz,timestamptz,boolean,int,text) from authenticated;
grant  execute on function public.apply_stripe_subscription_event(
  text,text,timestamptz,text,text,public.subscription_status,text,timestamptz,timestamptz,boolean,int,text) to service_role;

-- ── 6. set_tenant_plan() — super-admin comp/override (service-role only) ──────
-- Called by the set-tenant-plan edge fn AFTER the is_platform_admin guard.
-- SECURITY DEFINER, service-role only, audited. comped=true bypasses Stripe billing.
create or replace function public.set_tenant_plan(
  p_tenant_id        uuid,
  p_plan             text,
  p_actor_id         uuid,
  p_reason           text,
  p_comped           boolean default true,
  p_trial_extension_days int default null
)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  update public.subscriptions s set
    plan      = p_plan,
    comped    = p_comped,
    status    = case when p_comped then 'active'::public.subscription_status else s.status end,
    trial_end = case when p_trial_extension_days is not null
                     then now() + make_interval(days => p_trial_extension_days)
                     else s.trial_end end,
    updated_at = now()
  where s.tenant_id = p_tenant_id;

  -- Audit FATAL inside the txn (ADR-0008 discipline): no silent comp.
  insert into public.audit_log (tenant_id, actor_id, action, entity, entity_id, meta)
  values (p_tenant_id, p_actor_id,
          case when p_comped then 'subscription.comp' else 'subscription.override' end,
          'subscriptions', null,
          jsonb_build_object('plan', p_plan, 'comped', p_comped, 'reason', p_reason,
                             'trial_extension_days', p_trial_extension_days));
end;
$$;

revoke execute on function public.set_tenant_plan(uuid,text,uuid,text,boolean,int) from public;
revoke execute on function public.set_tenant_plan(uuid,text,uuid,text,boolean,int) from anon;
revoke execute on function public.set_tenant_plan(uuid,text,uuid,text,boolean,int) from authenticated;
grant  execute on function public.set_tenant_plan(uuid,text,uuid,text,boolean,int) to service_role;

-- ── 7. Extend provision_tenant_atomic to seed the trial subscription (Q8) ────
-- Forward-only CREATE OR REPLACE. Adds the trialing subscription row inside the
-- same atomic txn. Existing callers pass the same args (p_trial_days defaulted).
create or replace function public.provision_tenant_atomic(
  p_tenant_id    uuid,
  p_tenant_name  text,
  p_owner_id     uuid,
  p_actor_id     uuid,
  p_owner_email  text    default null,
  p_is_new_user  boolean default false,
  p_trial_days   int     default 14
)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.tenants (id, name, status)
  values (p_tenant_id, p_tenant_name, 'active')
  on conflict (id) do nothing;

  -- Trial subscription row (app-side trial; no Stripe until first Checkout).
  insert into public.subscriptions (tenant_id, plan, status, trial_end)
  values (p_tenant_id, 'trial', 'trialing', now() + make_interval(days => p_trial_days))
  on conflict (tenant_id) do nothing;

  insert into public.tenant_members (tenant_id, profile_id, role, is_active)
  values (p_tenant_id, p_owner_id, 'owner', true)
  on conflict (tenant_id, profile_id) do nothing;

  insert into public.audit_log (tenant_id, actor_id, action, entity, entity_id, meta)
  values (p_tenant_id, p_actor_id, 'tenant.provision', 'tenants', p_tenant_id,
          jsonb_build_object('tenant_name', p_tenant_name,
                             'owner_user_id', p_owner_id::text,
                             'owner_email', coalesce(p_owner_email, ''),
                             'new_auth_user', p_is_new_user,
                             'trial_days', p_trial_days));
end;
$$;

revoke execute on function public.provision_tenant_atomic(uuid,text,uuid,uuid,text,boolean,int) from public;
revoke execute on function public.provision_tenant_atomic(uuid,text,uuid,uuid,text,boolean,int) from anon;
revoke execute on function public.provision_tenant_atomic(uuid,text,uuid,uuid,text,boolean,int) from authenticated;
grant  execute on function public.provision_tenant_atomic(uuid,text,uuid,uuid,text,boolean,int) to service_role;

-- ── 8. Backfill existing tenants (grandfathered comp 'pro' — no lockout) ─────
insert into public.subscriptions (tenant_id, plan, status, comped)
select t.id, 'pro', 'active', true
from public.tenants t
where not exists (select 1 from public.subscriptions s where s.tenant_id = t.id);

-- =============================================================================
-- END OF MIGRATION 0010
-- =============================================================================
```

**RLS-safety reasoning:** `subscriptions` and `stripe_events` ship with RLS enabled and **no client write policy** — every write is a service-role SECURITY DEFINER RPC, so a tenant can never INSERT/UPDATE/DELETE billing state (AC 9), and the SELECT policies confine reads to own-tenant (staff) or all-tenants (non-impersonating super-admin) exactly like the audited ADR-0008 pattern (AC 8, 10). `apply_stripe_subscription_event` derives the tenant from our stored `stripe_customer_id` and writes `WHERE stripe_customer_id = :customer`, so a webhook bug or a forged/replayed event **cannot** write into another tenant (AC 12, 16); the dedupe key makes replay a no-op (AC 15) and the high-water mark blocks regressions (AC 18). `enforce_plan_cap` is additive (no policy altered), skips service-role/seed contexts, and fails open on a missing subscription — it cannot regress isolation and cannot brick a tenant (AC 11, 30–32). No operational policy gained `OR is_super_admin()`; no tenant-visible read path uses `SECURITY DEFINER`. **Verify in `rls-tenant-audit` (AC 7–12, 18) and `security-reviewer` sign-off (AC 38–39).**

---

## Per-engineer hand-off

- **backend / supabase-migrate (REQUIRED this phase):** author `0010_billing.sql` **verbatim** from the normative SQL (three tables + RLS at birth; status enum; cap trigger; `apply_stripe_subscription_event` + `set_tenant_plan` SECURITY DEFINER service-role RPCs; `provision_tenant_atomic` replace; backfill). Build **four edge functions** on the ADR-0008 template (JWT identity → DB-authoritative guard → validate → RPC → audit; `jsonError`; service-role only):
  - `stripe-webhook` (`verify_jwt=false`): raw-body signature verify via `constructEventAsync` + `STRIPE_WEBHOOK_SIGNING_SECRET`; reject unverified (4xx); handle `checkout.session.completed`, `customer.subscription.created|updated|deleted`, `invoice.payment_failed`; map Stripe status → enum (Q4); call `apply_stripe_subscription_event`; return 2xx **only after** the RPC commits (so transient failure → non-2xx → Stripe retries).
  - `create-checkout-session` (owner-only): find-or-create the tenant's Stripe **customer** idempotently (stamp `metadata.tenant_id` + write `stripe_customer_id` to `subscriptions`), create a subscription-mode Checkout Session for the plan's `stripe_price_id`, return the **session URL** (no secret to client); audit `subscription.checkout_started`.
  - `create-portal-session` (owner-only): Billing Portal session for the tenant's `stripe_customer_id`; graceful failure if none yet.
  - `set-tenant-plan` (super-admin only, ADR-0008 `is_platform_admin` guard): call `set_tenant_plan`.
  - Keep **all** Stripe secrets in edge-function env only. **Get `security-reviewer` sign-off before merge; re-run `rls-tenant-audit`.**
- **core-engineer:** build `packages/core/src/entitlements/` to the **normative API** in Decision Q7 — `resolveEntitlement`/`computeGraceUntil`/`canCreate`, the truth table, `nowIso` as an argument (no internal clock), **pure** (no Supabase/React), re-export from the core root, **>90% line coverage**, extend `purity.test.ts` (AC 1–6).
- **web-engineer:** `/dashboard/billing` (owner-only management gate; current plan/status/trial-or-renewal date; usage-vs-limits meters from `product_stock_levels`-style counts + the resolver; Subscribe/Upgrade → `create-checkout-session`; Manage → `create-portal-session`; `past_due`/`canceled` paywall banners with always-reachable recovery; post-Checkout "finalizing" interim state). Plan-limit messaging: catch the `23514` cap rejection → upgrade CTA (AC 30). `/admin` subscriptions view (cross-tenant read via `subscriptions_super_select`) + comp/override dialog → `set-tenant-plan`. Roles/owner gate reuses the ADR-0008 fail-closed reader. Reuse `formatEgp`/`toArabicDigits`; **no Stripe secret in the bundle** (only the publishable key + server-minted URLs) (AC 20, 25–29, 33–35).
- **ux-designer:** the owner billing page, plan-picker, limit-reached dialog, `past_due`/`canceled` paywall banners (grace warning vs read-only lockout, "you can always pay" affordance, finalizing state), the super-admin subscriptions table + comp/override dialog, and the staff "ask the owner" state — fresh RTL/Arabic-first via `ui-ux-pro-max`; all strings via i18n; Arabic-Indic amounts/dates/counts.
- **security-reviewer (REQUIRED — release blocker):** owns Block C (webhook trust boundary — signature on raw body AC 13, idempotency on `event.id` AC 15, server-side customer→tenant mapping with explicit `tenant_id` write AC 12/16, out-of-order AC 18, no secret in client AC 20, service-role write is the only no-JWT path + audited), Block B (subscription/stripe_events isolation AC 8–12 + cap trigger does not regress isolation AC 11), and AC 38–39. Any cross-tenant billing read/write leak, an unverified-signature path, or a secret in the client bundle blocks the gate.
- **QA gates on:** Block B (isolation) + Block C (webhook signature + idempotency + correct mapping) as **hard gates**; Block A (entitlements) + Block F (caps) as functional/security gates; Block J (`ps-verify`, test-mode) as done. Critical set: **AC 8–18, 20, 24, 30, 38–39**.

## Consequences

- **Becomes easy:** the platform can take recurring revenue; owners self-serve via hosted Checkout/Portal; subscription state is a single webhook-synced source of truth that is replay-safe and out-of-order-safe; plan caps are un-bypassable (DB trigger) without entangling them in RLS; entitlement logic is pure and >90%-tested, reused by web (and optionally mobile); the no-JWT webhook write is structurally tenant-correct (lookup-not-trust + `WHERE stripe_customer_id`).
- **Becomes hard / accepted risk:** the webhook bypasses RLS — its correctness rests on the signature check + the customer→tenant lookup + the explicit-tenant write (the highest-value path to review; mitigated by construction + `rls-tenant-audit` + mandatory `security-reviewer` sign-off). The **operational read-only lapse gate is app-layer only** (a lapsed tenant could still be operated if the client is bypassed) — a known business gap, **not** an isolation gap (RLS isolation is unaffected); DB-level operational lockout is deferred. `plans.price_amount`/`stripe_price_id` can **drift** from Stripe (Stripe is canonical; the column is a display mirror). The webhook trusts the event payload's `created`/status (API-refetch deferred). Hosted Checkout/Portal localization is Stripe's, not our RTL (a UX limitation).
- **Follow-up / deferred:** API-refetch of the Stripe object per event (ordering robustness); DB-enforced operational lockout on lapse; Stripe Tax / Egyptian VAT; multi-currency; metered/seat billing, coupons, annual plans; per-branch device caps; in-app invoice history; pausing the Stripe subscription on tenant suspend; `stripe_events` retention/cleanup; live-mode cutover.
- **Must verify (Phase-9 gates):** `rls-tenant-audit` proves (1) an owner/manager/staff reads only their own `subscriptions` and **zero** foreign rows (AC 8); (2) no non-super-admin can INSERT/UPDATE/DELETE `subscriptions` (AC 9); (3) super-admin reads all subscriptions but has no standing cross-tenant write (AC 10); (4) the webhook RPC sets `tenant_id` explicitly and cannot write the wrong tenant, with replay a no-op and stale events ignored (AC 12, 15, 18); (5) the cap trigger holds against a direct PostgREST insert yet never blocks under-cap or service-role inserts (AC 30–32); (6) no secret/signing key in any client bundle (AC 20). `ps-verify` green (`tsc`, `jest` incl. >90% core entitlements, `next build`). **Sign-off:** `security-reviewer` on the webhook boundary + the `0010` migration (release blocker); human project owner at the Phase-9 gate (Q1/Q5 tiers+currency, Q2 webhook isolation, Q3 enforcement, Q6 grace/lapse).

## User-only actions (cannot be done by the CLI/agents — required before/at the gate)

1. **Create Stripe test-mode products + monthly prices** for `basic` and `pro`; then **populate `plans.stripe_price_id`** for those rows (a super-admin/DBA `UPDATE public.plans SET stripe_price_id=… WHERE key=…`) — price ids are environment-specific and intentionally not in the forward migration.
2. **Provide test-mode keys (never committed, `CLAUDE.md` §5):** `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SIGNING_SECRET` to the **edge-function** env; the **publishable** key to the **web** env.
3. **Register the webhook endpoint** (deployed `stripe-webhook` URL) in the Stripe dashboard for `checkout.session.completed`, `customer.subscription.created|updated|deleted`, `invoice.payment_failed` — or run the **Stripe CLI** forwarder for local verification. Confirm the function is deployed with **`verify_jwt=false`**.
4. **Configure the Customer Portal** (allowed actions: update card, cancel) in the Stripe dashboard.
5. **Confirm `platform_settings`** for `trial_days` (default 14) and `billing_grace_days` (default 7), and review the **backfill tier** (existing tenants grandfathered to comped `pro`) — re-tier if desired.
6. **Live-mode cutover (post-gate):** repeat 1–4 with live keys/prices/endpoint, set live env, verify a real test charge — an explicit human step, out of this phase's code scope.

## Sources

- Stripe — Receive Stripe events in your webhook endpoint (at-least-once delivery; ordering not guaranteed; return 2xx after persisting; idempotency on `event.id`): https://docs.stripe.com/webhooks
- Stripe — Resolve webhook signature verification errors (verify against the **raw** body; the signature is the only trustworthy part): https://docs.stripe.com/webhooks/signature
- Stripe — Process undelivered events / refetch current state (out-of-order robustness): https://docs.stripe.com/webhooks/process-undelivered-events
- Supabase — Handling Stripe Webhooks (`req.text()` raw body + `constructEventAsync`; signing secret in env): https://supabase.com/docs/guides/functions/examples/stripe-webhooks
- Supabase — Function Configuration (`verify_jwt = false` for public webhook functions): https://supabase.com/docs/guides/functions/function-configuration
- Supabase — Securing Edge Functions (`auth: 'none'`; verify the provider's own signature inside the handler): https://supabase.com/docs/guides/functions/auth
- laravel/cashier-stripe #1201 — out-of-order webhook delivery in practice (status regression): https://github.com/laravel/cashier-stripe/issues/1201
- PostgreSQL — Row Security Policies (multiple policies OR-combined; additive; per-user enforcement): https://www.postgresql.org/docs/current/ddl-rowsecurity.html
- PostgreSQL — Trigger procedures (BEFORE ROW triggers; raising with an errcode): https://www.postgresql.org/docs/current/plpgsql-trigger.html
- DEV — Stripe Webhook Security: signature verification, idempotency, local testing: https://dev.to/whoffagents/stripe-webhook-security-signature-verification-idempotency-and-local-testing-1lk3
</content>
</invoke>
