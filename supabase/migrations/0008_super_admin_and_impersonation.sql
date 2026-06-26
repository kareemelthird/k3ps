-- =============================================================================
-- Migration 0008 — Phase 7 super-admin platform ops + guarded impersonation
--
-- Forward-only. RLS-safe by construction:
--   * impersonation_sessions ships with RLS enabled + super-admin SELECT only;
--     NO client write policy (writes only via service-role edge functions).
--   * is_active_member() gains an impersonation branch that still PINS
--     current_tenant_id() (one tenant), requires a LIVE session row, and
--     requires the SIGNED impersonator_id claim to match — never a tenant bypass.
--   * super-admin cross-tenant reads are 4 ADDITIVE, SELECT-ONLY policies,
--     gated is_super_admin() AND NOT is_impersonating() (fail-closed; suppressed
--     while impersonating so an impersonator is confined to ONE tenant).
--   * NO operational policy gains OR is_super_admin(); NO SECURITY DEFINER read.
--
-- SECURITY REVIEWER: required sign-off (AC 9–15, 21, 25–29, 34, 36). Verify:
--   * is_active_member() impersonation branch cannot widen a normal user;
--   * super-admin read policies are SELECT-only and disappear under impersonation;
--   * audit_log trigger stamps impersonator_id from the signed claim only;
--   * no parameter/claim other than the signed app_metadata is trusted.
-- =============================================================================

