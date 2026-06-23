# ADR-0003: Tenant JWT-claim shape, freshness, and super-admin impersonation model

- **Status:** Proposed (tenancy/auth — **`security-reviewer` sign-off required** before Accepted; human project owner approves at the Phase-2 gate)
- **Date:** 2026-06-23
- **Deciders:** architect (proposing) · `security-reviewer` (sign-off **required** — tenancy/auth) · human project owner
- **Builds on:** [ADR-0002 — Multi-tenant data-isolation model](0002-tenant-isolation-model-ratified.md) (Accepted). ADR-0002 fixed *shared-DB + `tenant_id` + RLS + a trusted signed `app_metadata` claim*. This ADR fixes **the exact shape of that claim, how it stays fresh, and how super-admin crosses tenant boundaries** — the auth-shaping details ADR-0002 deferred to the architect (spec §6 Q1–Q4, §7 hand-off).

## Context

ADR-0002 mandates that tenant identity comes from a **signed `app_metadata` JWT claim** injected by a Supabase **Custom Access Token Hook**, read in RLS by `current_tenant_id()` / `auth_tenant_ids()` — never from client input, never from a hot-path `profiles` lookup. It deliberately left three auth-shaping questions open because they are hard to reverse once migrations, the hook, and every RLS policy depend on them:

1. **Claim shape & active-tenant selection.** `tenant_members(tenant_id, profile_id, role)` is many-to-many: one human can own/staff multiple café businesses. What exactly goes in the token — a single `tenant_id`, the full `tenant_ids[]`, or both? How is the "active" tenant chosen on login and switched?
2. **Claim freshness.** The hook runs at token issuance. When an owner adds/removes staff or changes a role mid-session, the live token is stale. Forced re-auth, short TTL + refresh, or accept eventual consistency?
3. **Super-admin impersonation mechanics.** A minted short-lived token carrying the target `tenant_id` + an `impersonator_id` claim, or a `super_admin` RLS-bypass predicate? Plus the time-box and audit shape.

**Constraints (from `CLAUDE.md` §5, ADR-0002):** the claim must be signed and non-user-editable; RLS reads it, not the client; every cross-tenant action is explicit, time-boxed, and audited; defense in depth (app filtering is never the only line); `@ps/core` stays pure. **Forces in tension:** strong isolation + auditability vs. a smooth multi-tenant UX (tenant switching, no surprise logouts) vs. RLS-policy simplicity + performance (the claim must be cheap to read in every policy on every row).

**Evidence established before this ADR:** the Custom Access Token Hook runs on **every** token issuance **including refresh-token rotation**, and the event payload carries `authentication_method` (values include `token_refresh`) so the hook can re-read membership on each refresh. This makes "short TTL + hook re-runs on refresh" a viable freshness model without forced logout. Best-practice impersonation is a **server-minted short-lived token carrying tenant claims**, never a `service_role`/RLS-bypass path reachable from the client.

## Options considered

### Decision 1 — Claim shape & active-tenant selection

#### Option 1A — Single `tenant_id` claim only (re-mint on switch) — **CHOSEN**
The token's `app_metadata` carries one scalar `tenant_id` = the user's *active* tenant, plus `roles` for that tenant and a platform `is_super_admin` boolean. Switching tenant calls a server endpoint that validates membership and forces a token refresh; the hook re-reads `tenant_members` and stamps the new active `tenant_id`. RLS reads exactly one value: `current_tenant_id()` → `auth.jwt() -> 'app_metadata' ->> 'tenant_id'`.
- Pros: simplest, fastest RLS — every policy is `tenant_id = (select current_tenant_id())`, one scalar, one index probe, no array containment per row; smallest blast radius (a stale/forged token grants at most one tenant); the active tenant is unambiguous and always equals the enforced tenant.
- Cons: switching tenants requires a token refresh round-trip (sub-second); a multi-tenant user can only operate in one tenant per token (acceptable — the UI is per-tenant anyway).
- Evidence: https://supabase.com/docs/guides/database/postgres/row-level-security (index policy columns; scalar equality is the fast path) ; https://blog.ardabeyazoglu.com/supabase-multi-tenancy (set `app_metadata.tenant_id`, read it in RLS).

