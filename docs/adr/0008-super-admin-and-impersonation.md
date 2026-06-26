# ADR-0008: Super-admin platform operations — cross-tenant read scope, the impersonation mint mechanism & session model, and the auth-hook/claim residuals

- **Status:** Accepted (Phase-7 design gate. **`security-reviewer` sign-off REQUIRED — release blocker** — on the whole `0008` migration, the impersonation-aware `is_active_member()`, the impersonation-mint path, the auth-hook rewrite, and the new super-admin cross-tenant read policies: spec Block C AC 9–15, AC 21, AC 25–29, AC 34, AC 36. The human project owner approves at the Phase-7 gate, including the cross-tenant audit-read exception scope (Q4) and the mint mechanism (Q2).)
- **Date:** 2026-06-25
- **Deciders:** architect (deciding — tenant-isolation authority) · `security-reviewer` (RLS / mint-path / hook / cross-tenant-read sign-off — **required**) · backend / supabase-migrate (authors `0008` + the edge functions + the hook from the normative SQL/contracts below) · web-engineer (the `/admin` portal + dual-layer gate + impersonation banner) · ux-designer (portal + banner) · product-manager (audit-read scope ratification) · human project owner (Phase-7 gate)
- **Builds on:** [ADR-0002 — isolation model](0002-tenant-isolation-model-ratified.md) (Accepted; shared-DB + `tenant_id` + RLS; the only tenant resolver is `current_tenant_id()` reading a signed `app_metadata` claim) · [ADR-0003 — auth claim & impersonation model](0003-auth-claim-and-impersonation-model.md) (scalar `tenant_id` claim; short-TTL + hook-on-refresh freshness; **Decision 3A** — `super_admin` is a platform flag, impersonation is a **server-minted, short-lived, audited token carrying the target `tenant_id` + `impersonator_id`, NO RLS-bypass branch**; the cross-tenant *analytics/audit-read* path was explicitly **deferred to its own ADR** — this one) · [ADR-0004 — schema scoping & keys](0004-tenant-schema-scoping-and-keys.md) · [ADR-0007 — reporting RLS read path](0007-reporting-aggregation-and-rls.md) (the `SECURITY INVOKER` / no-`SECURITY DEFINER`-on-the-read-path discipline; the grep-for-`OR is_super_admin()` invariant).
- **Reference:** `docs/specs/phase-7-super-admin-portal.md` §6 (acceptance criteria) / §7 (Q1–Q6) · `supabase/migrations/0001_tenancy_core.sql` (`tenants.status`, `tenant_members(tenant_id, profile_id, role, is_active)`, `profiles.is_platform_admin`, `platform_settings`) · `0002_operational_tables.sql` (`audit_log(tenant_id, branch_id, actor_id, action, entity, entity_id, amount, meta, created_at)`) · `0003_claim_helpers.sql` (`current_tenant_id()`, `current_role_in_tenant()`, `is_super_admin()`, `is_active_member()`, `is_tenant_owner()`, `is_tenant_staff()`, `auth_tenant_ids()`) · `0004_rls_policies.sql` · `supabase/functions/{custom-access-token-hook,provision-tenant,suspend-tenant,impersonate-tenant}/index.ts` · `CLAUDE.md` §5 (tenancy/security).

## Context

Phase 7 is the platform-operator surface. The plumbing is half-built and the spec (§1) names four gaps this ADR must close before build:

1. **Impersonation is not actually completed.** `impersonate-tenant/index.ts` only *returns metadata* (`impersonation_meta` + TTL) and never mints a usable session (its own comment admits "Full token minting requires Supabase Admin API"). Worse, a literal reading of ADR-0003 ("the impersonation token behaves exactly like a normal tenant user's token") collides with the real RLS: every operational policy gates on `is_active_member()` / `is_tenant_owner()` / `is_tenant_staff()`, **all of which resolve through `is_active_member()`**, which checks for a live `tenant_members` row for `auth.uid()`. A super-admin is **not** a member of the target tenant, so a token that merely carries `tenant_id=<target>` grants **zero** operational rows. The mint mechanism and the membership-resolution path must be decided together.
2. **No super-admin cross-tenant read.** The portal overview/detail/audit-view need to read across tenants, but `0004` only gives super-admin `tenants` SELECT/INSERT/UPDATE. There is no cross-tenant SELECT on `audit_log`, `tenant_members`, `branches`, or member `profiles`. ADR-0003 deferred exactly this "cross-tenant platform-analytics/audit read" to its own ADR — ratified here under tight scope.
3. **The hook is authored but not enabled.** Claims are still **static** `app_metadata` from the demo seed; they must become **dynamic** (sourced from `tenant_members`/`profiles`/impersonation state on every issuance incl. refresh), and the hook must **fail-closed on impersonation expiry** (AC 27).
4. **The `roles` claim shape is unreconciled.** Hook writes scalar text, `current_role_in_tenant()` reads scalar text, but web clients have treated `roles` as an array — a fail-**open** hazard.

