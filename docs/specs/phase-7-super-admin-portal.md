# Phase 7 — Super-admin portal (platform operations)

> Surfaces: **backend + web** (`apps/web`, `supabase`). No mobile, no `@ps/core` changes expected.
> Anchors: [ADR-0002](../adr/0002-tenant-isolation-model-ratified.md) (shared-DB + RLS, ACCEPTED), [ADR-0003](../adr/0003-auth-claim-and-impersonation-model.md) (scalar `tenant_id` claim · short-TTL freshness · **server-minted, time-boxed, audited impersonation, NO RLS-bypass branch**). New decisions land as **ADR-0008 (super-admin platform-operations + cross-tenant read + impersonation completion)**.
> Status: 🟡 needs spec → build. **MOST SECURITY-SENSITIVE phase.** `security-reviewer` sign-off is REQUIRED; any cross-tenant leak (including via impersonation) is a release blocker.

---

## 1. Problem & goal

The platform operator (super-admin) currently has **no usable surface**. The plumbing exists (the `provision-tenant` / `suspend-tenant` / `impersonate-tenant` edge functions, the `is_super_admin()` claim helper, `tenants.status`, `audit_log`) but: there is no `/admin` UI; impersonation is **not actually completed** (the `impersonate-tenant` function returns claim metadata but never mints a real session token); there is **no super-admin cross-tenant read policy** for the platform audit trail or member counts; the **custom-access-token-hook is authored but not deployed/enabled** (the demo still relies on static `app_metadata`, so claims are not dynamic); and the **roles claim shape is unreconciled** (the hook writes `roles` as scalar text, `current_role_in_tenant()` reads it as scalar text, but clients have treated `roles` as an array — a fail-open hazard).

Phase 7 delivers the super-admin web portal and its backend: a platform overview, tenant lifecycle (provision / suspend / reactivate), a **guarded, visible, fully-audited impersonation flow**, and a **cross-tenant platform audit view** — while closing the auth residuals that impersonation correctness depends on. The win: the operator can onboard and support paying tenants, and every cross-tenant action is explicit, time-boxed, and provable in the audit trail.

**Roles touched:** `super_admin` (the entire new surface). `owner`/`manager`/`staff` are touched only negatively — Phase 7 must **prove** they gain no new cross-tenant capability. The deferred ADR-0003 item ("cross-tenant platform-analytics path needs its own ADR/review") is the audit-read portion ratified here under tight scope.

---

## 2. Prior art (reuse — do not reinvent)

| Asset | Location | Phase-7 use |
|---|---|---|
| Impersonation model (server-minted short-lived token, `impersonator_id` + `impersonation_exp`, **no RLS bypass**) | ADR-0003 §Decision 3 | The contract. Phase 7 **completes** the mint; does not re-decide the model. |
| Claim helpers `current_tenant_id()`, `current_role_in_tenant()`, `is_super_admin()`, `is_active_member()`, `auth_tenant_ids()` | `supabase/migrations/0003_claim_helpers.sql` | Reused unchanged except the roles-shape reconciliation note (§7 Q3). |
| Edge functions `provision-tenant`, `suspend-tenant`, `impersonate-tenant`, `custom-access-token-hook` | `supabase/functions/*` | Wired to the portal; `impersonate-tenant` completed; hook deployed + hardened (expiry check). |
| `tenants` (`status active|suspended`), `tenant_members`, `profiles.is_platform_admin`, `platform_settings` | `0001_tenancy_core.sql` | Read/written by the portal. `platform_settings.impersonation_max_ttl_seconds` already seeded (3600). |
| `audit_log` (`tenant_id`, `actor_id`, `action`, `entity`, `entity_id`, `amount`, `meta`, `created_at`) | `0002_operational_tables.sql` | Platform audit view; impersonation/lifecycle actions write here. |
| Existing RLS: `tenants_member_select` already includes `is_super_admin()`; `tenants_super_insert/update` are super-admin-only | `0004_rls_policies.sql` | Super-admin can already read/insert/update `tenants`. **Gap:** no super-admin cross-tenant SELECT on `audit_log`, `tenant_members`, `branches`. |
| Web auth pattern, RTL/Arabic-first dashboard shell, `formatEgp`/`toArabicDigits` | Phases 3 & 6 (`apps/web`) | The portal reuses the existing web auth + i18n + design system; no new currency/time math. |

