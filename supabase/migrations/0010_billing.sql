-- =============================================================================
-- Migration 0010 — Phase 9 SaaS billing (Stripe subscriptions)
--
-- Forward-only. RLS-safe by construction:
--   * plans:         RLS enabled; authenticated READ (catalog, for the picker);
--                    NO client write (seeded by migration only).
--   * subscriptions: RLS enabled; tenant staff READ own + super-admin READ all
--                    (not impersonating); NO client write policy — the ONLY writes
--                    are via the service-role SECURITY DEFINER RPCs below.
--   * stripe_events: RLS enabled; super-admin READ only; NO client write.
--   * apply_stripe_subscription_event(): SECURITY DEFINER, service-role only,
--                    idempotent on event_id, resolves tenant from OUR stored
--                    stripe_customer_id (never the event), sets tenant_id EXPLICITLY,
--                    UPDATE ... WHERE stripe_customer_id = :customer (cannot cross tenants),
--                    out-of-order guard via last_stripe_event_at.
--   * enforce_plan_cap(): additive BEFORE INSERT trigger; skips service-role/seed
--                    contexts (ADR-0008 guard pattern); fails open on missing
--                    subscription; alters NO existing policy.
--   * NO operational policy gains OR is_super_admin().
--   * NO read-path SECURITY DEFINER.
--
-- SECURITY REVIEWER: required sign-off (AC 7-12, 38-39). Verify:
--   * subscriptions/stripe_events have NO client write policy (service-role only);
--   * apply_stripe_subscription_event cannot write into the wrong tenant;
--   * the cap trigger cannot regress isolation and cannot brick a tenant
--     (fails open on missing sub; skips service-role).
-- =============================================================================

-- ── 0. Status enum ───────────────────────────────────────────────────────────
-- CREATE TYPE does not support IF NOT EXISTS in PostgreSQL 15; use a DO block
-- so that repeated db reset (migration re-applied on a clean DB) is safe.
do $$ begin
  create type public.subscription_status as enum
    ('trialing', 'active', 'past_due', 'canceled', 'incomplete');
exception when duplicate_object then null;
end $$;