**Hard constraints (`CLAUDE.md` §5; ADR-0002/0003):** tenant identity is the signed `app_metadata` claim only — never client input; RLS on every table with `WITH CHECK` on writes; **no `OR is_super_admin()` / `OR true` / service-role escape on any tenant operational policy**; no `SECURITY DEFINER` helper returns cross-tenant operational rows; every cross-tenant crossing is **explicit, time-boxed, audited**; the service-role key never reaches a client bundle; auditable money/actions (§2.7).

**Forces in tension:** completing impersonation so it *works* (the impersonator must actually see the tenant) vs. ADR-0003's "no bypass, one isolation surface"; giving super-admin a genuinely useful platform read vs. keeping the cross-tenant reach as narrow as possible; a Supabase auth stack that offers **no API to mint a per-session short-TTL access token with arbitrary signed claims for an existing user** (confirmed below) vs. the requirement that impersonation be short-lived, signed, and RLS-enforced; immediate revocation/expiry vs. the ~1h project-wide JWT TTL.

The six open questions (spec §7) are locked below.

---

## Decisions (Q1–Q6, locked)

### Decision Q2 (decided first — it drives Q1) — The impersonation mint mechanism: **the Custom Access Token Hook stamps the impersonated claim from a server-side `impersonation_sessions` row; there is no admin "mint-token-with-claims" call because Supabase has none**