**Default stance:** match the proven model, generalized for the platform tier. Deltas are called out explicitly in §7.

---

## 3. Scope

### In scope
- **3.1 Route + role gate.** A super-admin-only area at `/admin` in `apps/web`, gated **both** client-side (route guard reads `is_super_admin` from the session claim) **and** server-side (every server action / route handler / data fetch re-verifies `is_super_admin()` — never trusts the client).
- **3.2 Platform overview.** List **all** tenants with: name, status (`active`/`suspended`), member count, branch count, created date, and a coarse "health" signal (e.g. has-at-least-one-active-owner; last-activity timestamp from `audit_log.created_at`). Search/filter by name and status.
- **3.3 Tenant detail.** One tenant's status, members (profile, role, active flag), branches, and recent platform-relevant audit rows for that tenant.
- **3.4 Tenant lifecycle.** Provision a new tenant + first owner (wired to `provision-tenant`); suspend (`suspend-tenant`); reactivate (sets `status='active'` via the same guarded server path). Each action writes a platform `audit_log` row (`tenant.provision` / `tenant.suspend` / `tenant.reactivate`) with actor = super-admin, target tenant, reason, timestamp.
- **3.5 Guarded impersonation (completed).** Super-admin starts a time-boxed impersonation of one tenant; the server **mints a real short-lived session** carrying `tenant_id=<target>`, `roles` for that tenant, `is_super_admin=true`, `impersonator_id`, `impersonation_exp`. While impersonating: a persistent, unmistakable **"impersonating <tenant>" banner** with remaining time and an **End impersonation** control. Ending or expiry returns to the super-admin's own context. **Every** audited action during the window carries `impersonator_id` in `audit_log.meta`.
- **3.6 Platform audit view.** Super-admin reads the **cross-tenant** audit trail (new explicit super-admin SELECT policy), filterable by tenant, action, actor, and date range. Impersonation start/stop and lifecycle events are visible.
- **3.7 Resolve standing residuals (impersonation depends on these):**
  - **Deploy + enable** the `custom-access-token-hook` so claims are **dynamic** (sourced from `tenant_members`/`profiles` on every issuance incl. refresh), not static `app_metadata`.
  - **Reconcile the roles claim shape** across hook + DB + web client to a single fail-closed representation (scalar text `roles`); no surface treats `roles` as an array.
  - **Harden the hook for impersonation expiry:** on token refresh, if `impersonation_exp` has passed, the hook must **drop** the impersonation claim and revert to the user's own super-admin context (fail-closed — impersonation must never silently auto-extend past its window).
- **3.8 Forward-only migration `0008_*`** adding the new super-admin cross-tenant **read** policies (and the `impersonation_sessions` table **iff** the architect elects it — see §7 Q1). `security-reviewer` MUST sign off; `rls-tenant-audit` pgTAP MUST be extended (§6 AC block C).

### Out of scope (later phases / deferred)
- Offline outbox / dead-letter / realtime (Phase 8).
- Stripe billing, plans, paywall, subscription state (Phase 9) — Phase 7 shows lifecycle status only, not billing.
- Sentry / EAS / performance budgets / formal a11y pass / full pen-test (Phase 10).
- **Any mobile change** and **any `@ps/core` change.**
- Cross-tenant **analytics/KPIs** over money (revenue across tenants, MRR, etc.) — only the **audit trail** cross-tenant read is in scope; aggregate platform money dashboards are deferred (Phase 9/later, own ADR).
- Editing a tenant's operational data (devices/pricing/orders) from the super-admin context **except via impersonation** — there is no direct cross-tenant write path.
- Self-service super-admin creation / super-admin management UI (super-admins are provisioned by migration/DBA out of band).
- Bulk tenant operations, tenant deletion/data-export/GDPR erasure (later).

