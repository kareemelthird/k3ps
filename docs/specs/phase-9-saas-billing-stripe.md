# Phase 9 — SaaS billing (Stripe subscriptions, trial → tiers, paywall, plan management)

> Surfaces: **backend + web** (`supabase`, `apps/web`). Optionally a small pure `@ps/core` entitlements helper (§7 Q7). **No mobile feature work** this phase (the counter app reads the resolved entitlement only if trivially shared; see §3 Out of scope). No new pricing/money math for café operations — this phase prices the **platform→tenant** subscription, a different money axis from the café's EGP cash.
> Anchors: [CLAUDE.md §2.1](../../CLAUDE.md) (money is integer minor units — Stripe charges in minor units too, but **subscription currency ≠ the café's internal EGP piastres**; flag the currency model, §7 Q5), [§2.5](../../CLAUDE.md) (RLS on every table), [§5](../../CLAUDE.md) (tenant identity from the signed JWT claim, **never** client input; no service-role/secret key in any client bundle; impersonation guarded+audited), [§2.7](../../CLAUDE.md) (auditable money actions), [§2.8](../../CLAUDE.md) (idempotent writes), [§2.6](../../CLAUDE.md) (Arabic-first RTL). Prior decisions reused: [ADR-0002](../adr/0002-tenant-isolation-model-ratified.md) (shared-DB + RLS), [ADR-0003](../adr/0003-auth-claim-and-impersonation-model.md) (scalar `tenant_id` claim; no RLS-bypass branch), [ADR-0008](../adr/0008-super-admin-and-impersonation.md) (super-admin platform-operations patterns: `is_platform_admin` authoritative guard, SECURITY DEFINER + service-role-only RPCs, cross-tenant **read** policies, audit taxonomy). New decisions land as **ADR-0010 (SaaS billing — subscriptions, entitlements, Stripe webhook isolation)**.
> Status: 🟡 needs spec → architect (ADR-0010) → build. **Money- and security-sensitive.** `security-reviewer` sign-off REQUIRED (webhook trust boundary + service-role no-JWT writes + entitlement gate). All work this phase is **Stripe test-mode**; the live-key cutover is an explicit human/user hand-off (§7, §8). The billing tables (`plans`, `subscriptions`, `stripe_events`) do **not** exist yet.

---

## 1. Problem & goal

PS-Managment is a multi-tenant platform with a full operational stack (Phases 2–8) and a super-admin portal (Phase 7) that can provision, suspend, reactivate, and impersonate tenants — but it has **no way to charge for itself**. There is no notion of a plan, a trial, a paid subscription, or a paywall. A provisioned café gets unlimited access forever; the super-admin manages lifecycle by hand with no billing state behind it. To become a business, the platform needs a **monetization layer**: each tenant subscribes to a plan (with feature limits), starts on a trial, converts to paid via Stripe, manages their card/cancellation themselves, and is gated when they don't pay — while the super-admin can see all subscriptions and comp/override a plan.

Phase 9 delivers that layer in **Stripe test-mode**: a plan/tier catalog with feature limits (branch / device / staff caps), a per-tenant `subscriptions` record (Stripe customer + subscription ids, plan, status, trial/period boundaries), the **trial → paid** flow via **Stripe Checkout** (owner subscribes) and the **Stripe Customer Portal** (owner manages card / cancels) — both reached only through **server-minted redirect URLs**, never a client-held secret — a **webhook edge function** that is the single source of truth syncing Stripe state into our DB (signature-verified, idempotent on Stripe `event.id`, service-role writes that map `stripe_customer_id → tenant_id` server-side), an **entitlement/paywall** layer that resolves a tenant's plan into allowed features/limits and gates the app on `past_due`/`canceled` (with a grace period and without ever locking an owner out of billing itself), and super-admin **plan management** (view all subscriptions; comp/override a tenant's plan). The win: the platform can take recurring revenue, owners self-serve their billing, and entitlement state is provable, audited, and tenant-isolated.

**Roles touched:** `owner` (subscribes, upgrades, manages card/cancel, sees their plan + limits + paywall) directly; `super_admin` (views all subscriptions, comps/overrides plans) directly; `manager`/`staff` only **negatively** — they may hit feature caps/paywall but never manage billing, and must gain no cross-tenant billing reach. Stripe itself is a new untrusted external actor whose only trusted channel is the **signature-verified webhook**.

---

## 2. Prior art (reuse — do not reinvent)