**Evidence established (verified):** Supabase has **no** Admin/Management API that issues a session access token carrying *arbitrary custom claims* for an *existing* user. `auth.admin.generateLink({type:'magiclink'})` produces a link/OTP that logs you in **as that user** (it does not preserve the caller's identity and cannot attach an `impersonator_id`), and access-token TTL is a **project-wide** "JWT expiry limit" setting, **not** per-token. The **only** sanctioned place that injects signed `app_metadata` claims into a token is the **Custom Access Token Hook**, which runs **before every token issuance including `token_refresh`** (`authentication_method='token_refresh'`). Therefore the impersonated claim must be produced **by the hook**, and the hook needs a trusted server-side source of truth to know "user X is currently impersonating tenant Y." (Sources at end: Custom Access Token Hook; Token Security; admin-API discussion #11854; JWT expiry.)

**Mechanism (locked):**
1. The super-admin (logged in as **themselves** — `auth.uid()` stays the super-admin, preserving accountability) calls the `impersonate-tenant` edge function (service-role, guarded by the `is_super_admin` claim).
2. The function validates the target is `active`, clamps the TTL (Decision Q5), **INSERTs an `impersonation_sessions` row** (`impersonator_id=auth.uid()`, `target_tenant_id`, `role`, `reason`, `expires_at`), and writes `audit_log` `impersonation.start`.
3. The function returns success; the client calls `supabase.auth.refreshSession()`.
4. On that refresh, the hook finds the **live** `impersonation_sessions` row for `user_id` and stamps `app_metadata = { tenant_id:<target>, roles:<session role>, is_super_admin:true, impersonator_id:<super-admin>, impersonation_exp:<expires_at> }`. With no live row it stamps the **normal** claim. **The hook never preserves impersonation claims from prior `app_metadata`** (the current code's "preserve existing impersonation" branch is removed) — impersonation state is **derived fresh every issuance** from the table, so expiry/revocation are fail-closed by construction (AC 27).
5. RLS confines the impersonator to **exactly** the target tenant (Decision Q1's `is_active_member()` change + the existing `tenant_id = current_tenant_id()` predicate). No service-role key, no special token type, reaches the client — the browser holds a normal user session whose claims happen to point at the target tenant (AC 29).

**Why not the alternatives:** (a) *Admin "sign-in-as-user"* (`generateLink`) logs in as a real tenant member, **destroys** the super-admin's identity at the auth layer, has no built-in time-box or impersonator tag, and *still* needs a table for the hook to know to add `impersonator_id` — strictly worse on accountability and blast clarity. (b) *Service-role-signed custom JWT minted in the edge function* requires the edge function to hold/forge a token Supabase will accept and re-implement refresh/rotation — fragile, and a second signing surface to audit. The hook is the one blessed claim-injection point; routing through it keeps a single, already-reviewed mechanism.

### Decision Q1 — Impersonation session representation: **a dedicated `impersonation_sessions` table (NOT token-only)**

The spec biases "minimal / token-only," but Q2 makes the table **load-bearing, not optional**: the hook *requires* a trusted server-side source of truth to decide whether to stamp the impersonated claim, and persistent `app_metadata` is a strictly worse store (it can be left set after a crash, it is not naturally time-boxed, and it muddies the normal-claim path). The table also delivers everything token-only cannot: **immediate pre-expiry revocation** (set `ended_at`), **"who is impersonating what right now"** visibility for the portal, and an **in-policy liveness gate** that makes RLS fail-closed *without waiting for token refresh*. It ships with RLS at birth (`CLAUDE.md` §2.5).

`public.impersonation_sessions` (normative DDL below): `id`, `impersonator_id → profiles`, `target_tenant_id → tenants (on delete cascade)`, `role user_role default 'owner'`, `reason text`, `started_at`, `expires_at`, `ended_at` (NULL = active), `created_at`. RLS: **super-admin SELECT only**; **no client INSERT/UPDATE/DELETE policy** (writes happen only via the service-role edge functions, which bypass RLS) — fail-closed.

**The exact isolation guarantee (the crux):** `is_active_member()` is rewritten (`CREATE OR REPLACE`, forward-only) to return true under **either** branch:
- *normal* — a live `tenant_members` row for `auth.uid()` in `current_tenant_id()` with an `active` tenant (unchanged); **or**
- *impersonation* — a **live** `impersonation_sessions` row where `target_tenant_id = current_tenant_id()` **and** `impersonator_id = auth.uid()` **and** `impersonator_id = current_impersonator_id()` (the **signed** claim must agree) **and** `ended_at is null` **and** `expires_at > now()` **and** the tenant is `active`.

This change is **not** a tenant-bypass: the impersonation branch still pins `current_tenant_id()` (one tenant, from the signed claim), still requires the tenant `active`, and a normal user (no `impersonator_id` claim, no row) is entirely unaffected. The `role` from the session row is stamped into the same scalar `roles` claim, so `is_tenant_owner()` / `is_tenant_staff()` resolve unchanged. Because **every** operational policy routes through `is_active_member()`, this single helper edit enables impersonation across the whole schema while keeping ADR-0002's "one isolation surface." Crucially, the in-policy `expires_at > now()` / `ended_at is null` check means impersonation dies **immediately** on expiry or revocation **regardless of the ~1h JWT lifetime** — closing the "short window vs. long token" gap entirely (the JWT's own `exp` is irrelevant to the impersonation window; the table is authoritative).

### Decision Q4 — Super-admin cross-tenant read: **four narrow, additive, fail-closed SELECT-only policies, suppressed during impersonation**

Add **separate** (not `OR`-ed into existing member policies) SELECT policies, each gated by `(select public.is_super_admin()) and not (select public.is_impersonating())`:
- `audit_log_super_select` — the ratified cross-tenant audit trail (spec §3.6).
- `tenant_members_super_select` — member counts + tenant-detail member list.
- `branches_super_select` — branch counts + tenant-detail branch list.
- `profiles_super_select` — member names/roles on tenant detail.

`tenants` already carries `is_super_admin()` in `tenants_member_select` (existing, kept). **No new super-admin WRITE policy anywhere** — super-admin has **no standing cross-tenant write** (AC 12); the only cross-tenant write path is impersonation. These are **read-only**, granted **only** when the signed `is_super_admin` claim is true (a non-super-admin gets nothing — AC 10), and they are **additive** RLS policies (OR-combined with the per-tenant member policies), so the existing normal-tenant isolation is untouched and the grep invariant (no `OR is_super_admin()` on an *operational* policy; these are platform/tenancy *read* policies) holds (AC 14).

**The `not is_impersonating()` guard is essential:** the impersonation claim keeps `is_super_admin=true` (for the banner + audit identity, AC 21), so without this guard an impersonating super-admin could read **every** tenant's `audit_log` — violating AC 13 ("zero rows of tenant B"). Suppressing the super-admin read policies whenever an `impersonator_id` claim is present confines the impersonator to exactly the target tenant (their target's audit_log is still readable via the normal `audit_log_owner_select` path, since the impersonation role is `owner`). `is_impersonating()` keys on claim presence only (cheap, fail-closed).

We deliberately use **broad SELECT policies, not a `SECURITY DEFINER` RPC**, for counts/lists: a definer function returning cross-tenant rows is exactly the ADR-0003/0007 hazard. A `SECURITY INVOKER` policy-gated SELECT keeps RLS in force and is the simplest auditable shape. Cross-tenant **money/KPI analytics** remain out of scope (deferred to Phase 9, own ADR) — only the audit trail + tenancy metadata are exposed here.

### Decision Q3 — `roles` claim shape: **scalar text is canonical; every layer fails closed on any non-scalar/unknown shape**

Canonical: `app_metadata.roles` is a **single scalar string** ∈ `{'owner','manager','staff'}`, or `null`/absent. Hook (writes scalar — already correct) and `current_role_in_tenant()` (reads scalar — already correct) are confirmed canonical; **no DB change** is needed for the shape itself. The residual is the **web client**:
- The web reads `roles` with a guard that accepts **only** an exact match to one of the three literals; **anything else — an array, an unknown string, `null`, `undefined` — degrades to no role / least privilege** (denied), never escalates. A legacy array like `['owner']` therefore reads as "no role" → the user is gated out until their next token refresh re-stamps the scalar (fail-closed, AC 34).
- The DB is already fail-closed: `current_role_in_tenant()` on an array yields a non-matching text, so `is_tenant_owner()` (`= 'owner'`) is false. No escalation path exists DB-side.
- **Seed/static `app_metadata` migration:** once the hook is enabled, the next issuance overwrites stale claims, so array-shaped seeds self-heal within one TTL. To avoid a transient deny window, the operator should normalize any seeded `app_metadata.roles` arrays to scalar (or simply force a refresh) — listed as a **user action** (it touches `auth.users`, outside `public`; done via Admin API / DBA SQL, not a `public` migration).

### Decision Q5 — Hook deployment + enablement (dynamic claims + impersonation-expiry hardening)

The hook stays the **HTTP/edge** implementation already authored (`custom-access-token-hook`), rewritten per Decision Q2 to (a) source `tenant_id`/`roles`/`is_super_admin` **dynamically** from `tenant_members`/`profiles` every issuance, and (b) derive impersonation **freshly** from `impersonation_sessions` (drop on expiry/revocation — AC 27), writing **only** `app_metadata`, and **never** granting `is_super_admin` unless `profiles.is_platform_admin` is true (AC 36). *(A Postgres-function hook — `pg-functions://postgres/public/...` — is a viable simpler alternative that reads the tables in-DB without a service-role round-trip; not adopted now to avoid re-architecting the reviewed edge function, but noted for a future hardening pass.)*

**Enablement is partly CLI, partly a user-only action:**
- **CLI can:** `supabase functions deploy custom-access-token-hook`; set the hook's required secrets `supabase secrets set SUPABASE_SERVICE_ROLE_KEY=… SUPABASE_URL=…`; and, **for local**, enable it in `supabase/config.toml`:
  ```toml
  [auth.hook.custom_access_token]
  enabled = true
  uri = "https://<project-ref>.functions.supabase.co/custom-access-token-hook"   # or pg-functions://postgres/public/<fn> for the PG variant
  ```
  then `supabase stop && supabase start` (local) to apply.
- **User-only (hosted) actions:** enabling the hook on the **hosted** project is a **Dashboard toggle** (Authentication → Hooks → *Custom Access Token*) — the CLI `functions deploy` does **not** enable it as the token hook. The operator must also confirm the **JWT expiry limit** (access-token TTL) in Auth settings and provide the hook's secret. For the PG-function variant, the operator must additionally `grant execute on function public.<hook> to supabase_auth_admin;` and `grant usage on schema public to supabase_auth_admin;`.

**Verification posture (consistent with Phases 2–6):** on this machine the hook + RLS suite are **authored and statically audited**; live execution against hosted Supabase is **deferred to CI/hosted** — `security-reviewer`'s verdict here is **"static pass — pending live verification."** The human confirms at the gate whether hosted live-verification is in-scope for AC 38.

### Decision Q6 — Reactivate path & audit taxonomy: **a dedicated `reactivate-tenant` edge function (mirror of `suspend-tenant`)**

Add a dedicated `reactivate-tenant` function rather than overloading `suspend-tenant` into a generic status-setter — single-responsibility, guard parity (same `is_super_admin` check, same `reason` validation), and a clean distinct audit action. **Provisioning/suspension semantics (locked):**
- **Provision** (`provision-tenant`, unchanged): inserts `tenants(status='active')` + owner `tenant_members` + `audit_log` `tenant.provision`.
- **Suspend** (`suspend-tenant`, unchanged): sets `tenants.status='suspended'`; effect is **immediate** because `is_active_member()` joins `tenants` and requires `status='active'` — a suspended tenant's members fail the gate on their **next request**, independent of token freshness (no wait for expiry). Writes `tenant.suspend` (reason in `meta`). **Impersonation of a suspended tenant is rejected** (the edge function's active-check; AC 22) **and** would fail the `is_active_member()` impersonation branch anyway (defense in depth).
- **Reactivate** (`reactivate-tenant`, new): sets `tenants.status='active'`; members regain access on next request; writes `tenant.reactivate`.
- **Audit taxonomy (locked):** `tenant.provision` · `tenant.suspend` · `tenant.reactivate` · `impersonation.start` · `impersonation.stop`. All lifecycle/impersonation rows are written by the service-role edge functions (which carry `audit_log_super_insert`).

