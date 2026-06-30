# ADR-0012: Staff provisioning + per-staff permissions + tenant settings + customer debts (آجل)

- **Status:** Proposed
- **Date:** 2026-06-30
- **Deciders:** Software Architect (proposing); **`security-reviewer` co-sign REQUIRED** (new edge function, new `has_permission()` helper, RLS deltas, change to the sensitive `close_session_tx`); human project owner approves at the phase gate.

## Context

Two product slices need a backend design:

- **Slice 2 — Staff management + settings.** Owners must create manager/staff login accounts from the web app **without a service-role key in the client**; assign **per-staff permission flags** (the trial had `restock / void / manageDebts / discount`); and configure café **settings** (low-stock threshold, peak windows, business-day cutover, display prefs).
- **Slice 3 — Customers & debts (آجل).** A customer debt book where a session can be closed on a **`debt`** tender (becoming a receivable), debts accept **partial settlements**, and repayments fold into shift cash reconciliation as **cash-in but NOT new revenue** (the trial's accounting rule).

**Constraints (`CLAUDE.md`):** tenant isolation via signed `app_metadata.tenant_id` claim resolved by `current_tenant_id()` (§5); RLS + `WITH CHECK` on every table (§5); money is integer piastres (§2.1); money math (pricing) lives in `@ps/core`, DB stays thin (§4); auditable money actions write `audit_log` (§2.7); idempotent writes via client UUIDs + upsert for the offline outbox (§2.8); the JWT claim is kept minimal (tenant_id + role only — [ADR-0003](0003-auth-claim-and-impersonation-model.md)).

**Decisive prior-art discovered in the existing schema (this shrinks the work substantially):**

- `public.customers`, `public.debts`, `public.debt_payments` **already exist** (migration `0002`, §§12–14) with `tenant_id`, FKs, indexes, and RLS policies (`0004` §§5–6). They were created ahead of need.
- The `public.payment_method` enum **already contains `'debt'`** (migration `0002` §1) — created inert per [ADR-0004](0004-tenant-schema-scoping-and-keys.md). **No enum ALTER is required.**
- A KV `public.settings (tenant_id, key, value jsonb)` table **already exists** (migration `0002` §5) with correct RLS (owner-write / staff-read, `0004` §4) and is **already in production use**: `apps/web/.../ReportsView.tsx` reads `key='business_day' → {cutover_hour}` to drive report bucketing; the cutover is passed as the `p_cutover` parameter to `report_revenue_by_day` (migration `0007`), clamped to `[0,23]`. Business-day cutover is therefore **tenant-level (in `settings`), not on `branches`** — confirmed: `branches` has only `id/tenant_id/name/is_active`.
- `tenant_members(tenant_id, profile_id, role, is_active)` has **no `permissions` column**. `profiles.permissions jsonb` exists but `profiles` is **cross-tenant** — the wrong scope for per-tenant permissions.
- The `provision-tenant` edge function + `provision_tenant_atomic()` + `get_auth_user_id_by_email()` RPCs (migration `0008`) are the **proven template** for server-side account creation: verify authority against the authoritative DB row (never `getUser().app_metadata`, which reflects `raw_app_meta_data` and lacks the hook-injected claims — "Finding 4"), then a single atomic SECURITY DEFINER RPC (service-role-only) does the writes + a fatal audit insert.
- `close_session_tx` (migrations `0009`/`0013`/`0014`/`0015`) is **SECURITY DEFINER** with scalar tenant guard + active-member guard + per-row payload pin guards. Any change to it requires `security-reviewer` sign-off.

The forces in tension: **add the least new surface** (reuse existing tables/enum/KV) vs. **typed/constraint safety**; and **defense-in-depth permission enforcement** (UI is never the only line, §5) vs. **not bloating the JWT claim** or making RLS brittle.

---

## Options considered

### Decision A — Where per-staff permissions live

**A1 — `permissions jsonb` on `tenant_members` (CHOSEN).**
- Pros: per-tenant scope (a user may be `staff` in tenant X and `manager` in tenant Y with different flags); co-located with `role`; mirrors the trial's per-manager flags; reuses the existing owner-write RLS on `tenant_members` (`tenant_members_owner_write`) so editing perms needs **no new write path**; permissive-default (`{}` ⇒ all allowed) is a one-column add.
- Cons: no per-flag DB type/CHECK (it's free JSON); effective-permission resolution must be centralized (a `@ps/core` helper + a SQL `has_permission()`).
- Evidence: `supabase/migrations/0001_tenancy_core.sql` (tenant_members shape + existing `profiles.permissions` precedent); `supabase/migrations/0004_rls_policies.sql` §1 (`tenant_members_owner_write`).

**A2 — dedicated `tenant_member_permissions` table.**
- Pros: typed columns + CHECK; queryable per-flag.
- Cons: extra table + FK + RLS + join on every membership read for zero functional gain; the flag set is tiny and stable. Over-engineered.

**A3 — role-only (no per-staff flags).**
- Pros: simplest.
- Cons: fails the product requirement (owners want to deny `void`/`discount` to a junior `staff` while keeping them otherwise). Rejected.

### Decision B — How permissions are read & enforced

**B1 — read via membership query + `@ps/core` resolver; enforce in UI + RLS/RPC for money-affecting actions (CHOSEN).**
- Pros: keeps the JWT claim minimal (tenant_id + role only — [ADR-0003]); a permission change takes effect **immediately** (no token refresh, unlike a claim); defense-in-depth where it matters (restock/void/debts in RLS, discount in the close RPC).
- Cons: a new SECURITY DEFINER `has_permission()` helper (reads `tenant_members.permissions`) and small RLS deltas; `can_discount` is not cleanly expressible as a pure RLS predicate so it is enforced in `close_session_tx` instead.
- Evidence: `supabase/migrations/0003_claim_helpers.sql` (helper pattern), `0004` §7 (the `reason='adjust' → owner-only` precedent — the model for `restock → can_restock`).

**B2 — put permissions in the JWT claim.**
- Cons: bloats the claim; a perm change requires a token refresh to take effect (stale-permission window); contradicts [ADR-0003]'s minimal-claim decision. Rejected.

### Decision C — Tenant settings storage

**C1 — reuse the existing KV `settings(tenant_id, key, value jsonb)` table with well-known keys validated in `@ps/core` (CHOSEN).**
- Pros: zero new tables; RLS already correct and audited; **already in production use** for `business_day`; flexible for future prefs; validation/typing centralized in a pure `@ps/core/settings` helper.
- Cons: no DB-level CHECK on JSON values (mitigated: `@ps/core` validates on write; the reporting RPC already clamps cutover to `[0,23]`).
- Evidence: `supabase/migrations/0002_operational_tables.sql` §5; `0004` §4; `apps/web/src/components/reports/ReportsView.tsx` (reads `key='business_day'`); `0007_reporting_functions.sql` (`p_cutover` clamp).

**C2 — new typed `tenant_settings` table (columns + CHECK).**
- Pros: DB-level constraints (e.g. `cutover_hour BETWEEN 0 AND 23`); simpler typed reads.
- Cons: new migration + RLS; **duplicates** an existing, in-use mechanism and would require migrating the live `business_day` key; against the lean bias. Runner-up strength (DB CHECK) is recaptured by core validation + the existing RPC clamp.

### Decision D — Modeling the `debt` tender and partial settlement

**D1 — reuse the inert `'debt'` enum value; augment `debts` with `status` + stored `paid_total`; maintain them by a recompute trigger; create the debt **inside `close_session_tx`** on a `debt` close (CHOSEN).**
- Pros: no enum ALTER; `remaining = amount − paid_total` is trivially derived; a recompute trigger (`paid_total = Σ debt_payments.amount`) is **idempotent aggregation of stored piastres** — the same pattern as `product_stock_levels.on_hand = Σ delta` and the reporting RPCs (this is ledger summation, **not** pricing math, so it does not violate §4); folding debt creation into `close_session_tx` makes a `debt`-tender close **atomic + idempotent + audited** (no money hole where a session is `debt`-closed but the receivable is missing).
- Cons: touches the sensitive `close_session_tx` (security-reviewer sign-off + new pgTAP coverage); a recompute trigger is money-adjacent and must be reviewed.
- Evidence: `supabase/migrations/0002` §§1,13,14 (`debt` enum, `debts`, `debt_payments`); `0009/0014/0015` (close RPC guard discipline); `0012`-era `audit_config_change()` trigger pattern (migration applied as `0012_audit_atomicity...`, ADR-0011) for the audit triggers.

**D2 — separate "debt" model decoupled from the enum; create debts only via a client write after close.**
- Cons: a non-atomic post-close client write can fail and leave a `debt`-closed session with no receivable; not idempotent; violates §2.7/§2.8. Rejected.

### Decision E — Revenue vs. cash accounting for debts

**E1 — accrual at close + cash-basis repayment (CHOSEN, preserves trial rule).**
- A `debt`-closed session's `grand_total` is recognized as **revenue on its close business-day** (the existing `report_revenue_by_day` already sums closed sessions regardless of `payment_method` — no change, no double count). The receivable is a balance-sheet item. A **repayment** (`debt_payments` row, tied to a `shift_id`) is **cash-in to that shift's drawer but NOT revenue**: shift reconciliation must (a) **exclude** `debt`-tender sessions from expected cash, and (b) **include** `debt_payments` for that shift as cash-in; revenue reports must **never** add `debt_payments`.
- Evidence: `0007_reporting_functions.sql` (`report_revenue_by_day` sums sessions/walk-ins, not payments); `CLAUDE.md` §3 / trial آجل rule.

---

## Decision (summary)

1. **Staff provisioning:** new **`invite-staff`** edge function mirroring `provision-tenant`. Authority is verified against the **authoritative `tenant_members` row** (caller is an active `owner` of the target tenant) via the service-role client — **never** from `getUser().app_metadata`. A single atomic service-role-only RPC `invite_staff_atomic()` creates/links the auth user → profile → membership (+permissions) and writes a fatal `audit_log` row. Editing a member's role/permissions/`is_active` afterward needs **no edge function** — it is a normal RLS-protected client write under `tenant_members_owner_write`.
2. **Per-staff permissions:** `permissions jsonb NOT NULL DEFAULT '{}'` on **`tenant_members`** (Decision A1). Flags: `can_restock`, `can_void`, `can_manage_debts`, `can_discount`. **Permissive default** (absent ⇒ allowed); owners always allowed. Read via membership query + pure `@ps/core` resolver; enforced in UI **and** server-side: RLS for `restock`/`void`/`manage_debts`, and inside `close_session_tx` for `discount` (Decision B1).
3. **Settings:** reuse the existing KV `settings` table with well-known keys validated in `@ps/core/settings` (Decision C1). No new table.
4. **Customers/debts:** reuse existing tables + the inert `'debt'` enum value; add `debts.status` (+ `debts.paid_total`), a recompute trigger, audit triggers, and fold debt creation into `close_session_tx` (Decisions D1/E1).

The single most important reason across all four: **maximize reuse of the already-built, already-audited schema and the proven `provision-tenant`/`close_session_tx` patterns**, adding only the minimum new surface — every delta still satisfies the isolation guarantee (tenant from the signed claim, RLS + `WITH CHECK`, defense-in-depth).

---

## Implementation spec (hand-off to `backend-engineer`)

> Forward-only. Three new migrations (`0016`, `0017`) + one edge function + `@ps/core` helpers. **Do not weaken any existing policy.** Every claim-helper call is wrapped in `(select …)` for initPlan caching (existing convention).

### Migration `0016_staff_permissions.sql` (Slice 2)

**1. Column**
```
alter table public.tenant_members
  add column permissions jsonb not null default '{}'::jsonb;
```
- No backfill needed (`{}` ⇒ all-allowed). No index (read only via the membership row already fetched by PK/`tenant_members_profile_idx`).

**2. Permission helper (SECURITY DEFINER, fail-closed, owner ⇒ always true)**
```
create or replace function public.has_permission(p_perm text)
returns boolean language sql stable security definer set search_path = public as $$
  select
    (select public.is_tenant_owner())                       -- owners: all perms
    or coalesce(
         ( select (m.permissions ->> p_perm)::boolean
           from public.tenant_members m
           where m.tenant_id  = (select public.current_tenant_id())
             and m.profile_id = (select auth.uid())
             and m.is_active  = true ),
         true)                                               -- permissive default
       and (select public.is_active_member());              -- must be an active member
$$;
```
- Must return **false** for non-members (the `is_active_member()` AND-term handles this); **true** for owners; the stored flag (or permissive default) for active staff.
- `grant execute … to authenticated;` (helper only; RLS is the gate).

**3. RLS deltas (drop+recreate the named policies; forward-only)**
- **`stock_movements_staff_insert`** — extend the existing `reason='adjust' → owner` check to also gate `restock`:
  ```
  with check (
    tenant_id = (select public.current_tenant_id())
    and (select public.is_tenant_staff())
    and (reason <> 'adjust'  or (select public.is_tenant_owner()))
    and (reason <> 'restock' or (select public.has_permission('can_restock')))
  )
  ```
- **`sessions_update`** and **`orders_update`** — add a void-permission term to the existing `WITH CHECK` (USING unchanged):
  ```
  and (status <> 'void' or (select public.has_permission('can_void')))
  ```
  (NEW.status is the only row image available in `WITH CHECK`; this rejects an UPDATE that *sets* `status='void'` unless the caller has `can_void`. Owners pass via `has_permission`.)
- `can_discount` is **NOT** enforced in RLS (see `close_session_tx` change in `0017`).

**4. `invite_staff_atomic()` RPC (service-role-only, SECURITY DEFINER, atomic + fatal audit)** — model on `provision_tenant_atomic()`:
```
create or replace function public.invite_staff_atomic(
  p_tenant_id   uuid,
  p_profile_id  uuid,       -- the (found-or-created) auth user id
  p_actor_id    uuid,       -- the owner performing the invite
  p_role        public.user_role,   -- must be 'manager' or 'staff'
  p_permissions jsonb,      -- {} or {can_*:bool}
  p_email       text default null,
  p_is_new_user boolean default false
) returns void language plpgsql security definer set search_path = public as $$
begin
  if p_role not in ('manager','staff') then
    raise exception 'invite_staff_atomic: role must be manager or staff' using errcode = '22023';
  end if;
  -- Idempotent membership upsert. Guard: never silently downgrade an existing owner.
  insert into public.tenant_members (tenant_id, profile_id, role, is_active, permissions)
  values (p_tenant_id, p_profile_id, p_role, true, coalesce(p_permissions,'{}'::jsonb))
  on conflict (tenant_id, profile_id) do update
    set role        = excluded.role,
        permissions = excluded.permissions,
        is_active   = true
    where public.tenant_members.role <> 'owner';   -- refuse to demote an owner
  -- FATAL audit (no exception handler) — rolls back the whole tx on failure.
  insert into public.audit_log (tenant_id, actor_id, action, entity, entity_id, meta)
  values (p_tenant_id, p_actor_id, 'member.invite', 'tenant_members', p_profile_id,
          jsonb_build_object('role', p_role::text, 'email', coalesce(p_email,''),
                             'new_auth_user', p_is_new_user, 'permissions', coalesce(p_permissions,'{}'::jsonb)));
end; $$;
revoke execute on function public.invite_staff_atomic(uuid,uuid,uuid,public.user_role,jsonb,text,boolean) from public, anon, authenticated;
grant  execute on function public.invite_staff_atomic(uuid,uuid,uuid,public.user_role,jsonb,text,boolean) to service_role;
```

### Migration `0017_debts_settlement.sql` (Slice 3)

**1. Enum + columns**
```
create type public.debt_status as enum ('open','partially_paid','settled');
alter table public.debts
  add column status     public.debt_status not null default 'open',
  add column paid_total int not null default 0;   -- piastres; maintained by trigger
-- amount stays = original principal (piastres). remaining = amount - paid_total (derived; never stored).
```
- Index: `create index debts_tenant_status_idx on public.debts (tenant_id, status);` (owner dashboard "open debts" list).
- Optional: `create index customers_tenant_phone_idx on public.customers (tenant_id, phone);` for lookup.

**2. Recompute trigger on `debt_payments` (SECURITY INVOKER; idempotent aggregation)**
- `AFTER INSERT OR UPDATE OR DELETE` on `debt_payments`, for the affected `debt_id`:
  ```
  paid_total := (select coalesce(sum(amount),0) from public.debt_payments where debt_id = <id> and tenant_id = <id.tenant>);
  status := case when paid_total <= 0 then 'open'
                 when paid_total >= debts.amount then 'settled'
                 else 'partially_paid' end;
  update public.debts set paid_total = …, status = …, updated_at = now()
    where id = <debt_id> and tenant_id = <debt.tenant_id>;   -- tenant-pinned
  ```
- This is **summation of stored piastres** (like `on_hand = Σ delta`), not pricing math — permitted in DB. Idempotent: re-summing is deterministic; a DO-NOTHING-skipped duplicate payment never fires the trigger.

**3. Audit triggers (SECURITY INVOKER, deterministic id, ON CONFLICT DO NOTHING)** — clone the `audit_config_change()` pattern (ADR-0011), with the same context-skip (empty `request.jwt.claims` / `service_role` / null `auth.uid()` ⇒ return) so seeds/migrations are not blocked:
- `AFTER INSERT on debts` → `audit_log` action `'debt.create'`, `amount = NEW.amount`, deterministic id `md5('debt.create:'||id)::uuid`.
- `AFTER INSERT on debt_payments` → `audit_log` action `'debt.payment'`, `amount = NEW.amount`, deterministic id `md5('debt.payment:'||id)::uuid`.
- The existing `stamp_impersonator()` BEFORE INSERT trigger still fires (impersonator stamp preserved).

**4. RLS deltas for `can_manage_debts`** (drop+recreate; USING unchanged):
- `debts_insert` `WITH CHECK` — add `and (select public.has_permission('can_manage_debts'))`.
- `debt_payments_all` `WITH CHECK` — add `and (select public.has_permission('can_manage_debts'))`.
- `customers_staff_write` — **leave as-is** (any active staff may create a customer when opening آجل; matches the trial).

**5. `close_session_tx` change (SECURITY DEFINER — security-reviewer SIGN-OFF + pgTAP)** — extend the function signature with a nullable `p_debt jsonb default null`:
- Add a **`can_discount` guard** immediately after the existing scalar/member guards:
  ```
  if coalesce((p_session_patch->>'discount')::int,0) <> 0
     and not (select public.has_permission('can_discount'))
  then raise exception 'close_session_tx: caller lacks can_discount' using errcode = '42501'; end if;
  ```
  (Note: `0009`'s `p_session_patch` does not currently persist `discount`; if discount is applied at close, the patch must include it and the UPDATE must set it — confirm with the close payload owner. If discount is set on the session *before* close via `sessions_update`, enforce there instead; **flag for security-reviewer to pick one authoritative write site**.)
- Add a **debt-creation block** when `p_debt is not null` (i.e. `payment_method='debt'`):
  - Apply the **same per-row payload pin guard** as migration `0014` (raise `42501` if `p_debt->>'tenant_id'` is distinct from `p_tenant_id`).
  - Insert into `debts` with deterministic id `debt:{session_id}` (compute via `@ps/core` uuidv5 before enqueue), `amount = grand_total`, `customer_id`/`customer_name` from payload, `session_id`, `manager_id = p_actor_id`, `shift_id`, **`ON CONFLICT (id) DO NOTHING`** (idempotent replay).
  - The `debts` AFTER INSERT audit trigger fires once; replay inserts 0 rows.
- Update the `REVOKE/GRANT` for the new signature; keep `execute` to `authenticated` only.

### Settings (no migration)

- Reuse `public.settings`. Well-known keys (validated by a **new pure `@ps/core/settings`** module — `validateSettings(key, value)` / typed getters, no `Date.now()`):
  | key | value shape | default |
  |---|---|---|
  | `business_day` | `{ cutover_hour: int 0..23 }` | `{cutover_hour: 6}` *(already in use)* |
  | `inventory` | `{ low_stock_threshold: int >= 0 }` | `{low_stock_threshold: 5}` |
  | `peak_windows` | `{ windows: [{start:'HH:mm', end:'HH:mm'}] }` | `{windows: [{start:'18:00', end:'02:00'}]}` |
  | `display` | `{ cafe_name?: string, … }` | `{}` |
- RLS already correct (`settings_staff_select` read, `settings_owner_write` write). Optionally seed defaults at provisioning time (extend `provision_tenant_atomic` later — **out of scope here**; UI falls back to defaults on missing key, as `ReportsView` already does).

---

## Edge-function contract — `invite-staff`

```
POST /functions/v1/invite-staff      (Authorization: Bearer <caller access token>)
body: {
  tenant_id:   string (uuid),      // required — target tenant
  email:       string,             // required — new member login
  role:        'manager' | 'staff',// required — owners cannot be minted here
  full_name?:  string,
  permissions?:{ can_restock?:bool, can_void?:bool, can_manage_debts?:bool, can_discount?:bool }
}
```
**Authorization (fail-closed, DB-authoritative — the `provision-tenant` "Finding 4" lesson):**
1. `getUser()` from the caller's JWT → `caller_id`. 401 if unauthenticated.
2. Using the **service-role** client, verify an active OWNER membership of the target tenant:
   `select 1 from tenant_members where profile_id=caller_id and tenant_id=body.tenant_id and role='owner' and is_active=true`. **403 if absent.** Do **not** trust `getUser().app_metadata` (it reflects `raw_app_meta_data`, lacking the hook-injected `tenant_id`/`roles`).
3. Reject `role` ∉ {`manager`,`staff`} (400). Validate email format (400). Validate `permissions` keys against the allowed set (400 on unknown key).

**Behavior (service-role, idempotent):**
1. Find-or-create the auth user: `auth.admin.createUser({ email, email_confirm:true, password: <generated temp> })`; on duplicate, resolve via `get_auth_user_id_by_email`. Temp password returned **only** for a newly created user.
2. `upsert profiles {id, full_name, is_active:true}`.
3. Call `invite_staff_atomic(tenant_id, profile_id, caller_id, role, permissions, email, is_new_user)` (atomic membership upsert + fatal audit; refuses to demote an existing owner).

**Returns:** `201 { profile_id, temp_password? }` (`temp_password` present only for a new auth user — handed to the owner out-of-band; never logged, never in the client bundle).

**Not in this function:** changing a member's role/permissions/`is_active` (use a direct client `update` on `tenant_members` under `tenant_members_owner_write`); deleting a member (set `is_active=false`).

---

## Per-engineer hand-off

- **`backend-engineer`** — migrations `0016` + `0017` exactly as sketched; the `invite-staff` edge function; the `close_session_tx` extension (gated behind security-reviewer). Honor: forward-only, no weakening of existing policies, `(select …)` helper wrapping, deterministic ids + `ON CONFLICT DO NOTHING` on all RPC inserts, per-row tenant pin guard on the new `p_debt` payload.
- **`core-engineer`** — pure `@ps/core/settings` (key/value validators + typed getters; no clock reads) and `@ps/core/permissions` (`resolveStaffPermissions(role, permissionsJson) → {can_restock,…}` with owner⇒all-true, permissive default); the uuidv5 helpers `debtId(sessionId)` for the close payload; shift-reconciliation helper that **excludes `debt`-tender sessions from expected cash and includes `debt_payments` (by `shift_id`) as cash-in**, while revenue helpers exclude `debt_payments`. >90% coverage.
- **`web-engineer`** — staff list/invite UI (calls `invite-staff`; shows temp password once); permission toggles (direct `tenant_members` update); settings forms writing the four KV keys; customers + debts + settlement UI; gate actions on `resolveStaffPermissions`.
- **`mobile-engineer`** — gate restock/void/discount/debt actions on `resolveStaffPermissions`; route a `debt`-tender close through `close_session_tx` with the `p_debt` payload (client UUID, idempotent); enqueue `debt_payments` via the outbox (client UUID, upsert).

---

## Consequences

- **Becomes easy:** owners self-serve staff onboarding without a service-role key; fine-grained per-staff money-action control with immediate effect (no token refresh); a complete, atomic, audited آجل flow; settings extensible without migrations.
- **Becomes hard / watch-outs:** `has_permission()` adds a per-write membership read on the gated paths (acceptable — same shape as `is_active_member()`); `can_discount` enforcement depends on choosing **one** authoritative discount write-site (close RPC vs. session update) — security-reviewer must pick; the recompute trigger is money-adjacent (reviewed as ledger summation, not pricing); `close_session_tx` is touched again (highest-sensitivity function).
- **Runner-up strengths folded in:** typed-table CHECK constraints (C2) → recovered via `@ps/core` validation + the existing RPC clamp; JWT-claim permissions (B2) explicitly rejected to keep the claim minimal and changes instant.
- **Follow-up work:** seed default `settings` keys at provisioning (future); consider a `report_shift_cash(shift_id)` SECURITY INVOKER RPC if client-side shift cash assembly proves heavy.
- **Must verify (gates):**
  - `rls-tenant-audit` pgTAP: extend the suite so **tenant A cannot read/write tenant B** `debts`/`debt_payments`/`tenant_members.permissions`; a `staff` without `can_void`/`can_restock`/`can_manage_debts` is **rejected at the DB** (not just UI); `invite_staff_atomic`/`invite-staff` cannot cross tenants or be called by a non-owner; `has_permission()` returns false for non-members and true for owners.
  - Extend `05_outbox_close_tx.test.sql`: a `debt`-tender close creates **exactly one** `debts` row (idempotent replay = no-op); cross-tenant `p_debt` payload rejected (`42501`); `can_discount`-less caller rejected.
  - `ps-verify` (tsc/jest/expo export/next build) green.
  - **Sign-off:** **`security-reviewer`** on the edge function, `has_permission()`, all RLS deltas, the audit/recompute triggers, and the `close_session_tx` change; **human** at the phase gate.