| Asset | Location | Phase-9 use |
|---|---|---|
| Super-admin guard pattern: authority from `profiles.is_platform_admin` via the **service-role client** (never `getUser().app_metadata`), fail-closed | `supabase/functions/provision-tenant/index.ts`, ADR-0008 | Every super-admin billing action (comp/override, view-all) reuses this exact guard. |
| SECURITY DEFINER + `execute` revoked from anon/authenticated, atomic multi-write RPC (`provision_tenant_atomic`), audit insert **fatal inside the txn** | `0008_*` migration, `provision-tenant` | The webhook→subscription write and the comp/override write are service-role-only SECURITY DEFINER RPCs with explicit guards (Phase-8 lesson: explicit tenant/role guard, don't rely on nested `is_tenant_staff()` in `WITH CHECK`). |
| Edge-function shape: JWT identity → DB-authoritative guard → validate body → atomic RPC → audit; `jsonError` helper; service-role only in functions, never client | `supabase/functions/*` | Template for `create-checkout-session`, `create-portal-session`, `stripe-webhook`, `set-tenant-plan`. |
| Tenant lifecycle (`provision`/`suspend`/`reactivate`) + `tenants.status` + `is_active_member()` immediate-effect gating | Phase 7, `0008_*` | Phase 9 maps billing status to lifecycle: how a `canceled`/`past_due` subscription interacts with `tenants.status` is §7 Q6. Reuse the immediate-effect gate model. |
| Super-admin cross-tenant **read** policy shape (`is_super_admin()`-gated SELECT only; no `OR is_super_admin()` on operational write policies) | ADR-0008, `0008_*` | Super-admin "view all subscriptions" uses the same narrow cross-tenant read policy/RPC shape. |
| `audit_log` (`tenant_id`, `actor_id`, `action`, `entity`, `entity_id`, `amount`, `meta`, `created_at`); impersonated rows stamp `impersonator_id` | `0002_*`, ADR-0008 | New billing actions write `audit_log` (taxonomy in §5). Webhook-driven writes record actor as the platform/system. |
| `platform_settings` (seeded; `impersonation_max_ttl_seconds`) | `0001_*` | Pattern for platform-level billing config (default trial length, grace days) if not put on `plans`. |
| `@ps/core` purity model + `formatEgp`/`toArabicDigits`; existing money helpers | `packages/core` | If an entitlements helper lands in core (§7 Q7) it follows the purity rules. Display of any subscription amount reuses `formatEgp`/Arabic-Indic per §2.6 (currency caveat §7 Q5). |
| Web auth + dashboard shell + RTL/Arabic-first design system; `/admin` super-admin portal | Phases 3, 6, 7 (`apps/web`) | Owner billing screens live under `/dashboard`; super-admin subscription view extends `/admin`. No new auth, no new design system. |
| Stripe signature-verify pattern: raw body via `.text()` + `constructEventAsync`, `verify_jwt = false` / `auth: 'none'` for the webhook, signing secret in env | Supabase + Stripe docs (cited §7 Q2) | The webhook function's verification contract. |

**Default stance:** match the Phase-7/8 edge-function + RLS + audit patterns, generalized for a billing axis. Stripe is the new external trust boundary; the webhook is the only path that turns Stripe state into our state, and it never trusts a client. Deltas are called out in §7.

---

## 3. Scope

### In scope

- **3.1 Plan / tier catalog (`plans`).** A small set of subscription tiers (e.g. `trial`, `basic`, `pro` — exact names = §7 Q1) each carrying: a display name (i18n key), a Stripe **price id** (test-mode), a recurring interval (monthly), and **feature limits** — at minimum `max_branches`, `max_devices` (per branch or per tenant — §7 Q3), `max_staff`, and an optional feature-flag set. Plans are seeded by migration; the `trial` plan needs no Stripe price. Plan limits are the single source of truth for entitlements.
- **3.2 Subscription record (`subscriptions`), one per tenant.** Columns at least: `tenant_id` (FK, unique — one active subscription per tenant), `plan` (FK/key into `plans`), `status` (enum: `trialing` | `active` | `past_due` | `canceled` | `incomplete` — final set §7 Q4), `stripe_customer_id`, `stripe_subscription_id`, `trial_end`, `current_period_end`, `cancel_at_period_end` (bool), `comped` (bool — super-admin override, no Stripe sub), timestamps. RLS: a tenant's owner/staff can **read** their own row; **no client write** (only service-role RPCs write it — webhook + comp/override). Created at provision time in `trialing` (trial mechanics = §7 Q8).
- **3.3 Trial → paid flow.** A newly provisioned tenant starts in a **trial** (status `trialing`, `trial_end` set). Before/at trial end the owner subscribes via Checkout. On successful payment the subscription becomes `active`. The transition is driven **only** by the webhook (never the browser success redirect — that's a UX hint, not a trust signal). What the app allows during trial vs after trial-expiry-without-payment is the paywall (§3.7).
- **3.4 Stripe Checkout (owner subscribes) — server-minted URL.** An owner-only edge function `create-checkout-session` that: verifies the caller is an active **owner** of the tenant (DB-authoritative), finds-or-creates the tenant's Stripe **customer** (idempotently, stamping `stripe_customer_id` + tenant metadata on the customer), creates a Checkout Session in **subscription** mode for the chosen plan's price, and returns the **session URL** for the browser to redirect to. The browser only ever receives a redirect URL and the **publishable** key context (if any) — never the secret key. Success/cancel return URLs land back in `/dashboard/billing`.
- **3.5 Stripe Customer Portal (owner manages card / cancels) — server-minted URL.** An owner-only edge function `create-portal-session` that creates a Billing Portal session for the tenant's existing `stripe_customer_id` and returns its URL. Card updates, plan changes, and cancellations happen in Stripe's hosted portal; the resulting state changes flow back **only** via the webhook (§3.6). Cancellation defaults to `cancel_at_period_end` (access until period end) unless §7 Q6 decides otherwise.
- **3.6 Webhook edge function (`stripe-webhook`) — the single sync path.** A public (no-JWT) function that: (a) **verifies the Stripe signature** against the raw request body using the webhook signing secret (server-only env) and rejects unverified requests; (b) is **idempotent on `event.id`** — records each handled event id in a `stripe_events` dedupe table and no-ops a replay; (c) handles at least `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, and `invoice.payment_failed`; (d) **maps `stripe_customer_id → tenant_id` server-side** (never from request body) and updates the tenant's `subscriptions` row (plan, status, `current_period_end`, `trial_end`, `cancel_at_period_end`) via a service-role SECURITY DEFINER RPC that sets `tenant_id` explicitly and is idempotent; (e) writes an `audit_log` row per applied change. Returns 2xx only after the state is durably applied (so Stripe's retry/backoff can recover a transient failure).
- **3.7 Entitlements & paywall.** A **resolver** that, given a tenant's subscription row + plan, produces the effective entitlement: `{ status, limits: {max_branches, max_devices, max_staff, ...}, features, isReadOnly, graceUntil }`. Enforcement:
  - **Limit caps** (branch/device/staff creation) are enforced when an owner/manager tries to create a resource beyond the plan cap — the create is rejected with a clear "upgrade your plan" message. The **enforcement point** (DB vs app vs both) and exactly how caps integrate with existing RLS without breaking it is **§7 Q3 (central architect call)**.
  - **Payment-state gating:** `trialing`/`active` → full access. `past_due` → a **grace period** (default N days, §7 Q6) with a persistent warning banner; after grace → **read-only** operational mode (can view, cannot start sessions/take orders). `canceled` → read-only. In **all** gated states the owner can **always reach the billing screen / Checkout / Portal** to recover (never lock the owner out of paying). Staff see a banner directing them to the owner.
- **3.8 Owner billing UI (`apps/web`, `/dashboard/billing`, owner-only).** Shows current plan, status (`trialing`/`active`/`past_due`/`canceled`), trial-end or next-renewal date, plan limits vs current usage (branches/devices/staff used of allowed), **Upgrade/Subscribe** (→ Checkout) and **Manage billing** (→ Portal) buttons, and the paywall banners for `past_due`/`canceled`. RTL, Arabic-first, Arabic-Indic numerals/dates. Manager/staff are denied this route (or see read-only status only — §7 Q9).
- **3.9 Super-admin plan management (`/admin`).** Super-admin can: view **all** tenants' subscriptions (plan, status, trial/period end, MRR-relevant fields — read-only list, cross-tenant read policy/RPC); and **comp/override** a tenant's plan (set a plan without Stripe, e.g. grant `pro` to a partner, or extend a trial) via an owner-independent service-role SECURITY DEFINER RPC, **audited** (`subscription.comp` / `subscription.override`). Comp sets `comped=true` and bypasses Stripe billing for that tenant.
- **3.10 Migration `0010_*` (forward-only).** Adds `plans`, `subscriptions`, `stripe_events` with **RLS enabled + explicit policies at birth** (no table ships without policies); seeds the plan catalog (test-mode price ids supplied by the user, §8); adds the billing SECURITY DEFINER RPCs (service-role-only); extends `rls-tenant-audit` pgTAP for the new tables. `security-reviewer` MUST sign off.
- **3.11 Stripe test-mode only.** All ACs are verified against Stripe **test-mode** keys/prices and the Stripe CLI webhook forwarder (or test events). The **live-mode** key/price/endpoint cutover is **out of scope as a code change** but documented as a user/human hand-off checklist (§8).

### Out of scope (later phases / deferred)

- **Sentry / EAS builds / performance budgets / formal a11y pass / full pen-test** (Phase 10).
- **Usage-based / metered billing**, seat-counted proration, add-ons, coupons/promo codes UI (future; only flat recurring tiers this phase).
- **Tax / VAT handling** beyond *noting* that Stripe Tax / Egyptian VAT may be needed later — no tax computation, no tax lines, no invoices-with-tax this phase (§7 Q5).
- **Multi-currency** beyond *noting* the currency decision (§7 Q5) — a single subscription currency this phase; the café's internal EGP money is unchanged and unrelated.
- **Invoice / receipt PDF access, dunning email customization, billing history table in-app** — Stripe's hosted Portal/emails cover this; in-app invoice browsing is out of scope unless trivially exposed via the Portal link.
- **Annual plans, multiple intervals, downgrade-proration UX nuance** — monthly only; plan changes flow through the Portal/Checkout and are reflected by the webhook.
- **Self-service plan-catalog editing UI** for super-admin (plans are seeded/changed by migration) and **self-service super-admin creation** (unchanged from Phase 7).
- **Mobile billing surface** — the counter app does not subscribe or show billing management; at most it respects the resolved read-only/cap state **iff** trivially shared from the existing entitlement read (not required this phase).
- **Dunning logic beyond reflecting `invoice.payment_failed` → `past_due`** (no custom retry schedules; Stripe Smart Retries handle retries).
- **GDPR/data-export on cancel, tenant data deletion** (unchanged deferral from Phase 7).

---

## 4. User stories

- **As a tenant owner, I want a free trial when my café is provisioned,** so that I can evaluate the platform before paying.
- **As a tenant owner, I want to subscribe to a plan with my card through a secure hosted checkout,** so that I can start paying without ever exposing my card to the app.
- **As a tenant owner, I want to manage my card, see my next charge, and cancel through a self-serve portal,** so that I control my billing without contacting support.
- **As a tenant owner, I want to see my current plan, its limits, and my usage against them,** so that I know when I need to upgrade.
- **As a tenant owner whose payment failed, I want a grace period and a clear path to fix my card before I'm locked out,** so that a transient card issue doesn't stop my café cold.
- **As a tenant owner, I want certainty that even when my subscription lapses I can still reach the billing page to pay,** so that I'm never trapped unable to recover.
- **As a super-admin, I want to see every tenant's subscription and status,** so that I can understand platform revenue health and support billing issues.
- **As a super-admin, I want to comp or override a tenant's plan (e.g. extend a trial, grant a partner plan),** so that I can run promotions and support edge cases without forcing a card.
- **As the platform, I want Stripe's state to be the source of truth synced only through a signature-verified, idempotent webhook,** so that subscription state cannot be forged or corrupted by a client or a replayed event.
- **As a tenant, I want certainty that another café cannot read or alter my billing,** so that I trust the platform with my subscription. (Negative story — enforced by RLS + the service-role-only webhook mapping, proven by tests.)
- **As a manager/staff member, I want a clear message (not a billing screen) when the café hits a plan cap or the subscription lapses,** so that I know to tell the owner. (Negative story — no staff billing reach.)

---

## 5. Domain notes (CLAUDE.md / ADR links)

- **§5 Tenancy & security (the central constraint):** the **Stripe secret key and webhook signing secret are server-only** (edge-function env), never in any client bundle; the browser uses only a server-minted Checkout/Portal **redirect URL** (and at most the publishable key). The webhook runs **without a user JWT** — so RLS is bypassed via the **service-role**, and correctness depends entirely on the function (a) verifying the Stripe signature, (b) mapping `stripe_customer_id → tenant_id` **server-side** from our own `subscriptions`/customer-metadata mapping (never trusting the event's claimed tenant), and (c) the SECURITY DEFINER write RPC setting `tenant_id` explicitly. This is the Phase-8 lesson applied: privileged no-JWT writes use SECURITY DEFINER with **explicit** tenant/role guards. The webhook→tenant mapping + isolation model is **§7 Q2**.
- **§2.8 Idempotent writes:** Stripe delivers events at-least-once and may retry for up to 3 days with backoff; events can arrive out of order. The webhook must be **idempotent on `event.id`** (a `stripe_events` dedupe table with a unique constraint) and must tolerate out-of-order delivery (use the event/object `created`/period fields to avoid regressing newer state with an older event). A replayed event produces no second effect and no duplicate audit row.
- **§2.1 / §2.7 Money & audit — two distinct money axes:** the café's operational money is **EGP integer piastres** (§2.1) and is **unchanged** by this phase. The subscription charge is a **separate** platform→tenant amount in Stripe's currency (minor units; currency decision §7 Q5). Both are integer-minor-unit and never floats. Every billing state change (subscribe, status change via webhook, comp/override, cancel) writes an `audit_log` row (§2.7). Proposed taxonomy: `subscription.checkout_started`, `subscription.activated`, `subscription.updated`, `subscription.past_due`, `subscription.canceled`, `subscription.comp`, `subscription.override`. Webhook-applied rows record the actor as platform/system + the Stripe `event.id` in `meta`; amounts (where present) are stored in minor units with the currency noted.
- **§2.6 Arabic-first / RTL:** all billing UI strings via i18n (plan names, statuses, paywall banners, buttons, dates) — no hardcoded strings; numerals/dates Arabic-Indic via `toArabicDigits`; layout RTL. Stripe's **hosted** Checkout/Portal are external (their localization is Stripe's; note that as a UX limitation, not an i18n failure). Amount display in-app reuses `formatEgp`-style formatting adapted to the subscription currency (§7 Q5).
- **§2.4 `@ps/core` purity:** if the entitlement resolver (plan + status → limits/flags/read-only/grace) lands in core (§7 Q7), it is **pure** — no Supabase/React imports, no `Date.now()` inside decisions (the "now" for grace/trial comparisons is passed in), >90% coverage. Otherwise it's a SQL/server helper. Either way it must be unit-testable in isolation.
- **ADR-0003 / ADR-0008 invariants preserved:** no `OR is_super_admin()` on any tenant operational write policy; the only cross-tenant reach added is a narrow super-admin **read** of subscriptions (for §3.9) and the comp/override **write** via an explicit service-role SECURITY DEFINER RPC. The webhook's service-role write is the only no-JWT write path and is justified + audited.

---

## 6. Acceptance criteria (numbered, testable Given/When/Then)

### Block A — Entitlements resolver (pure/testable; >90% if in `@ps/core`)

1. **Given** a tenant on plan `pro` with status `active`, **when** the entitlement resolver runs, **then** it returns that plan's limits (`max_branches`/`max_devices`/`max_staff`/features), `isReadOnly=false`, and no grace flag.
2. **Given** a subscription with status `trialing` and `trial_end` in the future, **when** resolved (with an injected "now" before `trial_end`), **then** access is full (`isReadOnly=false`) and the resolver reports trialing with the remaining time derivable from `trial_end`.
3. **Given** status `past_due` with `now` within the grace window, **when** resolved, **then** `isReadOnly=false` but a `graceUntil` is returned (banner state); **given** `now` after the grace window, **then** `isReadOnly=true`.
4. **Given** status `canceled`, **when** resolved, **then** `isReadOnly=true` and operational writes are disallowed, **but** the resolver never marks the billing/checkout path itself as blocked (the owner can always recover).
5. **Given** a `comped=true` subscription, **when** resolved, **then** entitlements come from the comped plan and no Stripe state is required (comp overrides payment state).
6. **Given** the resolver implementation, **when** tested, **then** "now" is an **argument** (no internal `Date.now()` in the decision), and — if it lives in `@ps/core` — the purity test passes and line coverage is **>90%** (CLAUDE.md §2.4/§4).

### Block B — Backend: schema, RLS & isolation (`rls-tenant-audit` pgTAP — BLOCKER if any fail)

7. **Given** the `0010_*` migration, **when** applied, **then** `plans`, `subscriptions`, and `stripe_events` exist with **RLS enabled** and explicit policies (no table ships without policies — §2.5), and the plan catalog is seeded.
8. **Given** an owner/manager/staff token for tenant A, **when** they SELECT `subscriptions`, **then** they see **only** tenant A's row and **zero** rows of tenant B.
9. **Given** any non-super-admin token, **when** it attempts to **INSERT/UPDATE/DELETE** `subscriptions` directly, **then** the write is **rejected by RLS** (clients never write subscription state; only service-role RPCs do).
10. **Given** a normal tenant token, **when** it attempts to read another tenant's `stripe_events` or `subscriptions`, **then** zero foreign rows are returned; **given** a `super_admin` token, **then** it can read subscriptions across all tenants via the explicit cross-tenant read policy/RPC (and **only** that read — no standing cross-tenant write).
11. **Given** a static scan of all migrations, **when** Phase-9 policies are reviewed, **then** no tenant operational policy gained an `OR is_super_admin()` / `OR true` / service-role escape, and the billing write RPCs are SECURITY DEFINER with `execute` revoked from anon/authenticated (service-role-only).
12. **Given** the subscription write RPC, **when** invoked, **then** it sets `tenant_id` **explicitly** (derived server-side, never from a client/event-supplied tenant id) and rejects/no-ops a mismatched mapping — proving a webhook bug cannot write into the wrong tenant.

### Block C — Backend: Stripe webhook (the trust boundary)

13. **Given** a request to `stripe-webhook` with an **invalid or missing** Stripe signature, **when** received, **then** it is rejected (4xx) and **no** subscription state is changed (signature verified against the raw body with the server-only signing secret).
14. **Given** a validly-signed `checkout.session.completed` for tenant A's customer, **when** processed, **then** tenant A's `subscriptions` row is updated to `active` (or `trialing`→`active`) with the correct `plan`, `stripe_subscription_id`, and `current_period_end`, and an `audit_log` row (`subscription.activated`) is written.
15. **Given** the **same** Stripe event delivered twice (same `event.id`), **when** processed both times, **then** the second is a **no-op** (recorded in `stripe_events`, deduped) — exactly one state change and exactly one audit row (idempotency on `event.id`).
16. **Given** `customer.subscription.updated` events (e.g. `cancel_at_period_end=true`, plan change, renewal), **when** processed, **then** the `subscriptions` row reflects the new `status`/`plan`/`current_period_end`/`cancel_at_period_end`, mapped via `stripe_customer_id → tenant_id` **server-side**.
17. **Given** `invoice.payment_failed`, **when** processed, **then** the subscription transitions to `past_due` and a `subscription.past_due` audit row is written; **given** `customer.subscription.deleted`, **then** status becomes `canceled` (`subscription.canceled` audited).
18. **Given** an out-of-order delivery (an older event arriving after a newer one already applied), **when** processed, **then** the handler does not regress newer state to older (ordering safeguard per §7 Q4).
19. **Given** the webhook applies state, **when** it returns, **then** it returns 2xx **only** after the change is durably committed (so a transient failure returns non-2xx and Stripe retries) — and a transient failure leaves no partial/duplicated state.
20. **Given** the webhook function config, **when** reviewed, **then** it runs **without** requiring a user JWT (`verify_jwt=false` / `auth:'none'`) yet performs its own Stripe-signature check, and the **secret key + signing secret appear only in edge-function env**, never in any client bundle.

### Block D — Backend: Checkout & Portal session minting (server-only)

21. **Given** an active **owner** of tenant A, **when** they invoke `create-checkout-session` for a valid plan, **then** the function (DB-authoritatively verifying owner role) finds-or-creates the tenant's Stripe customer, creates a subscription-mode Checkout Session, and returns a **session URL**; the response contains **no** secret key.
22. **Given** a non-owner (manager/staff) or a caller from a different tenant, **when** they invoke `create-checkout-session` for tenant A, **then** they receive 403 and no session is created.
23. **Given** an owner of a tenant **with** a Stripe customer, **when** they invoke `create-portal-session`, **then** a Billing Portal session URL is returned; **given** a tenant **without** a customer yet, **then** the call fails gracefully directing them to subscribe first.
24. **Given** the find-or-create customer path, **when** invoked twice, **then** it is idempotent — exactly one Stripe customer per tenant, with `stripe_customer_id` stamped on the `subscriptions` row and the tenant id recorded in the Stripe customer metadata (the basis for the webhook's reverse mapping).

### Block E — Web: owner billing UI

25. **Given** an owner on `/dashboard/billing`, **when** the page loads, **then** it shows the current plan, status, trial-end or next-renewal date, and plan limits vs current usage (branches/devices/staff used of allowed) — all RTL, Arabic-Indic.
26. **Given** an owner on a trial or wanting to upgrade, **when** they click **Subscribe/Upgrade**, **then** they are redirected to the Stripe Checkout URL minted server-side; on return to `/dashboard/billing` the page reflects the (webhook-synced) status (with an interim "finalizing" state acceptable until the webhook lands).
27. **Given** a subscribed owner, **when** they click **Manage billing**, **then** they are redirected to the Stripe Customer Portal URL minted server-side.
28. **Given** a tenant in `past_due` within grace, **when** an owner uses the app, **then** a persistent warning banner appears with a link to fix billing, but operational use continues; **given** grace has elapsed or status is `canceled`, **then** the app is read-only **except** the billing/checkout path remains reachable (the owner can always pay).
29. **Given** a manager/staff member, **when** they navigate to `/dashboard/billing`, **then** they are denied billing management (per §7 Q9: redirected or shown read-only status only) and never see Checkout/Portal controls.

### Block F — Web/backend: plan-limit enforcement

30. **Given** a tenant at its plan's `max_branches` (or `max_devices`/`max_staff`), **when** an owner/manager attempts to create one more, **then** the create is **rejected** with a clear "you've reached your plan limit — upgrade" message, and no resource is created (enforcement point per §7 Q3 — DB and/or app, but the cap must hold even if the client is bypassed).
31. **Given** a tenant **below** its cap, **when** a resource is created, **then** it succeeds normally (caps never block normal operation under the limit).
32. **Given** a super-admin comps/raises a tenant's plan, **when** the new limit applies, **then** the tenant can immediately create up to the new cap (entitlement reflects the comped plan).

### Block G — Web: super-admin plan management

33. **Given** a super-admin on `/admin`, **when** they open the subscriptions view, **then** all tenants' subscriptions are listed (plan, status, trial/period end), read-only, most-relevant first, with filter by status/plan.
34. **Given** a super-admin, **when** they comp/override a tenant's plan (with a reason), **then** the tenant's `subscriptions` row updates (`comped=true`, new plan), an `audit_log` row (`subscription.comp`/`subscription.override`, actor=super-admin, reason in meta) is written, and the tenant's entitlements reflect the change.
35. **Given** a non-super-admin caller, **when** they invoke the comp/override RPC or the view-all path directly, **then** they receive 403 and nothing is written/read cross-tenant.

### Block H — RTL / i18n

36. **Given** the billing UI (owner + super-admin), banners, buttons, statuses, and plan names, **when** rendered, **then** every user-facing string comes from i18n resources (Arabic-first) — no hardcoded strings (`rtl-i18n-check`).
37. **Given** amounts, dates, trial/renewal countdowns, and usage counts, **when** displayed, **then** numerals render Arabic-Indic and layout is RTL; subscription amounts use the agreed currency formatting (§7 Q5). (Stripe's hosted Checkout/Portal are external and exempt — noted as a UX limitation.)

### Block I — Security review (REQUIRED sign-off — release blocker)

38. **Given** the webhook trust boundary, **when** reviewed, **then** `security-reviewer` confirms: signature verification on raw body (AC 13), idempotency on `event.id` (AC 15), server-side `customer→tenant` mapping with explicit `tenant_id` write (AC 12, 16), no secret/signing key in any client bundle (AC 20), and the service-role write is the only no-JWT path and is audited.
39. **Given** tenant isolation, **when** reviewed, **then** `security-reviewer` confirms a tenant cannot read/write another tenant's billing (AC 8–12) and the super-admin cross-tenant reach is read-only + comp-override-via-RPC only (no operational-policy bypass) — `rls-tenant-audit` (Block B) passes (or "static pass — pending live verification" consistent with prior phases).

### Block J — Verification gate (definition of done)

40. **Given** the full change, **when** `ps-verify` runs, **then** `tsc --noEmit` across touched workspaces = 0 errors, `jest` passes (incl. the entitlements suite, >90% if in core), and `next build` succeeds; (`expo export` only if mobile was touched — not expected).
41. **Given** the phase closes in **test-mode**, **when** the gate summary is prepared, **then** it records that all ACs were verified against Stripe test keys/prices + test webhook events, and lists the **live-mode cutover** as an outstanding **user/human** hand-off (§8) — no live keys were committed (CLAUDE.md §5: secrets never committed).

---

## 7. Open questions (need ADR-0010 / design / human call)

**Architect (ADR-0010) — must decide before build:**

- **Q1 — Plan catalog shape & tiers.** How many tiers and their names/limits/prices (e.g. `trial` / `basic` / `pro`)? Are limits columns on `plans` or a JSONB `limits`/`features` blob? Is `plans` DB-seeded (recommended) with Stripe price ids injected via config, or fully config-driven? Confirm monthly-only interval this phase.
- **Q2 — Webhook → tenant mapping + isolation model (central security call).** How does the no-JWT webhook resolve `event → tenant_id` safely? Recommended: store `tenant_id` in **Stripe customer metadata** at customer-creation **and** keep `stripe_customer_id` on `subscriptions`, then map by our own stored `stripe_customer_id` (never trust event-supplied ids beyond looking them up). Specify the SECURITY DEFINER write RPC's signature + explicit guard, and confirm the service-role write is the **only** no-JWT write path. **Cite Supabase Stripe-webhook + Stripe webhook docs.**
- **Q3 — Entitlement enforcement point (central call).** Where are plan **limits** (branch/device/staff caps) enforced — app-layer only, DB-layer (trigger/policy counting rows against the plan cap), or both? How does a DB cap integrate with existing RLS **without breaking** Phase 2–8 policies (a `WITH CHECK` that counts rows is subtle — Phase-8 lesson about nested guards applies)? Is the resolver authoritative at the app layer with a DB backstop, or DB-authoritative? This is the riskiest interaction — pick the model and prove it doesn't regress isolation.
- **Q4 — Subscription status model + out-of-order handling.** Final `status` enum and the mapping from Stripe subscription statuses (`trialing`/`active`/`past_due`/`unpaid`/`canceled`/`incomplete`/`incomplete_expired`) to ours. How is out-of-order webhook delivery handled (compare `current_period_end`/event timestamps; don't regress)? Which events are the source of truth for status vs period boundaries?
- **Q5 — Currency / amount model for Stripe vs internal piastres.** What currency does the **platform** charge tenants in (EGP? USD?) and how is the subscription amount stored/displayed (minor units; reuse `formatEgp` or a generalized formatter)? Confirm this is a **separate** money axis from café EGP and does not touch `@ps/core` pricing. **Note** (don't solve) tax/VAT: does Egypt VAT on SaaS need Stripe Tax later? Multi-currency stays deferred.
- **Q6 — Trial & grace mechanics + lifecycle interaction.** Is the trial an **app-side** trial (status `trialing` + `trial_end` we set at provision, no Stripe involvement until they subscribe) or a **Stripe trial** (trial on the Checkout/subscription)? Recommendation: app-side trial pre-subscription, Stripe handles everything after Checkout. Define the **grace period** length for `past_due` (N days) and exactly what goes read-only. How does subscription `canceled`/`past_due` interact with `tenants.status` (Phase-7 suspend/reactivate) — does lapse auto-suspend, or is suspension a separate super-admin action? Does suspending a tenant pause/cancel its Stripe subscription?
- **Q7 — Entitlements helper location.** Pure `@ps/core/entitlements` (plan+status+now → limits/flags/read-only/grace, >90% tested) **vs** a SQL/server function. Recommendation: pure core resolver for the decision logic (testable, reused by web + optionally mobile), with the DB cap backstop (Q3) reading the same plan limits. Confirm.
- **Q8 — Provision integration.** Should `provision-tenant` (Phase 7) be extended to create the `subscriptions` row in `trialing` at provision time (and find-or-create the Stripe customer lazily at first Checkout, not at provision)? Confirm the provision→trial wiring and that an existing tenant with no subscription row is backfilled by the migration.
- **Q9 — Manager/staff billing visibility.** Are managers fully denied `/dashboard/billing`, or do they see **read-only** status (plan/limits) without Checkout/Portal controls? (Owner-only is the safe default; confirm.)
- **Q10 — Webhook event-replay / dedupe table retention.** `stripe_events` schema (event id PK, type, received_at, processed_at), retention/cleanup policy, and whether it also stores the raw payload for forensics (size vs auditability tradeoff).

**UX-designer — must design (fresh RTL/Arabic-first via `ui-ux-pro-max` + magic MCP):**

- The **owner billing page** (`/dashboard/billing`): current plan card, status + trial/renewal date, usage-vs-limits meters, Subscribe/Upgrade + Manage-billing actions, and the `past_due`/`canceled` **paywall banners** (grace warning vs read-only lockout) — including a clear "you can always pay to recover" affordance, and the post-Checkout "finalizing" interim state.
- The **upgrade/plan-picker** surface (choose a tier before Checkout) and the **limit-reached** message/dialog (cap hit → upgrade CTA).
- The **super-admin subscriptions view** (`/admin`): all-tenants table (plan/status/dates, filters) + the **comp/override** dialog (plan + reason).
- Loading / empty / error / denied states; the staff/manager "ask the owner" state.

**Human call:**

- Approve the **tier definitions, prices, and currency** (Q1, Q5) and the **grace-period length + lapse→read-only/suspend policy** (Q6) at the gate.
- Approve the **entitlement enforcement model** (Q3) and the **webhook isolation model** (Q2) — both security-sensitive.
- Confirm whether verification is test-mode-only this gate (yes by default) and that the **live-key cutover** (§8) is a separate, human-performed step.

---

## 8. Hand-off

- **Architect:** write **ADR-0010** resolving Q1–Q10; the central calls are the **webhook→tenant mapping + service-role isolation model (Q2)**, the **entitlement enforcement point + RLS interaction (Q3)**, the **status/out-of-order model (Q4)**, and the **trial/grace/lifecycle interaction (Q6)**. Author the `0010_*` migration plan (`plans`, `subscriptions`, `stripe_events` + RLS at birth + billing SECURITY DEFINER RPCs, service-role-only). No operational-policy may gain an `is_super_admin`/service-role bypass; the webhook write is the only justified no-JWT path and must be explicit + idempotent + audited.
- **Backend:** apply `0010_*`; build `stripe-webhook` (signature-verify on raw body, idempotent on `event.id` via `stripe_events`, server-side `customer→tenant` mapping, SECURITY DEFINER write RPC, audit per change, `verify_jwt=false`), `create-checkout-session` + `create-portal-session` (owner-only, DB-authoritative guard, find-or-create customer idempotently, server-minted URLs, no secret to client), `set-tenant-plan` (super-admin comp/override, audited); extend `provision-tenant` for the trial subscription row (Q8); keep all Stripe secrets in edge-function env only.
- **Core engineer (if Q7 elects core):** build `packages/core/src/entitlements/` — pure resolver (plan+status+now → limits/features/isReadOnly/grace), "now" as argument, **>90%** coverage, purity preserved (AC 1–6).
- **Web:** `/dashboard/billing` (owner-only gate; plan/status/usage; Subscribe→Checkout; Manage→Portal; paywall banners + always-reachable billing recovery; finalizing state); plan-limit enforcement messaging (AC 30); super-admin subscriptions view + comp/override dialog under `/admin`; reuse `formatEgp`/`toArabicDigits`; **no Stripe secret in the bundle** (AC 20).
- **UX-designer:** the billing page, plan-picker, limit-reached dialog, paywall banners, super-admin subscriptions table + comp dialog above (RTL/Arabic-first; loading/empty/error/denied/staff states).
- **security-reviewer (REQUIRED sign-off — release blocker):** owns Block C (webhook trust boundary), Block B (isolation), AC 12/16/20 (no-JWT service-role write maps tenant correctly + no secret leak), and AC 38–39. Any cross-tenant billing read/write leak, an unverified-signature path, or a secret in the client bundle blocks the gate.
- **QA gates on:** Block B (isolation) and Block C (webhook signature + idempotency + correct mapping) as the **hard gates**; Block A (entitlements) and Block F (limit caps) as functional/security gates; Block J (`ps-verify`, test-mode) as definition of done. Critical set: **AC 8–17, 20, 24, 30, 38–39.**
- **USER-only Stripe setup actions (cannot be done by agents — required before/at the gate):**
  1. Create the Stripe **test-mode** account/products and **price ids** for each tier; supply the price ids to the migration/config.
  2. Provide **test-mode** keys: `STRIPE_SECRET_KEY` (edge env), `STRIPE_WEBHOOK_SIGNING_SECRET` (edge env), and the **publishable** key (web env) — none committed (CLAUDE.md §5).
  3. Register the **webhook endpoint** (the deployed `stripe-webhook` URL) in the Stripe dashboard subscribed to `checkout.session.completed`, `customer.subscription.created|updated|deleted`, `invoice.payment_failed` — or run the **Stripe CLI** forwarder for local test verification.
  4. Configure the **Customer Portal** settings in the Stripe dashboard (allowed actions: update card, cancel).
  5. **Live-mode cutover (post-gate):** repeat 1–4 with live keys/prices/endpoint, set live env vars, and verify a real test charge — an explicit human step, out of this phase's code scope.
- **Gate summary (for the human):** what was built (billing schema + RLS, webhook sync, Checkout/Portal minting, entitlements + paywall, owner billing UI, super-admin plan management), test results (`ps-verify` + `rls-tenant-audit`, all **test-mode**), residual risks (live-key cutover outstanding; tax/VAT + multi-currency deferred; entitlement-enforcement model per Q3), and decisions needing approval (Q1/Q5 tiers+currency, Q2 webhook isolation, Q3 enforcement point, Q6 grace/lapse policy). **Never auto-approve.**