**Impersonator-stamping (AC 25), enforced by construction:** rather than trusting every app code-path to add `impersonator_id`, a **`BEFORE INSERT` trigger on `audit_log`** stamps `meta.impersonator_id = current_impersonator_id()` whenever the signed claim carries one. So **every** audited action during the window — session close, void, stock adjust, lifecycle — carries the impersonator id with no caller cooperation required, and the row's `tenant_id` is the impersonated tenant (it was written under the impersonation claim). This cannot be forgotten or bypassed.

---

## Options considered (the load-bearing choices)

### Impersonation mint mechanism (Decision Q2)
- **Option A — Hook stamps from an `impersonation_sessions` table (CHOSEN).** Pros: uses the one blessed claim-injection point (the hook, which runs on refresh); preserves the super-admin's `auth.uid()` (clean accountability); table gives immediate revocation, live "who's impersonating" visibility, and an in-policy expiry gate independent of JWT TTL; no new signing surface; no secret to the client. Cons: takes effect on the next refresh (sub-second client `refreshSession()`); requires the `is_active_member()` edit (reviewed once). Evidence: [Custom Access Token Hook](https://supabase.com/docs/guides/auth/auth-hooks/custom-access-token-hook); [Token Security & RLS](https://supabase.com/docs/guides/auth/oauth-server/token-security).
- **Option B — Admin "sign-in-as-user" via `generateLink`/OTP.** Pros: yields a real session with no helper change (the user *is* a member). Cons: logs in **as** a tenant member — destroys super-admin identity, no impersonator tag, no time-box; still needs a table for the hook to add `impersonator_id`; takes over a real human's account. Rejected. Evidence: [admin session discussion #11854](https://github.com/orgs/supabase/discussions/11854); [generateLink (admin-api)](https://supabase.com/docs/reference/javascript/admin-api).
- **Option C — Edge function mints a service-role-signed custom JWT.** Pros: full control of TTL/claims in one place. Cons: a second token-signing/forging surface Supabase refresh must accept; re-implements rotation; high blast-radius if the signing path errs; harder to audit than the single hook. Rejected. Evidence: access-token TTL is a project-wide setting, not per-token — [JWT expiry / token security](https://supabase.com/docs/guides/auth/oauth-server/token-security).

### Impersonation session representation (Decision Q1)
- **Option A — `impersonation_sessions` table (CHOSEN).** Pros: required by the chosen mint mechanism; immediate revocation; active-session visibility; in-policy liveness gate (fail-closed without refresh). Cons: one new table (+RLS). Evidence: RLS-everywhere (`CLAUDE.md` §5); [Postgres RLS](https://www.postgresql.org/docs/current/ddl-rowsecurity.html).
- **Option B — Token-only (rely on `impersonation_exp` + `audit_log`).** Pros: minimal. Cons: gives the hook no source of truth (so it can't decide to stamp), no pre-expiry revocation, no "who's impersonating now," and either pollutes persistent `app_metadata` or can't enforce the window in-policy. Rejected once Q2 was decided.

### Super-admin cross-tenant read (Decision Q4)
- **Option A — narrow additive SELECT-only policies gated `is_super_admin() AND NOT is_impersonating()` (CHOSEN).** Pros: RLS stays in force; fail-closed; additive (no change to member policies); easy to grep/audit; suppressed during impersonation so AC 13 holds. Cons: four policies to review. Evidence: [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security); ADR-0007 Decision 1.
- **Option B — `SECURITY DEFINER` RPC returning cross-tenant counts/lists.** Pros: one function. Cons: a definer returning cross-tenant rows is the exact ADR-0003/0007 leak vector. Rejected. Evidence: [RLS footguns — SECURITY DEFINER bypass](https://www.bytebase.com/blog/postgres-row-level-security-footguns/).

---

## Forward-only migration (`supabase/migrations/0008_super_admin_and_impersonation.sql`) — NORMATIVE

backend/supabase-migrate authors the file from this spec. **`security-reviewer` sign-off required.** It creates **one** table (`impersonation_sessions`, RLS at birth), adds **two** claim helpers, **replaces** `is_active_member()` (impersonation-aware), adds **four** super-admin read-only policies, and adds the `audit_log` impersonator-stamping trigger. It **alters no operational write policy** and adds **no** `SECURITY DEFINER` on any read path.

```sql
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
create table public.impersonation_sessions (
  id               uuid primary key default gen_random_uuid(),
  impersonator_id  uuid not null references public.profiles (id) on delete cascade,
  target_tenant_id uuid not null references public.tenants  (id) on delete cascade,
  role             public.user_role not null default 'owner'
                     check (role in ('owner','manager','staff')),
  reason           text not null,
  started_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  ended_at         timestamptz,                       -- null = active
  created_at       timestamptz not null default now()
);

-- Fast "live session for this impersonator" lookup (hook + is_active_member()).
create index impersonation_sessions_live_idx
  on public.impersonation_sessions (impersonator_id, expires_at)
  where ended_at is null;
create index impersonation_sessions_target_idx
  on public.impersonation_sessions (target_tenant_id);

alter table public.impersonation_sessions enable row level security;

-- Super-admin may read the active/historical impersonation list (portal visibility).
-- (Reading is allowed even while impersonating — this is platform metadata, not
--  tenant operational data — but the impersonator only sees the impersonation
--  ledger, never another tenant's rows.)
create policy impersonation_sessions_super_select
  on public.impersonation_sessions
  for select
  using ((select public.is_super_admin()));

-- INTENTIONALLY no INSERT/UPDATE/DELETE policy: writes happen ONLY via the
-- service-role edge functions (impersonate-tenant / end-impersonation), which
-- bypass RLS. Any client write is denied (fail-closed).

-- ── 2. Claim helpers (read ONLY the signed app_metadata claim) ───────────────
create or replace function public.current_impersonator_id()
returns uuid
language sql stable security definer set search_path = public
as $$
  select nullif(auth.jwt() -> 'app_metadata' ->> 'impersonator_id', '')::uuid;
$$;

create or replace function public.is_impersonating()
returns boolean
language sql stable security definer set search_path = public
as $$
  select (select public.current_impersonator_id()) is not null;
$$;

-- ── 3. is_active_member(): normal membership OR a LIVE impersonation of exactly
--       the active (claim) tenant. Pins current_tenant_id() in both branches.
create or replace function public.is_active_member()
returns boolean
language sql stable security definer set search_path = public
as $$
  select
    -- (a) normal membership (unchanged from 0003)
    exists (
      select 1
      from public.tenant_members m
      join public.tenants t on t.id = m.tenant_id
      where m.tenant_id  = (select public.current_tenant_id())
        and m.profile_id = (select auth.uid())
        and m.is_active  = true
        and t.status     = 'active'
    )
    -- (b) live impersonation of EXACTLY the active tenant; signed claim must
    --     match the table row; tenant must be active; not ended/expired.
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

-- ── 4. Super-admin cross-tenant READ-ONLY policies (additive; fail-closed;
--       suppressed during impersonation so AC 13 holds) ──────────────────────
create policy audit_log_super_select on public.audit_log
  for select
  using ((select public.is_super_admin()) and not (select public.is_impersonating()));

create policy tenant_members_super_select on public.tenant_members
  for select
  using ((select public.is_super_admin()) and not (select public.is_impersonating()));

create policy branches_super_select on public.branches
  for select
  using ((select public.is_super_admin()) and not (select public.is_impersonating()));

create policy profiles_super_select on public.profiles
  for select
  using ((select public.is_super_admin()) and not (select public.is_impersonating()));

-- ── 5. Impersonator-stamping trigger: every audit row written under an
--       impersonation claim carries meta.impersonator_id (AC 25), by construction.
create or replace function public.stamp_impersonator()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare imp uuid;
begin
  imp := (select public.current_impersonator_id());
  if imp is not null then
    new.meta := coalesce(new.meta, '{}'::jsonb)
                || jsonb_build_object('impersonator_id', imp::text);
  end if;
  return new;
end;
$$;

drop trigger if exists audit_log_stamp_impersonator on public.audit_log;
create trigger audit_log_stamp_impersonator
  before insert on public.audit_log
  for each row execute function public.stamp_impersonator();

-- =============================================================================
-- END OF MIGRATION 0008
-- =============================================================================
```

**RLS-safety reasoning:** the impersonation branch of `is_active_member()` still resolves the tenant **only** from `current_tenant_id()` (the signed scalar claim) and additionally demands a live, claim-matching `impersonation_sessions` row — so a normal user (no `impersonator_id` claim) is unaffected and an impersonator is confined to exactly one `active` tenant for the live window, with expiry/revocation enforced **in-policy** (no JWT-TTL dependency). The four super-admin policies are SELECT-only, granted solely by the signed `is_super_admin` claim, and vanish whenever an `impersonator_id` claim is present, so an impersonator reads exactly the target tenant. No operational policy gains a super-admin OR-branch; no read-path `SECURITY DEFINER` exists. **Verify in `rls-tenant-audit` (AC 9–15) and `security-reviewer` sign-off (AC 21, 25–29, 36).**

---

## Per-engineer hand-off

- **backend / supabase-migrate:** author `0008_super_admin_and_impersonation.sql` **verbatim** from the normative SQL (forward-only; new table + RLS at birth; helpers; `is_active_member()` replace; four read policies; trigger). **Rewrite `custom-access-token-hook`** per Decision Q2/Q5: dynamic `tenant_id`/`roles`/`is_super_admin` from `tenant_members`/`profiles` every issuance; derive impersonation **freshly** from `impersonation_sessions` (live row → stamp `tenant_id/roles/impersonator_id/impersonation_exp`; none → normal claim; **remove the "preserve existing impersonation app_metadata" branch**); write `app_metadata` only; never grant `is_super_admin` unless `profiles.is_platform_admin`. **Complete `impersonate-tenant`**: clamp TTL to `platform_settings.impersonation_max_ttl_seconds` (default 900, cap 3600), reject suspended targets (422), accept `role` (default `'owner'`), INSERT the `impersonation_sessions` row, write `impersonation.start`, return success (client then calls `refreshSession()`). Add **`end-impersonation`** (set `ended_at`, write `impersonation.stop`) and **`reactivate-tenant`** (set `status='active'`, write `tenant.reactivate`). **Get `security-reviewer` sign-off before merge.**
- **web-engineer:** `/admin` with the **dual-layer gate** — client route guard on the `is_super_admin` claim **and** server-side re-verification on every server action/fetch (AC 1–4); overview (tenant list + counts via the new read policies), tenant detail, lifecycle dialogs (provision/suspend/reactivate, reason ≥5 chars), impersonation start dialog (target/reason/TTL≤cap) → call `impersonate-tenant` then `supabase.auth.refreshSession()`; the **persistent impersonation banner** (tenant name, Arabic-Indic countdown from `impersonation_exp`, always-reachable **End** → `end-impersonation` then refresh); platform audit view with tenant/action/actor/date filters; reuse `formatEgp`/`toArabicDigits`; **no service-role key in the bundle** (AC 29). **Roles reader (Decision Q3):** accept only exact `'owner'|'manager'|'staff'`; any array/unknown/null → no role (denied).
- **ux-designer:** the `/admin` shell, overview/detail, lifecycle + impersonation dialogs, the audit view, and the **unmistakable impersonation banner** (color/persistence/countdown, RTL, i18n, accessible End control) per spec §7 — fresh via `ui-ux-pro-max`; all strings via i18n.
- **`security-reviewer` (REQUIRED — release blocker):** owns Block C (`rls-tenant-audit` pgTAP proving AC 9–15), the mint path (AC 29), the hook (AC 27, 36), the cross-tenant read policies (AC 10–12), and the impersonation confinement (AC 13). Confirm: `is_active_member()` impersonation branch cannot widen a normal user; super-admin reads are SELECT-only and suppressed under impersonation; the trigger stamps from the signed claim only; no operational `OR is_super_admin()`; no read-path `SECURITY DEFINER`.
- **QA gates on:** Block C (isolation) + Block E (impersonation) as hard gates; A/D/F/G functional; H (`ps-verify` + sign-off) as done.

## Consequences

- **Becomes easy:**
  - Impersonation actually works *and* stays inside the one isolation surface: a single `is_active_member()` edit flows to every operational policy; the impersonator is confined to one `active` tenant with **in-policy** expiry/revocation, independent of the JWT lifetime.
  - The hook has a clean, trusted source of truth (`impersonation_sessions`); expiry/revocation are fail-closed by construction (no live row → normal claim).
  - `impersonator_id` lands on **every** audited action automatically (trigger) — no per-call discipline to get wrong (AC 25).
  - Super-admin platform reads are four greppable, SELECT-only, fail-closed policies; cross-tenant write remains impossible without impersonation.
- **Becomes hard / accepted risk:**
  - `is_active_member()` is now security-critical for **two** reasons (membership **and** impersonation) — the single highest-value function to review; a mistake here is a cross-tenant leak. Mitigated by the pinned-`current_tenant_id()` + signed-claim-match + live-row design and the mandatory `rls-tenant-audit`.
  - Impersonation takes effect on the next `refreshSession()` (sub-second) and, after expiry, the impersonator can access **nothing** until they refresh back to their own context (deliberate fail-closed; the banner drives an end/refresh on countdown).
  - The hook + isolation suite are **statically audited only** on this machine; live verification is **deferred to CI/hosted** (`security-reviewer`: "static pass — pending live verification").
  - Cross-tenant **money/KPI analytics** is still not available by design (Phase 9, own ADR).
- **Follow-up / deferred:** PG-function hook variant (drop the service-role round-trip) — future hardening; super-admin self-management UI, bulk ops, tenant deletion/GDPR — later; cross-tenant analytics dashboards — Phase 9; offline/realtime — Phase 8.
- **Must verify (Phase-7 gates):** `rls-tenant-audit` proves (1) a normal owner/manager/staff can never cross tenants and gains nothing from the new policies (AC 9–10); (2) super-admin reads `audit_log`/`tenant_members`/`branches`/`profiles` across all tenants but **cannot write** any operational row without impersonation (AC 11–12); (3) an impersonation token reads/writes **only** the target tenant and **zero** rows of any other — including audit_log (AC 13); (4) grep shows no operational `OR is_super_admin()` and no read-path `SECURITY DEFINER` (AC 14); (5) the hook drops impersonation on expiry (AC 27) and never self-grants `is_super_admin` (AC 36). **Sign-off:** `security-reviewer` on the whole `0008` migration + hook + mint path; human project owner at the Phase-7 gate (Q2 mint mechanism + Q4 read scope).

## User-only actions (cannot be done by the CLI/agents)

1. **Enable the hook on hosted Supabase** — Dashboard → Authentication → Hooks → *Custom Access Token* → point at the deployed `custom-access-token-hook` (or the PG-function URI) and enable. `supabase functions deploy` alone does **not** register it as the token hook.
2. **Set the hook secret + confirm JWT expiry** — provide the hook's signing secret and confirm the project **JWT expiry limit** (access-token TTL) in Auth settings. For the PG-function variant: `grant execute on function public.<hook> to supabase_auth_admin;` and `grant usage on schema public to supabase_auth_admin;`.
3. **Normalize any seeded `app_metadata.roles` arrays to scalar** (or force-refresh affected users) — touches `auth.users`, done via Admin API / DBA SQL, to avoid a transient deny window when the dynamic hook goes live (Decision Q3).
4. **Provision super-admins out of band** — set `profiles.is_platform_admin=true` via migration/DBA (no self-service UI; spec §3 out-of-scope).
5. **Confirm `platform_settings.impersonation_max_ttl_seconds`** (seeded 3600) and the live-vs-deferred verification posture for AC 38 at the gate.

## Sources

- Supabase — Custom Access Token Hook (claim injection; runs before issuance incl. `token_refresh`; HTTP vs Postgres-function; `pg-functions://` URI; `supabase_auth_admin` grants): https://supabase.com/docs/guides/auth/auth-hooks/custom-access-token-hook
- Supabase — Auth Hooks (config.toml `[auth.hook.custom_access_token]`; enable/uri): https://supabase.com/docs/guides/auth/auth-hooks
- Supabase — Token Security & RLS (short-lived user-scoped tokens; never service_role client-side; access-token TTL is project-wide): https://supabase.com/docs/guides/auth/oauth-server/token-security
- Supabase — Custom Claims & RBAC (custom-claim hook is the place to add roles): https://supabase.com/docs/guides/database/postgres/custom-claims-and-role-based-access-control-rbac
- Supabase — admin session/impersonation discussion (`generateLink`/OTP logs in *as* the user; no arbitrary-claim mint for existing users): https://github.com/orgs/supabase/discussions/11854
- Supabase — JWTs / `session_id` claim & sessions: https://supabase.com/docs/guides/auth/jwts · https://supabase.com/docs/guides/auth/sessions
- Supabase — Row Level Security (index policy columns; `(select …)` initPlan caching; `app_metadata` in policies): https://supabase.com/docs/guides/database/postgres/row-level-security
- PostgreSQL — Row Security Policies (multiple policies are OR-combined; per-user enforcement): https://www.postgresql.org/docs/current/ddl-rowsecurity.html
- Bytebase — Postgres RLS footguns (SECURITY DEFINER bypass — why no definer on the read path): https://www.bytebase.com/blog/postgres-row-level-security-footguns/
</content>
</invoke>