#### Option 1B — `tenant_ids[]` array claim, RLS uses array containment
Token carries the full membership array; RLS uses `tenant_id = ANY (auth_tenant_ids())`.
- Pros: switch tenants with no refresh; one token covers all memberships.
- Cons: **larger blast radius** (one token authorizes every tenant the user belongs to); RLS containment is slower and easier to get subtly wrong; "which tenant is a write going to?" becomes ambiguous — `WITH CHECK` must still pin a single target, re-introducing an active-tenant concept anyway; super-admin would carry an unbounded array. Worse on the highest-weighted axis (isolation) for marginal UX gain.
- Evidence: https://supabase.com/docs/guides/auth/auth-hooks/custom-access-token-hook (claims are arbitrary JSON; size/ء correctness is the implementer's burden).

#### Option 1C — Both: scalar active `tenant_id` + `tenant_ids[]` for the switcher UI
Carry both; RLS uses only the scalar; the array drives a client tenant-picker.
- Pros: fast RLS (uses scalar) + no extra query to render the switcher.
- Cons: the array in the token is a **non-authoritative convenience copy** that can drift from `tenant_members`; tempts future code to trust it for authorization; bigger token. The switcher can instead read `tenant_members` directly (a cheap, RLS-exempt, user-scoped read), so the array buys nothing security-relevant.

### Decision 2 — Claim freshness on role/tenant change

#### Option 2A — Short access-token TTL + hook re-reads membership on refresh (eventual consistency) — **CHOSEN**
Set a short access-token TTL (≈ 1 hour, Supabase default; tunable down). The hook reads `tenant_members` on **every** issuance — login **and** refresh — so role/membership changes propagate within one TTL with no user-visible logout. For the rare changes that must be immediate (revoke a fired employee, suspend a tenant), pair it with **server-side enforcement that does not depend on the stale claim**: a `tenant_members.is_active` / `tenants.status='suspended'` check enforced in policies via the membership table, plus optional explicit session revocation (`auth.admin signOut` / refresh-token revocation) for true emergencies.
- Pros: no forced logouts on routine role edits (good UX); leverages the documented hook-on-refresh behavior; immediate revocation is still available for emergencies via session revocation; correctness of *suspension* does not rely on token freshness because suspension is also checkable in-policy.
- Cons: routine role downgrades take up to one TTL to fully reflect in the token's `roles`; emergency revocation needs an explicit code path.
- Evidence: hook runs on `token_refresh` (confirmed) — https://github.com/supabase/supabase/blob/master/apps/docs/content/guides/auth/auth-hooks/custom-access-token-hook.mdx ; https://supabase.com/docs/reference/javascript/auth-refreshsession ; short-TTL guidance — https://supabase.com/docs/guides/auth/oauth-server/token-security.

#### Option 2B — Force re-authentication on every role/tenant change
Any membership change invalidates sessions; user logs in again.
- Pros: token is never stale.
- Cons: hostile UX (a manager promoting a staffer logs that staffer out); operationally heavy; unnecessary given suspension/revoke can be enforced out-of-band.

#### Option 2C — Accept full eventual consistency with no emergency path
Short TTL only; wait for natural expiry even on a fired employee.
- Cons: a revoked user retains access for up to one TTL with no override — unacceptable for a cash business.

### Decision 3 — Super-admin & impersonation mechanics