---

## 4. User stories

- **As a super-admin, I want a platform overview of every tenant with status and health,** so that I can see the whole business at a glance and spot problems.
- **As a super-admin, I want to provision a new tenant with its first owner,** so that I can onboard a paying café in one step.
- **As a super-admin, I want to suspend and reactivate a tenant,** so that I can enforce non-payment or abuse policy and restore service, with the effect immediate (not waiting on token expiry).
- **As a super-admin, I want to temporarily impersonate a tenant with a visible banner and a hard time limit,** so that I can reproduce and fix a support issue while seeing exactly what that tenant sees — and nothing else.
- **As a super-admin, I want every impersonated action and lifecycle action recorded with my identity,** so that support activity is fully accountable.
- **As a super-admin, I want a filterable cross-tenant audit trail,** so that I can investigate incidents across the platform.
- **As a tenant owner/manager/staff, I want certainty that platform staff cannot silently read or write my data,** so that I trust the platform with my cash business. (Negative story — enforced by RLS + audit, proven by tests.)

---

## 5. Domain notes (CLAUDE.md / ADR links)

- **§5 Tenancy & security:** tenant identity comes only from the signed `app_metadata` claim; RLS reads it, never client input. Super-admin cross-tenant access must be **explicit, time-boxed, audited** — "never a silent cross-tenant read." The new audit-read policy is the single explicit exception and must be `is_super_admin()`-gated only.
- **§2.5 RLS on every table:** the `0008` migration ships no table without policies; `impersonation_sessions` (if elected) gets RLS at birth.
- **§2.7 Auditable money/actions:** lifecycle + impersonation start/stop write `audit_log`; impersonated money actions already write audit rows (Phases 4–5) and must additionally carry `impersonator_id`.
- **§2.6 Arabic-first / RTL:** all portal strings via i18n resources; Arabic-Indic numerals where the rest of the app uses them; layout RTL. The impersonation banner and lifecycle dialogs are user-facing strings, not hardcoded.
- **No service-role key in any client bundle** (CLAUDE.md §5, ADR-0003): service-role lives only in edge functions / server-side. The portal calls edge functions with the super-admin's user JWT; the browser never holds a service-role key.
- **ADR-0003 §Decision 3:** no `OR is_super_admin()` predicate on any tenant operational policy; the only super-admin cross-tenant reach is (a) impersonation (a normal-looking minted token enforced by the same RLS) and (b) the new explicit audit/lifecycle **read** policies on platform-relevant tables.

---

## 6. Acceptance criteria (numbered, testable Given/When/Then)

### Block A — Route + role gating
1. **Given** an authenticated user whose claim has `is_super_admin=false`, **when** they request any `/admin` route, **then** they are denied (redirected away / 403) and no platform data is returned in the response payload.
2. **Given** an unauthenticated visitor, **when** they request any `/admin` route, **then** they are redirected to login and no platform data is fetched.
3. **Given** a user with `is_super_admin=true`, **when** they open `/admin`, **then** the platform overview renders.
4. **Given** any `/admin` server action or data fetch, **when** it executes, **then** it independently re-verifies `is_super_admin()` server-side (the gate does not rely on the client guard alone) — verified by a test that calls the server path with a non-super-admin JWT and gets denied.

### Block B — Platform overview & tenant detail
5. **Given** ≥2 seeded tenants, **when** a super-admin opens the overview, **then** all tenants are listed with name, status, member count, branch count, and created date.
6. **Given** the overview, **when** the super-admin filters by status=`suspended`, **then** only suspended tenants are shown; clearing the filter restores all.
7. **Given** a tenant with N active members and M branches, **when** the super-admin opens its detail page, **then** the member list (profile, role, active flag) and branch list are shown and counts match N and M.
8. **Given** the tenant detail page, **when** it loads, **then** recent audit rows for that tenant are shown, most-recent first.