-- ── 1. plans (DB-seeded catalog; single source of truth for limits) ──────────
create table if not exists public.plans (
  key             text primary key,
  name_key        text not null,                  -- i18n key (Arabic-first display)
  stripe_price_id text unique,                     -- NULL for trial; user-populated post-seed
  interval        text not null default 'month',
  max_branches    int  not null,
  max_devices     int  not null,                   -- per-tenant total this phase
  max_staff       int  not null,                   -- counts ALL tenant_members (incl. owner)
  price_amount    int,                             -- minor units (display mirror; Stripe is canonical)
  price_currency  text not null default 'egp',
  features        jsonb not null default '{}'::jsonb,
  sort_order      int  not null default 0,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

drop trigger if exists set_plans_updated_at on public.plans;
create trigger set_plans_updated_at before update on public.plans
  for each row execute function public.set_updated_at();

alter table public.plans enable row level security;

drop policy if exists plans_authenticated_read on public.plans;
-- Catalog is readable by any authenticated user (needed for the plan picker UI).
create policy plans_authenticated_read on public.plans
  for select using ((select auth.uid()) is not null);
-- INTENTIONALLY no write policy: plans are seeded/changed by migration only.

-- Seed the catalog.
-- stripe_price_id is intentionally NULL — the user populates these per environment
-- (test-mode price IDs now, live price IDs at cutover).
-- See §User-only actions in ADR-0010. ON CONFLICT makes this idempotent on re-run.
insert into public.plans
  (key, name_key, max_branches, max_devices, max_staff, price_amount, price_currency, sort_order)
values
  ('trial', 'billing.plan.trial', 1,  5,  3,  null, 'egp', 0),
  ('basic', 'billing.plan.basic', 1, 10,  8,  null, 'egp', 1),
  ('pro',   'billing.plan.pro',   5, 50, 50,  null, 'egp', 2)
on conflict (key) do nothing;

-- ── 2. subscriptions (one per tenant; NO client write) ──────────────────────
create table if not exists public.subscriptions (
  tenant_id              uuid primary key references public.tenants (id) on delete cascade,
  plan                   text not null references public.plans (key),
  status                 public.subscription_status not null default 'trialing',
  stripe_customer_id     text unique,              -- the authoritative reverse map (Q2)
  stripe_subscription_id text unique,
  comped                 boolean not null default false,
  trial_end              timestamptz,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,
  last_stripe_event_at   timestamptz,              -- out-of-order high-water mark (Q4)
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

drop trigger if exists set_subscriptions_updated_at on public.subscriptions;
create trigger set_subscriptions_updated_at before update on public.subscriptions
  for each row execute function public.set_updated_at();

create index if not exists subscriptions_plan_idx   on public.subscriptions (plan);
create index if not exists subscriptions_status_idx on public.subscriptions (status);
-- stripe_customer_id UNIQUE constraint is auto-indexed — the webhook's reverse-map lookup.

alter table public.subscriptions enable row level security;

drop policy if exists subscriptions_member_select on public.subscriptions;
-- Tenant staff (owner/manager/staff) READ their own subscription (for the banner — Q9).
create policy subscriptions_member_select on public.subscriptions
  for select using (
    tenant_id = (select public.current_tenant_id())
    and (select public.is_tenant_staff())
  );

drop policy if exists subscriptions_super_select on public.subscriptions;
-- Super-admin READS all (portal). Suppressed during impersonation (ADR-0008 pattern):
-- is_impersonating() is the key guard that confines an impersonator to one tenant.
create policy subscriptions_super_select on public.subscriptions
  for select using (
    (select public.is_super_admin())
    and not (select public.is_impersonating())
  );

-- INTENTIONALLY no INSERT/UPDATE/DELETE policy: clients NEVER write subscription
-- state directly. The only writers are:
--   (a) provision_tenant_atomic (service-role, atomic txn);
--   (b) apply_stripe_subscription_event (service-role, webhook RPC);
--   (c) set_tenant_plan (service-role, super-admin comp/override RPC).
-- Any direct client write attempt raises 42501 (RLS with no policy = deny).

-- ── 3. stripe_events (idempotency dedupe + forensics) ────────────────────────
create table if not exists public.stripe_events (
  event_id     text primary key,                   -- dedupe key (Stripe event.id)
  type         text not null,
  tenant_id    uuid references public.tenants (id) on delete set null,
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  meta         jsonb not null default '{}'::jsonb   -- customer/sub id, status; NOT full payload
);

create index if not exists stripe_events_tenant_idx on public.stripe_events (tenant_id);

alter table public.stripe_events enable row level security;

drop policy if exists stripe_events_super_select on public.stripe_events;
-- Super-admin READ only (support/forensics); NO client write (service-role only).
create policy stripe_events_super_select on public.stripe_events
  for select using (
    (select public.is_super_admin())
    and not (select public.is_impersonating())
  );

-- ── 4. enforce_plan_cap() — additive BEFORE INSERT count-cap backstop (Q3) ──
--
-- SECURITY DEFINER so it can read subscriptions/plans for NEW.tenant_id.
-- Skips non-end-user contexts using the exact ADR-0008 guard:
--   (a) request.jwt.claims absent → migration/seed/psql → return NEW (no cap).
--   (b) JWT role = 'service_role' → service-role PostgREST → return NEW (no cap).
-- This ensures provision/backfill/comp/seed are NEVER blocked.
--
-- Fails OPEN on missing subscription row: a missing row cannot be attacker-induced
-- (only service-role paths write subscriptions), so no cap is better than bricking.
--
-- Alters NO existing policy — purely an additive BEFORE INSERT trigger.
-- errcode = 'check_violation' (23514) → classifyError → 'permanent' → upgrade CTA.
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
  -- (a) Skip when there is no PostgREST request context (migration/seed/psql).
  _claims := current_setting('request.jwt.claims', true);
  if coalesce(_claims, '') = '' then return new; end if;

  -- (b) Skip when the caller is the service_role (provision/comp/backfill).
  if (_claims::jsonb ->> 'role') = 'service_role' then return new; end if;

  -- (c) Resolve the tenant's effective plan limit.
  --     Fail OPEN (return NEW) if no subscription row resolves — never brick a tenant.
  select case _kind
           when 'branches' then p.max_branches
           when 'devices'  then p.max_devices
           when 'staff'    then p.max_staff
         end
    into _limit
  from public.subscriptions s
  join public.plans p on p.key = s.plan
  where s.tenant_id = new.tenant_id;

  if _limit is null then return new; end if;       -- no plan resolved → no cap applied

  -- (d) Count current ACTIVE rows for this tenant.
  if _kind = 'branches' then
    select count(*) into _count
      from public.branches where tenant_id = new.tenant_id and is_active;
  elsif _kind = 'devices' then
    select count(*) into _count
      from public.devices where tenant_id = new.tenant_id and is_active;
  elsif _kind = 'staff' then
    select count(*) into _count
      from public.tenant_members where tenant_id = new.tenant_id and is_active;
  end if;

  -- (e) Reject if at or over the limit.
  if _count >= _limit then
    raise exception 'plan limit reached for % (max %)', _kind, _limit
      using errcode = 'check_violation';            -- 23514 → permanent → upgrade CTA
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
--
-- SECURITY DEFINER, service-role only. Idempotent on event_id.
-- Resolves tenant from OUR stored stripe_customer_id — NEVER from the event body.
-- Sets tenant_id EXPLICITLY. UPDATE ... WHERE stripe_customer_id = :customer
-- → structurally impossible to touch a different tenant's row.
-- Out-of-order guard: applies state change only if p_event_created ≥ last_stripe_event_at.
--
-- Returns: 'duplicate' | 'unmapped' | 'stale' | 'applied'
-- The webhook must return 2xx ONLY after this function commits (non-2xx → Stripe retries).
create or replace function public.apply_stripe_subscription_event(
  p_event_id             text,
  p_event_type           text,
  p_event_created        timestamptz,
  p_customer_id          text,
  p_subscription_id      text,
  p_status               public.subscription_status,
  p_price_id             text,
  p_current_period_end   timestamptz,
  p_trial_end            timestamptz,
  p_cancel_at_period_end boolean,
  p_amount               int,
  p_currency             text
)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  _row_count integer;                              -- integer, not boolean (GET DIAGNOSTICS)
  _tenant    uuid;
  _hwm       timestamptz;
  _plan      text;
  _action    text;
begin
  -- (a) Dedupe on event_id. ON CONFLICT DO NOTHING → 0 rows = duplicate, 1 row = new.
  insert into public.stripe_events (event_id, type, meta)
  values (p_event_id, p_event_type,
          jsonb_build_object('customer', p_customer_id, 'subscription', p_subscription_id))
  on conflict (event_id) do nothing;
  get diagnostics _row_count = row_count;
  if _row_count = 0 then
    return 'duplicate';                            -- replay → no-op (idempotency on event_id)
  end if;

  -- (b) Resolve tenant from OUR stored map — NEVER from the event body or metadata.
  --     stripe_customer_id → tenant_id is the authoritative, server-controlled reverse map.
  select tenant_id into _tenant
  from public.subscriptions
  where stripe_customer_id = p_customer_id;

  if _tenant is null then
    -- Event for a customer we don't recognise. Record it, no-op — no guessing.
    update public.stripe_events set processed_at = now() where event_id = p_event_id;
    return 'unmapped';
  end if;

  -- (c) Out-of-order guard (Q4): discard events older than the high-water mark.
  --     Recorded in stripe_events so forensics can see them; subscription NOT regressed.
  select last_stripe_event_at into _hwm
  from public.subscriptions where tenant_id = _tenant;
  if _hwm is not null and p_event_created < _hwm then
    update public.stripe_events
      set tenant_id = _tenant, processed_at = now()
    where event_id = p_event_id;
    return 'stale';
  end if;

  -- (d) Map price_id to a plan key. Keep the existing plan if unknown or absent.
  select key into _plan from public.plans where stripe_price_id = p_price_id;

  -- (e) Apply the state change.
  --     WHERE stripe_customer_id = p_customer_id pins the write to exactly this
  --     customer's row. Combined with the tenant lookup above, it is STRUCTURALLY
  --     IMPOSSIBLE to touch a different tenant's subscription.
  update public.subscriptions s set
    status                 = p_status,
    plan                   = coalesce(_plan, s.plan),
    stripe_subscription_id = coalesce(p_subscription_id, s.stripe_subscription_id),
    current_period_end     = coalesce(p_current_period_end, s.current_period_end),
    trial_end              = coalesce(p_trial_end, s.trial_end),
    cancel_at_period_end   = coalesce(p_cancel_at_period_end, s.cancel_at_period_end),
    last_stripe_event_at   = p_event_created,
    updated_at             = now()
  where s.tenant_id = _tenant
    and s.stripe_customer_id = p_customer_id;     -- double-pin: tenant + customer

  -- (f) Audit — every billing state change is written (CLAUDE.md §2.7).
  --     SECURITY DEFINER bypasses RLS; audit insert is inside the same txn.
  _action := case
    when p_event_type = 'invoice.payment_failed' then 'subscription.past_due'
    when p_status = 'canceled'                   then 'subscription.canceled'
    when p_status = 'past_due'                   then 'subscription.past_due'
    when p_status = 'active'                     then 'subscription.activated'
    else 'subscription.updated'
  end;
  insert into public.audit_log (tenant_id, actor_id, action, entity, entity_id, amount, meta)
  values (_tenant, null, _action, 'subscriptions', null, p_amount,
          jsonb_build_object(
            'stripe_event_id', p_event_id,
            'type',            p_event_type,
            'status',          p_status::text,
            'currency',        p_currency,
            'system',          true));

  update public.stripe_events
    set tenant_id = _tenant, processed_at = now()
  where event_id = p_event_id;

  return 'applied';
end;
$$;

revoke execute on function public.apply_stripe_subscription_event(
  text,text,timestamptz,text,text,public.subscription_status,text,timestamptz,timestamptz,boolean,int,text)
  from public;
revoke execute on function public.apply_stripe_subscription_event(
  text,text,timestamptz,text,text,public.subscription_status,text,timestamptz,timestamptz,boolean,int,text)
  from anon;
revoke execute on function public.apply_stripe_subscription_event(
  text,text,timestamptz,text,text,public.subscription_status,text,timestamptz,timestamptz,boolean,int,text)
  from authenticated;
grant  execute on function public.apply_stripe_subscription_event(
  text,text,timestamptz,text,text,public.subscription_status,text,timestamptz,timestamptz,boolean,int,text)
  to service_role;

-- ── 6. set_tenant_plan() — super-admin comp/override (service-role only) ──────
--
-- Called by the set-tenant-plan edge function AFTER the is_platform_admin DB guard.
-- SECURITY DEFINER, service-role only. Audited — audit INSERT is fatal in the txn.
-- comped=true overrides the payment-state read-only gate (Q7 resolver truth table).
create or replace function public.set_tenant_plan(
  p_tenant_id            uuid,
  p_plan                 text,
  p_actor_id             uuid,
  p_reason               text,
  p_comped               boolean default true,
  p_trial_extension_days int     default null
)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  update public.subscriptions s set
    plan      = p_plan,
    comped    = p_comped,
    status    = case when p_comped
                     then 'active'::public.subscription_status
                     else s.status end,
    trial_end = case when p_trial_extension_days is not null
                     then now() + make_interval(days => p_trial_extension_days)
                     else s.trial_end end,
    updated_at = now()
  where s.tenant_id = p_tenant_id;

  -- Audit FATAL (ADR-0008 discipline): no silent comp.
  insert into public.audit_log (tenant_id, actor_id, action, entity, entity_id, meta)
  values (p_tenant_id, p_actor_id,
          case when p_comped then 'subscription.comp' else 'subscription.override' end,
          'subscriptions', null,
          jsonb_build_object(
            'plan',                  p_plan,
            'comped',                p_comped,
            'reason',                p_reason,
            'trial_extension_days',  p_trial_extension_days));
end;
$$;

revoke execute on function public.set_tenant_plan(uuid,text,uuid,text,boolean,int) from public;
revoke execute on function public.set_tenant_plan(uuid,text,uuid,text,boolean,int) from anon;
revoke execute on function public.set_tenant_plan(uuid,text,uuid,text,boolean,int) from authenticated;
grant  execute on function public.set_tenant_plan(uuid,text,uuid,text,boolean,int) to service_role;

-- ── 7. Replace provision_tenant_atomic with the 7-param version (adds p_trial_days)
--
-- Migration 0008 created provision_tenant_atomic with 6 params.
-- We need to:
--   (a) DROP the old 6-param signature (different signature = different function in PG).
--   (b) CREATE OR REPLACE the new 7-param version (p_trial_days int default 14).
-- The existing edge function (provision-tenant) does not pass p_trial_days; the
-- default of 14 is used. PostgREST resolves by name + named params — no ambiguity.
drop function if exists public.provision_tenant_atomic(uuid, text, uuid, uuid, text, boolean);

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
  -- Tenant row — idempotent: same UUID on retry is a no-op.
  insert into public.tenants (id, name, status)
  values (p_tenant_id, p_tenant_name, 'active')
  on conflict (id) do nothing;

  -- Trial subscription row (app-side trial; no Stripe until first Checkout — Q8).
  -- ON CONFLICT DO NOTHING: idempotent on the same tenant_id.
  insert into public.subscriptions (tenant_id, plan, status, trial_end)
  values (p_tenant_id, 'trial', 'trialing', now() + make_interval(days => p_trial_days))
  on conflict (tenant_id) do nothing;

  -- Owner membership row — idempotent.
  insert into public.tenant_members (tenant_id, profile_id, role, is_active)
  values (p_tenant_id, p_owner_id, 'owner', true)
  on conflict (tenant_id, profile_id) do nothing;

  -- Audit row — FATAL (no exception handler).
  -- If this fails the entire transaction rolls back: no orphan tenant without audit.
  insert into public.audit_log (tenant_id, actor_id, action, entity, entity_id, meta)
  values (p_tenant_id, p_actor_id, 'tenant.provision', 'tenants', p_tenant_id,
          jsonb_build_object(
            'tenant_name',   p_tenant_name,
            'owner_user_id', p_owner_id::text,
            'owner_email',   coalesce(p_owner_email, ''),
            'new_auth_user', p_is_new_user,
            'trial_days',    p_trial_days));
end;
$$;

revoke execute on function
  public.provision_tenant_atomic(uuid, text, uuid, uuid, text, boolean, int) from public;
revoke execute on function
  public.provision_tenant_atomic(uuid, text, uuid, uuid, text, boolean, int) from anon;
revoke execute on function
  public.provision_tenant_atomic(uuid, text, uuid, uuid, text, boolean, int) from authenticated;
grant  execute on function
  public.provision_tenant_atomic(uuid, text, uuid, uuid, text, boolean, int) to service_role;

-- ── 8. Backfill existing tenants (grandfathered comped 'pro' — no lockout) ───
--
-- Every tenant that existed before billing goes live is grandfathered as comped
-- 'pro' so they experience no disruption. The human may re-tier at the gate.
-- Runs as migration (no JWT → enforce_plan_cap skips; no client write policy risk).
insert into public.subscriptions (tenant_id, plan, status, comped)
select t.id, 'pro', 'active', true
from public.tenants t
where not exists (select 1 from public.subscriptions s where s.tenant_id = t.id);

-- Add billing defaults to platform_settings (trial_days and grace_days for the resolver).
insert into public.platform_settings (key, value) values
  ('billing.trial_days', '14'),
  ('billing.grace_days', '7')
on conflict (key) do nothing;

-- =============================================================================
-- END OF MIGRATION 0010
--
-- USER-ONLY ACTIONS required before the billing flow operates (see ADR-0010):
--   1. Create Stripe test-mode products + monthly prices for 'basic' and 'pro'.
--   2. UPDATE public.plans SET stripe_price_id='price_...' WHERE key='basic';
--      UPDATE public.plans SET stripe_price_id='price_...' WHERE key='pro';
--   3. Set edge-function env vars: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SIGNING_SECRET.
--   4. Set web env var: NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY.
--   5. Register the stripe-webhook URL in the Stripe dashboard for events:
--      checkout.session.completed, customer.subscription.created|updated|deleted,
--      invoice.payment_failed. Confirm verify_jwt=false (see config.toml).
--   6. Configure the Customer Portal (allowed actions) in the Stripe dashboard.
-- =============================================================================