#### Option 3A — `super_admin` is a platform flag; impersonation = server-minted, time-boxed, audited token carrying the target `tenant_id` + `impersonator_id` (NO RLS bypass) — **CHOSEN**
`super_admin` is **not** a `tenant_members` row and **not** a tenant predicate exception. It is a platform-level flag (`profiles.is_platform_admin`) surfaced as `app_metadata.is_super_admin`. Super-admins have **no standing access to tenant rows** — RLS for tenant tables is the same `tenant_id = current_tenant_id()` for everyone. To support a tenant, a super-admin calls a guarded server endpoint (edge function, service-role server-side only) that: (a) verifies `is_super_admin`; (b) writes an `audit_log` row (`action='impersonation.start'`, actor, target `tenant_id`, expiry); (c) mints a **short-lived** session whose `app_metadata` has `tenant_id = <target>`, `roles` for that tenant, **and** `impersonator_id = <super_admin profile id>` + `impersonation_exp`. The impersonation token behaves exactly like a normal tenant user's token, so the *same* RLS enforces isolation — the super-admin sees only that one tenant, only while the short token is valid.
- Pros: **no RLS bypass branch exists** — the one dangerous "ignore tenant" path is never written, so it can never leak; every cross-tenant entry is explicit (a mint), time-boxed (token TTL ≤ impersonation window), and audited (start row + the `impersonator_id` stamped on every audited action during the window); blast radius is one tenant for one short window; reuses the exact RLS already tested by `rls-tenant-audit`; matches documented Supabase guidance (mint server-side with tenant info; never expose service_role).
- Cons: a fired/expired impersonation requires waiting out the short token or explicit revocation; the mint endpoint is sensitive (service-role) and must be locked to verified super-admins; cross-tenant *platform analytics* (super-admin dashboards over all tenants) can't use this user-scoped token and must be a separate, explicitly-audited service-role server path (acceptable; out of Phase-2 scope, flagged for its own review).
- Evidence: https://supabase.com/docs/guides/auth/oauth-server/token-security (short-lived, user-scoped tokens limit blast radius; never service_role client-side) ; https://supabase.com/docs/guides/auth/auth-hooks/custom-access-token-hook (inject signed claims) ; https://makerkit.dev/blog/tutorials/supabase-rls-best-practices (don't bypass RLS for admin; scope explicitly).

#### Option 3B — `super_admin` RLS-bypass predicate (`OR is_super_admin()` on every policy)
Add `OR (select is_super_admin())` to every tenant policy.
- Pros: trivial to implement; no minting.
- Cons: **writes the exact cross-tenant leak ADR-0002 warns about** — one boolean, present in every policy, that disables tenant isolation; a single bug in `is_super_admin()` (or a forged/stale claim) exposes **all tenants** at once (maximum blast radius); access is **silent** (no per-entry mint, no time-box, hard to audit which tenant was touched when); contradicts `CLAUDE.md` §5 "never a silent cross-tenant read." Rejected.

#### Option 3C — `super_admin` as a special `tenant_members` row
Model the platform admin inside the tenant membership table.
- Cons: tenant-scopes a platform concept (spec Q4 explicitly says super_admin must NOT be tenant-scoped); pollutes per-tenant membership queries; no natural time-box. Rejected.

## Decision

1. **Claim shape (Option 1A):** the access token's `app_metadata` carries a single scalar **`tenant_id`** (the active tenant), a **`roles`** value for that tenant, and a platform **`is_super_admin`** boolean. RLS reads only the scalar `tenant_id`. Tenant switching is a server-validated **token refresh** that re-stamps the active tenant. The tenant *switcher UI* reads `tenant_members` directly (cheap, user-scoped) — the token carries no convenience array.
2. **Freshness (Option 2A):** short access-token TTL + the hook **re-reading `tenant_members` on every issuance including refresh** = eventual consistency within one TTL, no forced logouts for routine changes. **Suspension/revocation is enforced independently of token freshness:** policies gate on `tenants.status` and `tenant_members.is_active` (via the membership relationship), and emergencies use explicit session/refresh-token revocation.
3. **Impersonation (Option 3A):** `super_admin` is a **platform flag**, never a tenant predicate exception. There is **no RLS-bypass branch anywhere.** Cross-tenant support is a **server-minted, short-lived, audited** token carrying the target `tenant_id` + `impersonator_id` + `impersonation_exp`, enforced by the *same* RLS as a normal tenant user.