### Block C — RLS / tenant isolation (rls-tenant-audit pgTAP — BLOCKER if any fail)
9. **Given** a normal owner/manager/staff token for tenant A, **when** they attempt to SELECT `audit_log`, `tenant_members`, `branches`, or any operational row of tenant B, **then** zero rows of tenant B are returned (existing isolation preserved; no Phase-7 policy weakens it).
10. **Given** a normal owner/manager/staff token, **when** they attempt to SELECT another tenant via the new super-admin cross-tenant audit policy, **then** they get nothing — the new policy grants rows **only** when `is_super_admin()` is true.
11. **Given** a `super_admin` token, **when** they SELECT `audit_log`, **then** they can read rows across **all** tenants (the explicit, ratified cross-tenant read), and this read path is the only non-impersonation cross-tenant data reach that exists.
12. **Given** a `super_admin` token, **when** they attempt to **write** (INSERT/UPDATE/DELETE) any tenant operational row (devices/sessions/orders/products/...) **without** impersonation, **then** the write is rejected by RLS (super-admin has no standing cross-tenant write).
13. **Given** an impersonation token scoped to tenant A (`tenant_id=A`), **when** it is used, **then** it can read/write **only** tenant A's rows and **zero** rows of tenant B — proving the impersonation token is scoped to exactly one tenant for its window and cannot bypass RLS.
14. **Given** a grep/static scan of all migrations, **when** Phase-7 policies are reviewed, **then** **no** tenant operational policy contains an `OR is_super_admin()` / `OR true` / service-role escape, and **no** `SECURITY DEFINER` helper returns cross-tenant operational rows (ADR-0003 invariant holds).
15. **Given** the `0008` migration, **when** applied, **then** every table it touches/creates has RLS enabled with explicit policies (no table ships without policies).

### Block D — Tenant lifecycle
16. **Given** a super-admin, **when** they provision a tenant with a name + first-owner profile, **then** a `tenants` row (`status=active`), an owner `tenant_members` row, and an `audit_log` row (`action=tenant.provision`, actor=super-admin, target tenant) are created; the new tenant appears in the overview.
17. **Given** a non-super-admin caller, **when** they invoke `provision-tenant` / `suspend-tenant` / the reactivate path directly, **then** they receive 403 and nothing is written.
18. **Given** an active tenant, **when** a super-admin suspends it with a reason (≥5 chars), **then** `tenants.status='suspended'`, an `audit_log` row (`action=tenant.suspend`, reason in meta) is written, and the effect is **immediate** — members of that tenant fail `is_active_member()` on their **next request** (no waiting for token expiry).
19. **Given** a suspended tenant, **when** a super-admin reactivates it, **then** `tenants.status='active'`, an `audit_log` row (`action=tenant.reactivate`) is written, and its members regain access.
20. **Given** any lifecycle action, **when** it is attempted with a missing/invalid required field (e.g. blank reason, unknown tenant/owner), **then** it fails with a clear validation error and writes no partial state.