-- ── 1. impersonation_sessions (the hook's source of truth + revocation/visibility)
--
-- Writes happen ONLY via service-role edge functions (impersonate-tenant /
-- end-impersonation). No client write policy is created — fail-closed by design.
-- The super-admin SELECT policy enables the portal's "who is impersonating now"
-- view and the historical impersonation audit list.
-- RLS is enabled at creation (ADR-0002 / CLAUDE.md §5 — no table without policies).
-- ──────────────────────────────────────────────────────────────────────────────
create table if not exists public.impersonation_sessions (
  id               uuid primary key default gen_random_uuid(),
  impersonator_id  uuid not null references public.profiles (id) on delete cascade,
  target_tenant_id uuid not null references public.tenants  (id) on delete cascade,
  -- Role granted to the impersonator for the target tenant.
  -- Constrained to the three operational roles (super_admin excluded for clarity).
  role             public.user_role not null default 'owner'
                     check (role in ('owner','manager','staff')),
  reason           text not null,
  started_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  ended_at         timestamptz,                       -- NULL = session is active
  created_at       timestamptz not null default now()
);

-- Fast "live session for this impersonator" lookup — used by hook + is_active_member().
-- Partial index on ended_at IS NULL keeps the index small (only live sessions).
create index if not exists impersonation_sessions_live_idx
  on public.impersonation_sessions (impersonator_id, expires_at)
  where ended_at is null;

-- Lookup by target tenant for the portal "who is impersonating this tenant?" view.
create index if not exists impersonation_sessions_target_idx
  on public.impersonation_sessions (target_tenant_id);

alter table public.impersonation_sessions enable row level security;

-- Super-admin may SELECT the active/historical list (portal visibility + audit).
-- Reading is allowed even while impersonating — this is platform metadata, not
-- tenant operational data — so is_impersonating() is deliberately NOT checked here.
create policy impersonation_sessions_super_select
  on public.impersonation_sessions
  for select
  using ((select public.is_super_admin()));

-- INTENTIONALLY no INSERT / UPDATE / DELETE policy: writes happen ONLY via the
-- service-role edge functions (impersonate-tenant / end-impersonation), which
-- bypass RLS. Any direct client write is denied (fail-closed).

-- ── 2. Claim helpers — read ONLY the signed app_metadata claim ─────────────
--
-- Both functions are SECURITY DEFINER + set search_path = public to prevent
-- search_path-injection exploits while still reading the signed JWT claim.
-- They return NULL when the claim is absent (fail-closed for callers).
-- ──────────────────────────────────────────────────────────────────────────────

create or replace function public.current_impersonator_id()
returns uuid
language sql stable security definer set search_path = public
as $$
  -- Returns the UUID of the platform operator currently impersonating this token.
  -- NULL means this is a regular user token (no impersonation in flight).
  select nullif(auth.jwt() -> 'app_metadata' ->> 'impersonator_id', '')::uuid;
$$;

create or replace function public.is_impersonating()
returns boolean
language sql stable security definer set search_path = public
as $$
  -- True iff the signed token carries an impersonator_id claim.
  -- Keyed on claim presence only (cheap, fail-closed): if impersonator_id is
  -- present the caller is operating under impersonation context and the
  -- super-admin cross-tenant read policies are suppressed (AC 13, Decision Q4).
  select (select public.current_impersonator_id()) is not null;
$$;

-- ── 3. is_active_member() — impersonation-aware replacement ──────────────────
--
-- This is the single highest-value isolation function: every operational policy
-- routes through it. The rewrite adds an impersonation branch that still PINS
-- current_tenant_id() (one tenant, from the signed claim) and additionally
-- requires a LIVE impersonation_sessions row with claim-matching impersonator_id.
--
-- Isolation guarantee (Decision Q1):
--   (a) normal branch: unchanged — a live tenant_members row for auth.uid() in
--       the active tenant, with the tenant status='active'.
--   (b) impersonation branch: a LIVE impersonation_sessions row where:
--         - target_tenant_id = current_tenant_id()  (PIN — one tenant, from claim)
--         - impersonator_id  = auth.uid()            (caller is the impersonator)
--         - impersonator_id  = current_impersonator_id() (SIGNED claim must agree)
--         - ended_at IS NULL                         (session not revoked)
--         - expires_at > now()                       (session not expired)
--         - tenant.status = 'active'                 (suspended tenants block access)
--
-- A normal user (no impersonator_id claim, no row) is entirely unaffected.
-- An impersonator is confined to exactly ONE active tenant for the live window,
-- with expiry/revocation enforced IN-POLICY (no JWT-TTL dependency — AC 27).
-- The role from the session row is stamped into app_metadata.roles by the hook,
-- so is_tenant_owner() / is_tenant_staff() resolve correctly via this gate.
-- ──────────────────────────────────────────────────────────────────────────────
create or replace function public.is_active_member()
returns boolean
language sql stable security definer set search_path = public
as $$
  select
    -- (a) Normal membership — unchanged from 0003.
    --     A live tenant_members row for the caller in their active tenant.
    exists (
      select 1
      from public.tenant_members m
      join public.tenants t on t.id = m.tenant_id
      where m.tenant_id  = (select public.current_tenant_id())
        and m.profile_id = (select auth.uid())
        and m.is_active  = true
        and t.status     = 'active'
    )
    -- (b) Live impersonation of EXACTLY the active (claim) tenant.
    --     Signed claim must match the table row; tenant must be active;
    --     session must not be ended or expired.
    or exists (
      select 1
      from public.impersonation_sessions i
      join public.tenants t on t.id = i.target_tenant_id
      where i.target_tenant_id = (select public.current_tenant_id())
        and i.impersonator_id  = (select auth.uid())
        and i.impersonator_id  = (select public.current_impersonator_id())
        and i.ended_at is null
        and i.expires_at > now()
        and t.status = 'active'
    );
$$;

-- current_role_in_tenant() / is_tenant_owner() / is_tenant_staff() are UNCHANGED:
-- during impersonation the hook stamps the session role into the scalar 'roles'
-- claim, so they resolve correctly via the (now impersonation-aware) member gate.

-- ── 4. Super-admin cross-tenant READ-ONLY policies (additive; fail-closed) ──
--
-- These are ADDITIVE policies (OR-combined with the per-tenant member policies by
-- PostgreSQL). The grep invariant holds: no OPERATIONAL policy gains OR
-- is_super_admin(). These are PLATFORM TENANCY READ policies, not operational ones.
--
-- The `not is_impersonating()` guard is ESSENTIAL (AC 13 / Decision Q4):
-- the impersonation claim retains is_super_admin=true (for banner + audit identity,
-- AC 21), so without this guard an impersonating super-admin could read every
-- tenant's data. Suppressing these policies while impersonating confines the
-- impersonator to exactly the target tenant. The target tenant's own rows are
-- still readable via the normal member/owner policies (e.g. audit_log_owner_select
-- with tenant_id=target, which is_active_member() now enables).
--
-- No super-admin WRITE policy is added. Super-admin has no standing cross-tenant
-- write; the only cross-tenant write path is impersonation.
-- ──────────────────────────────────────────────────────────────────────────────

-- Cross-tenant audit trail (spec §3.6 — the ratified read exception).
create policy audit_log_super_select on public.audit_log
  for select
  using (
    (select public.is_super_admin())
    and not (select public.is_impersonating())
  );

-- Member counts + tenant-detail member list.
create policy tenant_members_super_select on public.tenant_members
  for select
  using (
    (select public.is_super_admin())
    and not (select public.is_impersonating())
  );

-- Branch counts + tenant-detail branch list.
create policy branches_super_select on public.branches
  for select
  using (
    (select public.is_super_admin())
    and not (select public.is_impersonating())
  );

-- Member names/roles on tenant detail.
create policy profiles_super_select on public.profiles
  for select
  using (
    (select public.is_super_admin())
    and not (select public.is_impersonating())
  );

-- ── 5. Impersonator-stamping trigger on audit_log (AC 25) ────────────────────
--
-- Every audit_log row written during an impersonation window carries
-- meta.impersonator_id, by construction. This cannot be forgotten or bypassed —
-- the caller need not cooperate. The row's tenant_id is the impersonated tenant
-- (set by the caller's claim), and the trigger stamps the platform actor.
--
-- SECURITY REVIEW (Finding 3 — audit integrity):
-- When NOT impersonating, the trigger now STRIPS any client-supplied
-- meta.impersonator_id. Without this, a malicious regular user could craft an
-- audit_log INSERT with meta: {impersonator_id: <uuid>} and make their action
-- look like an impersonation event in the audit trail. Stripping it ensures
-- impersonator_id in meta is ALWAYS derived from the signed JWT claim, never
-- from the row payload the client controls.
--
-- SECURITY DEFINER is required because the function calls current_impersonator_id()
-- which reads auth.jwt(). Explicit search_path prevents search_path injection.
-- ──────────────────────────────────────────────────────────────────────────────
create or replace function public.stamp_impersonator()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  imp uuid;
begin
  imp := (select public.current_impersonator_id());
  if imp is not null then
    -- Impersonating: merge the SIGNED impersonator_id into meta.
    -- This stamps the platform actor on every audit row within the impersonation
    -- window. coalesce handles the (impossible given NOT NULL DEFAULT '{}') NULL.
    new.meta := coalesce(new.meta, '{}'::jsonb)
                || jsonb_build_object('impersonator_id', imp::text);
  else
    -- NOT impersonating: STRIP any client-supplied impersonator_id from meta.
    -- Prevents audit-log poisoning: a normal user cannot inject a fabricated
    -- impersonator_id claim into their own audit row to disguise their action
    -- as an impersonation event. The strip is unconditional and silent.
    new.meta := coalesce(new.meta, '{}'::jsonb) - 'impersonator_id';
  end if;
  return new;
end;
$$;

-- Drop before create to make this migration idempotent on repeated db reset.
drop trigger if exists audit_log_stamp_impersonator on public.audit_log;
create trigger audit_log_stamp_impersonator
  before insert on public.audit_log
  for each row execute function public.stamp_impersonator();

-- ── 6. Guard profiles.is_platform_admin against self-elevation ───────────────
--
-- SECURITY FIX (security-reviewer Finding 1): The profiles_self_update policy
-- in 0001 allows any authenticated user to UPDATE their own profile row and the
-- WITH CHECK only requires id = auth.uid() — no column guard. A user could set
-- is_platform_admin=true via the Supabase client, then call refreshSession() to
-- obtain a token with is_super_admin=true from the hook. This trigger closes the
-- gap by raising an exception whenever is_platform_admin changes in a
-- PostgREST/authenticated-user context.
--
-- IMPORTANT — seed.sql / migrations / direct SQL are NOT blocked:
-- The trigger fires for ALL connections (Postgres triggers are not bypassed by
-- the service-role key the way RLS policies are). Therefore the guard checks the
-- PostgREST request context before raising:
--
--   1. request.jwt.claims is '' (not set) → migration / seed.sql / psql → ALLOW.
--      PostgREST sets this GUC on every request; direct SQL connections never do.
--   2. JWT role claim = 'service_role' → service-role PostgREST call → ALLOW.
--      The edge functions (provision-tenant, etc.) use the service-role client;
--      their JWT carries role='service_role' and auth.uid()=NULL.
--   3. auth.uid() IS NULL → belt-and-suspenders for service-role → ALLOW.
--   4. All three conditions fail → authenticated end-user → BLOCK.
--
-- This ensures seed.sql's `on conflict do update set is_platform_admin=true`
-- (which becomes an UPDATE on the row created by handle_new_user) completes
-- successfully so that supabase db reset and the full pgTAP suite run.
--
-- Why SECURITY DEFINER: the check must be evaluated as the function owner (who can
-- read the old row), not the caller. Explicit search_path blocks injection.
-- ──────────────────────────────────────────────────────────────────────────────
create or replace function public.guard_is_platform_admin()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  _jwt_claims text;
begin
  -- Step 1: Skip when there is no PostgREST request context.
  -- Migration runners, seed.sql, and direct psql connections never set
  -- request.jwt.claims. current_setting with missing_ok=true returns '' in that
  -- case instead of raising an exception.
  _jwt_claims := current_setting('request.jwt.claims', true);
  if coalesce(_jwt_claims, '') = '' then
    -- No PostgREST context → migration / seed / direct SQL → allow.
    return new;
  end if;

  -- Step 2: Skip for service_role connections that reach via PostgREST.
  -- The service-role JWT carries role='service_role' (no user UUID in 'sub').
  if (_jwt_claims::jsonb ->> 'role') = 'service_role' then
    return new;
  end if;

  -- Step 3: Belt-and-suspenders — also skip when auth.uid() is null.
  if (select auth.uid()) is null then
    return new;
  end if;

  -- Step 4: Authenticated end-user — block is_platform_admin changes.
  if new.is_platform_admin <> old.is_platform_admin then
    raise exception
      'is_platform_admin may not be changed by authenticated users (permission denied)'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard_platform_admin on public.profiles;
create trigger profiles_guard_platform_admin
  before update on public.profiles
  for each row execute function public.guard_is_platform_admin();

-- ── 7. Harden audit_log_super_insert against cross-tenant injection during
--       impersonation (security-reviewer Finding 4) ───────────────────────────
--
-- The 0004 audit_log_super_insert policy allows any is_super_admin() caller to
-- INSERT audit rows into ANY tenant without a tenant_id constraint. During
-- impersonation the token still carries is_super_admin=true (by design — for the
-- banner and audit identity, AC 21). Without this guard a compromised super-admin
-- account operating under an impersonation claim could inject fabricated audit
-- entries into any tenant's ledger via the authenticated JS client.
--
-- Fix: drop the unconstrained 0004 policy and recreate it with:
--   (a) NOT is_impersonating() — while impersonating, all audit inserts from the
--       authenticated client must go through audit_log_staff_insert, which is
--       constrained to current_tenant_id() AND is_active_member(). The DB-level
--       impersonation branch in is_active_member() then pins writes to the one
--       live impersonated tenant. After end-impersonation (ended_at set), both
--       paths fail until the client calls refreshSession() — fail-closed.
--   (b) Service-role edge functions (impersonate-tenant, provision-tenant,
--       suspend-tenant, reactivate-tenant) use the service-role client, which
--       bypasses RLS entirely; they are unaffected by this policy change.
--
-- NOTE: this DROP targets the policy from 0004. Forward-only — 0004 is applied
-- first; this 0008 statement replaces its INSERT policy.
-- ──────────────────────────────────────────────────────────────────────────────
drop policy if exists audit_log_super_insert on public.audit_log;

create policy audit_log_super_insert on public.audit_log
  for insert
  with check (
    (select public.is_super_admin())
    and not (select public.is_impersonating())
  );

-- ── 8. Enforce at most one LIVE impersonation session per impersonator ─────────
--
-- SECURITY FIX (security-reviewer Finding 3): without this constraint a super-admin
-- (or compromised account) can INSERT multiple live sessions pointing to different
-- tenants. The hook takes the session with the highest expires_at; any remaining
-- sessions are "ghost sessions" that persist invisibly and reactivate the impersonation
-- on the next token refresh after the top session is ended.
--
-- The UNIQUE partial index (WHERE ended_at IS NULL) enforces DB-level uniqueness:
-- at most one row with ended_at IS NULL per impersonator_id. Combined with the
-- application-level "end-before-create" step in the impersonate-tenant edge function,
-- this prevents ghost sessions with defense in depth.
-- ──────────────────────────────────────────────────────────────────────────────
create unique index if not exists impersonation_sessions_one_live_per_impersonator
  on public.impersonation_sessions (impersonator_id)
  where ended_at is null;

-- ── 9. Fix tenants_member_select confinement (Finding 1) ─────────────────────
--
-- The 0004 tenants_member_select policy contains:
--   (select public.is_super_admin()) OR exists (tenant_members join ...)
-- An impersonating super-admin has is_super_admin()=true (preserved for banner
-- and audit identity, AC 21), so the OR branch grants them access to EVERY
-- tenant row — breaking the "confined to one tenant" invariant (AC 13).
--
-- Fix:
--   (a) DROP + recreate tenants_member_select as a member-only policy that uses
--       is_active_member() (which has the impersonation branch in 0008 §3).
--       For a regular member: id = current_tenant_id() AND is_active_member()
--       resolves to their own tenant only. For an impersonating super-admin:
--       id = current_tenant_id() (= target tenant) AND is_active_member()
--       (= true via impersonation branch) → exactly the target tenant row.
--   (b) ADD tenants_super_select for non-impersonating super-admins (portal
--       overview, same pattern as audit_log_super_select etc.).
--
-- tenants_super_insert and tenants_super_update (0004) are unchanged.
-- ──────────────────────────────────────────────────────────────────────────────

-- Drop the mixed-gate 0004 policy before recreating member-only.
-- Forward-only: 0004 is applied first; this 0008 statement replaces it.
drop policy if exists tenants_member_select on public.tenants;

create policy tenants_member_select on public.tenants
  for select
  using (
    -- Pin to the active tenant from the signed claim, then require active
    -- membership (normal branch) OR a live impersonation session for that
    -- tenant (impersonation branch of is_active_member()).
    id = (select public.current_tenant_id())
    and (select public.is_active_member())
  );

-- Super-admin (NOT impersonating) can read all tenant rows for the portal
-- overview. Matches the guard pattern of audit_log_super_select,
-- tenant_members_super_select, branches_super_select, profiles_super_select.
-- An impersonating super-admin gets is_impersonating()=true → policy false →
-- they fall through to tenants_member_select (above) which pins to one tenant.
create policy tenants_super_select on public.tenants
  for select
  using (
    (select public.is_super_admin())
    and not (select public.is_impersonating())
  );

-- ── 10. get_auth_user_id_by_email — provision-tenant helper ──────────────────
--
-- Lets the provision-tenant edge function (service-role) look up an existing
-- auth user by email without exposing auth.users through PostgREST.
-- SECURITY DEFINER so it can cross into the auth schema.
-- execute is REVOKED from all non-service-role principals — this function
-- must never be callable by authenticated clients or anonymous callers.
-- ──────────────────────────────────────────────────────────────────────────────
create or replace function public.get_auth_user_id_by_email(p_email text)
returns uuid
language sql stable security definer set search_path = auth, public
as $$
  select id from auth.users where email = lower(trim(p_email)) limit 1;
$$;

-- Revoke from all public roles; grant only to service_role.
-- (public includes anon + authenticated in Supabase default grants.)
revoke execute on function public.get_auth_user_id_by_email(text) from public;
revoke execute on function public.get_auth_user_id_by_email(text) from anon;
revoke execute on function public.get_auth_user_id_by_email(text) from authenticated;
grant  execute on function public.get_auth_user_id_by_email(text) to service_role;

-- ── 11. provision_tenant_atomic — atomic tenant onboarding RPC ───────────────
--
-- SHOULD-FIX (QA Finding): The provision-tenant edge function previously
-- performed tenant-insert, tenant_members-insert, and audit_log-insert as three
-- independent non-transactional service-role calls. A partial failure (e.g.
-- network error between step 2 and step 3) would leave an orphan tenant row
-- with no owner membership and no audit entry — an unrecoverable data-integrity
-- violation. The audit insert was also swallowed as non-fatal.
--
-- Fix: consolidate all three writes into one SECURITY DEFINER function that
-- runs in a single Postgres transaction. Properties:
--
--   * Atomic: all three writes commit or none do.
--   * Idempotent for the same p_tenant_id: tenant and member inserts use
--     ON CONFLICT DO NOTHING so a retry with the same UUID is a no-op.
--     The audit row is inserted on every call (each attempt is its own event).
--   * Audit-fatal: the audit INSERT is NOT wrapped in an exception handler.
--     If it fails (e.g. FK violation), the whole transaction rolls back — no
--     tenant without a corresponding audit trail.
--
-- Security:
--   * SECURITY DEFINER + set search_path = public: the function runs as its
--     owner (postgres) and can write to all three tables regardless of the
--     caller's RLS context.
--   * execute REVOKED from public, anon, authenticated; GRANTED only to
--     service_role. This function must never be callable by end-user clients.
-- ──────────────────────────────────────────────────────────────────────────────
create or replace function public.provision_tenant_atomic(
  p_tenant_id    uuid,
  p_tenant_name  text,
  p_owner_id     uuid,
  p_actor_id     uuid,
  p_owner_email  text    default null,
  p_is_new_user  boolean default false
)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  -- 1. Tenant row — idempotent: same UUID on retry is a no-op.
  insert into public.tenants (id, name, status)
  values (p_tenant_id, p_tenant_name, 'active')
  on conflict (id) do nothing;

  -- 2. Owner membership row — idempotent.
  insert into public.tenant_members (tenant_id, profile_id, role, is_active)
  values (p_tenant_id, p_owner_id, 'owner', true)
  on conflict (tenant_id, profile_id) do nothing;

  -- 3. Audit row — FATAL (no exception handler). If this fails (FK violation,
  --    constraint error, etc.) the entire transaction rolls back: no orphan
  --    tenant without an audit entry can exist.
  insert into public.audit_log
    (tenant_id, actor_id, action, entity, entity_id, meta)
  values (
    p_tenant_id,
    p_actor_id,
    'tenant.provision',
    'tenants',
    p_tenant_id,
    jsonb_build_object(
      'tenant_name',   p_tenant_name,
      'owner_user_id', p_owner_id::text,
      'owner_email',   coalesce(p_owner_email, ''),
      'new_auth_user', p_is_new_user
    )
  );
end;
$$;

-- Revoke from all public roles; grant only to service_role.
-- (public includes anon + authenticated in Supabase default grants.)
revoke execute on function public.provision_tenant_atomic(uuid, text, uuid, uuid, text, boolean) from public;
revoke execute on function public.provision_tenant_atomic(uuid, text, uuid, uuid, text, boolean) from anon;
revoke execute on function public.provision_tenant_atomic(uuid, text, uuid, uuid, text, boolean) from authenticated;
grant  execute on function public.provision_tenant_atomic(uuid, text, uuid, uuid, text, boolean) to service_role;

-- =============================================================================
-- END OF MIGRATION 0008
-- =============================================================================