**Single most important reason:** this set keeps isolation **physical-in-effect** — the only code that ever resolves a tenant is `current_tenant_id()` reading one signed scalar, and **no path exists that ignores it** (no array ambiguity, no super-admin bypass). Every cross-tenant crossing is reduced to *minting a normal-looking tenant token*, so the single, already-tested RLS predicate is the *only* isolation surface to audit.

**Explicitly NOT doing now:** a `tenant_ids[]` authorization array in the token; an `OR is_super_admin()` bypass on any policy; standing super-admin read access to tenant data; the cross-tenant platform-analytics service path (deferred to its own ADR/review when super-admin dashboards are built in Phase 7); auto-revocation infrastructure beyond Supabase's built-in session revocation.

## Consequences

- **Becomes easy:**
  - Every tenant RLS policy is the same scalar equality (`tenant_id = (select current_tenant_id())`) — fast (single index probe), uniform, trivially auditable; `rls-tenant-audit` tests one predicate, not per-table variations.
  - Impersonation reuses the normal-user RLS path, so no new isolation surface is introduced; the audit trail is a natural `impersonator_id` stamp.
  - Routine role/membership edits propagate automatically on next refresh — no logout UX.
- **Becomes hard / accepted risk:**
  - Tenant switching costs a refresh round-trip (sub-second, acceptable).
  - Routine role *downgrades* lag by up to one TTL in the token's `roles`; emergencies require explicit revocation (a documented, deliberate path).
  - The impersonation **mint endpoint is service-role and high-value** — it must be locked to verified super-admins, rate-limited, and fully audited; `security-reviewer` owns this.
  - Cross-tenant platform analytics needs a separate, explicitly-audited path later (not free in this model — by design).
- **Follow-up work (hand-off):**
  - **`security-reviewer` (sign-off required):** the hook's claim-construction logic (reads `tenant_members`/`profiles`, writes `app_metadata` only — never `user_metadata`, never request input); `current_tenant_id()` / `auth_tenant_ids()`; the absence of any `is_super_admin` bypass in tenant policies; the impersonation mint endpoint (super-admin gate, time-box, `audit_log` start/stop, `impersonator_id` stamping); suspension/`is_active` enforcement path. Owns `rls-tenant-audit`.
  - **backend:** implement the Custom Access Token Hook (stamp scalar `tenant_id`, `roles`, `is_super_admin`; re-read on `token_refresh`); the claim helpers; the impersonation edge function; `tenants.status` + `tenant_members.is_active` policy gating; audit rows.
  - **`@ps/core`:** add `super_admin` to `Role`; no auth/claim logic leaks into core (stays pure).
  - **mobile / web (Phase 3+):** tenant switcher reads `tenant_members` + triggers refresh; never trust a client `tenant_id`; impersonation must be visually unmistakable and show the active `impersonator_id`/expiry.
- **Must verify (before Accepted):**
  - `rls-tenant-audit`: A↮B isolation holds under (a) a normal tenant token and (b) an impersonation token (super-admin sees only the targeted tenant, only while valid).
  - Claim trust: `tenant_id`/`is_super_admin`/`impersonator_id` live in **signed `app_metadata`**, not `user_metadata`, body, or header; policies never read client-supplied tenant ids.
  - No bypass: grep proves **no** tenant policy contains an `is_super_admin`/`OR true`/service-role escape; no `SECURITY DEFINER` helper returns cross-tenant rows.
  - Impersonation: start/stop write `audit_log`; token is time-boxed; no silent cross-tenant read path exists.
  - **Env caveat (this machine):** authored + **statically audited only**; live execution of the hook + isolation suite is **DEFERRED to CI/hosted Supabase**. `security-reviewer`'s verdict on this machine is **"static pass — pending live verification,"** not full sign-off.