### Block E — Impersonation (completed flow)
21. **Given** a super-admin, **when** they start impersonation of an active tenant with a reason, **then** the server mints a **real** short-lived session whose claim carries `tenant_id=<target>`, `roles` (scalar) for that tenant, `is_super_admin=true`, `impersonator_id=<super-admin id>`, and `impersonation_exp`; the session becomes active in the browser.
22. **Given** an impersonation request targeting a **suspended** tenant, **when** submitted, **then** it is rejected (422) and no session is minted.
23. **Given** a requested TTL above `platform_settings.impersonation_max_ttl_seconds` (3600), **when** impersonation starts, **then** the effective TTL is clamped to the cap; the default when unspecified is 900s.
24. **Given** an active impersonation session, **when** any page renders, **then** a persistent, visually-unmistakable banner shows the impersonated tenant name, remaining time, and an **End impersonation** control (RTL, i18n strings, Arabic-Indic countdown digits).
25. **Given** an active impersonation, **when** any audited action occurs (e.g. session close, void, stock adjust, lifecycle), **then** the resulting `audit_log` row carries `impersonator_id` in `meta` (and the row's `tenant_id` is the impersonated tenant).
26. **Given** an active impersonation, **when** the super-admin clicks **End impersonation**, **then** an `audit_log` row (`action=impersonation.stop`) is written and the session reverts to the super-admin's own context (no impersonated `tenant_id`/`impersonator_id` in the subsequent claim).
27. **Given** an impersonation whose `impersonation_exp` has passed, **when** the token is refreshed, **then** the hook **drops** the impersonation sub-claims and reverts to the user's own super-admin context — impersonation never silently auto-extends past its window (fail-closed).
28. **Given** impersonation start and stop, **when** they occur, **then** both write `audit_log` rows (`impersonation.start` includes target tenant, expiry, ttl, reason; `impersonation.stop` includes the started-at/impersonator).
29. **Given** the impersonation flow end-to-end, **when** reviewed, **then** the browser/client bundle contains **no** service-role/secret key; the mint happens only server-side (edge function), and the client receives only a normal user session.

### Block F — Platform audit view
30. **Given** a super-admin, **when** they open the platform audit view, **then** audit rows across all tenants are listed, most-recent first, showing tenant, actor, action, amount (where present, via `formatEgp` + Arabic-Indic), and timestamp.
31. **Given** the audit view, **when** the super-admin filters by tenant / action / actor / date range, **then** only matching rows are shown; combined filters AND together; clearing restores the full set.
32. **Given** impersonation and lifecycle activity has occurred, **when** the super-admin filters action to `impersonation.start`/`impersonation.stop`/`tenant.*`, **then** those rows appear with their `meta` (reason, target, expiry) legible.

### Block G — Claim/hook reconciliation & residuals
33. **Given** the deployed `custom-access-token-hook`, **when** a user logs in or refreshes, **then** `app_metadata.tenant_id`/`roles`/`is_super_admin` are populated **dynamically** from `tenant_members`/`profiles` (not from static pre-set `app_metadata`) — verified by changing a membership and observing the claim update within one TTL.
34. **Given** the roles claim, **when** read by the hook (write), `current_role_in_tenant()` (DB), and the web client (read), **then** all three treat `roles` as the **same scalar-text** shape; no code path reads `roles` as an array, and an unexpected shape **fails closed** (treated as no role / least privilege).
35. **Given** a user removed from a tenant or whose role is downgraded, **when** their token next refreshes, **then** the new claim reflects the change (eventual consistency within one TTL) and immediate-effect cases (suspension, deactivation) are gated by `is_active_member()` regardless of token freshness.
36. **Given** the hook, **when** it constructs claims, **then** it writes only `app_metadata` (never `user_metadata`, request body, or header) and never grants `is_super_admin` to a user whose `profiles.is_platform_admin` is not true.

### Block H — Verification gate (definition of done)
37. **Given** the full change, **when** `ps-verify` runs, **then** `tsc --noEmit` (web + any touched workspace) = 0 errors, `jest` passes, and `next build` succeeds.
38. **Given** the security-sensitive surface, **when** the phase closes, **then** `security-reviewer` has signed off on the `0008` migration, the new policies, the completed impersonation mint, and the hook hardening; and `rls-tenant-audit` (Block C) passes (or is recorded "static pass — pending live verification" if hosted execution is deferred, consistent with prior phases).

---

## 7. Open questions (need ADR-0008 / design / human call)

**Architect (ADR-0008) — must decide before build:**
- **Q1 — Impersonation session representation.** Token-only (rely on `audit_log` start/stop + `impersonation_exp`, per ADR-0003) **vs.** a new `impersonation_sessions` table (active-session listing, pre-expiry revocation, "who is impersonating what right now"). If a table: its columns, RLS (super-admin-only), and lifecycle. Recommendation bias: minimal — only add the table if revocation/visibility requires it; otherwise stay token-only.
- **Q2 — How the real short-lived impersonation token is actually minted.** The current `impersonate-tenant` function only returns metadata. Pick the concrete Supabase mechanism (Admin API `generateLink`/admin-issued session, a service-role-signed short-TTL JWT carrying the impersonation claim, or admin sign-in-as-user + hook preservation) such that: TTL ≤ window, the claim is signed `app_metadata`, RLS enforces it, and no secret reaches the client. **Cite Supabase docs.**
- **Q3 — Roles claim-shape reconciliation (fail-closed).** Confirm scalar-text `roles` as canonical (hook + `current_role_in_tenant()` already scalar); specify how the web client reads it and how an array/legacy/unknown shape degrades to least privilege. Note: does any seed/static `app_metadata` need migrating off the array shape?
- **Q4 — Super-admin cross-tenant read policy shape.** Exactly which tables get a super-admin SELECT policy (`audit_log` certainly; `tenant_members`/`branches` for overview counts — or are counts served by a `security definer`/`security invoker` RPC instead of broad SELECT?). Keep the cross-tenant reach as narrow as possible; this ratifies the ADR-0003-deferred analytics-read item under tight scope.
- **Q5 — Hook deployment/enablement.** How/where the hook is registered (config vs. dashboard), and whether Phase-7 verification runs against hosted Supabase or remains "static pass — pending live verification" like Phases 2–6. The hook's impersonation-expiry hardening (AC 27) lands here.
- **Q6 — Reactivate path.** Reuse `suspend-tenant` generalized to a status setter, or add a dedicated `reactivate-tenant` function? (Audit action name + guard parity either way.)

**UX-designer — must design:**
- The `/admin` shell + platform overview (tenant table with status/health, search/filter), tenant detail, lifecycle dialogs (provision form, suspend/reactivate with reason), and the audit view (filters + table) — fresh RTL/Arabic-first via `ui-ux-pro-max` + magic MCP; loading/empty/error and "denied" states.
- The **impersonation banner** — must be unmistakable (color, persistence, countdown), accessible, RTL, with an always-reachable End control; plus the impersonation start dialog (target, reason, TTL within cap).

**Human call:**
- Approve the cross-tenant audit-read exception scope (Q4) and the impersonation mint mechanism (Q2) at the gate.
- Confirm whether hosted-Supabase live verification is in-scope for this gate or deferred to CI (affects AC 38 wording).

---

## 8. Hand-off

- **Architect:** write **ADR-0008** resolving Q1–Q6; the central calls are the **impersonation-token mint mechanism (Q2)**, the **super-admin cross-tenant read shape (Q4)**, and **impersonation-session representation (Q1)**. Author migration plan for `0008_*` (new super-admin read policies + optional `impersonation_sessions`). No operational-table policy may gain an `is_super_admin` bypass.
- **Backend:** apply `0008_*`; deploy + enable `custom-access-token-hook` (dynamic claims); harden it for impersonation-expiry revert (AC 27, AC 36); reconcile roles shape (AC 34); **complete** `impersonate-tenant` to mint a real short-lived session (AC 21, AC 29); add the reactivate path; ensure lifecycle + impersonation start/stop write `audit_log`; ensure impersonated audit rows stamp `impersonator_id` (AC 25).
- **Web:** `/admin` route + dual-layer role gate (AC 1–4); overview, tenant detail, lifecycle dialogs, impersonation start/banner/end, platform audit view with filters; reuse `formatEgp`/`toArabicDigits`; no service-role key in the bundle (AC 29).
- **UX-designer:** the screens + impersonation banner above.
- **security-reviewer (REQUIRED sign-off — release blocker):** owns Block C (`rls-tenant-audit` pgTAP must prove AC 9–15), the mint path (AC 29), the hook (AC 27, 36), and the cross-tenant read policy (AC 10–12). Any cross-tenant leak — direct or via impersonation — blocks the gate.
- **QA gates on:** Block C (isolation) and Block E (impersonation) as the hard gates; Blocks A/D/F/G as functional gates; Block H (`ps-verify` + sign-off) as the definition of done. Every acceptance criterion is observable; criteria 9–15, 21, 25–29 are the security-critical set.
- **Gate summary (for the human):** what was built (portal + lifecycle + impersonation + audit view + hook/claim residuals), test results (`ps-verify` + `rls-tenant-audit`), residual risks (live hosted verification status per Q5; any deferred cross-tenant analytics), and decisions needing approval (Q2, Q4). **Never auto-approve.**
