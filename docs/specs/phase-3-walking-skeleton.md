# Spec — Phase 3: Walking Skeleton (thin end-to-end vertical slice)

- **Phase:** 3 (Roadmap `docs/ROADMAP.md`) · **Surfaces:** `apps/mobile` (Expo, counter), `apps/web` (Next.js, owner read view), `packages/core` (consume only), `supabase` (hosted dev project)
- **Owner:** product-manager · **Status:** ready for design/build
- **Decision anchors:** [ADR-0002 — isolation model](../adr/0002-tenant-isolation-model-ratified.md) (ACCEPTED) · [ADR-0003 — JWT claim, freshness, impersonation](../adr/0003-auth-claim-and-impersonation-model.md) (Proposed) · [ADR-0004 — schema scoping & keys](../adr/0004-tenant-schema-scoping-and-keys.md) (Proposed)
- **Builds on:** [Phase 2 spec](phase-2-tenant-foundation.md) — `@ps/core` + the multi-tenant Supabase foundation (schema, RLS, claim hook, seed) authored in `supabase/`.
- **References:** `docs/reference/mobile-patterns.md`, `docs/reference/design-approach.md`, `docs/reference/schema-and-rls.md`, `docs/reference/core-api.md`, `CLAUDE.md` §1/§2/§5/§6/§7
- **Trial (learning input only — never import/copy):** `D:\K3\Pochinki` (`src/features/devices`, `src/features/sessions`, `src/features/auth`)

---

## 1. Problem & goal

Phase 2 produced two correct-but-headless foundations: a pure `@ps/core` and an authored multi-tenant Supabase backend whose isolation was only **statically** audited (no Docker on the build machine). Nothing has yet proven the **whole stack runs together** against a **real** database with **real** auth.

Phase 3 is the **walking skeleton**: the thinnest possible end-to-end slice that exercises every layer once — Supabase Auth → signed JWT tenant claim → RLS-scoped reads → a mutating session lifecycle that uses `@ps/core` math and writes an audit row — on **both** surfaces (the Expo counter app and the Next.js owner read view), against a **hosted** Supabase dev project with **real login**.

The point is **integration confidence, not feature depth.** We prove: login works on both surfaces; the tenant claim resolves the active tenant/branch; a user of tenant A can never see tenant B's devices or sessions through a live database; a counter operator can start and close one open-meter session correctly (time computed by `@ps/core`, device freed, audit row written); and an owner can watch device/session state from the web. Everything richer (pricing rules, orders, shifts, prepaid/fixed-match, offline hardening, the super-admin portal) is deferred.

**The win:** a deployable, login-gated, tenant-isolated slice that turns Phase 2's "static pass — pending live verification" into a **live-verified** spine the rest of the roadmap hangs on. This is also the first execution of the Phase-2 RLS/claim work against a real Postgres, so it doubles as the deferred live verification of ADR-0002/0003/0004.

**Roles touched:** `owner` (tenant; web read + may operate on mobile), `manager`/`staff` (branch; mobile counter operator). `super_admin` is **out of scope** for this phase (Phase 7).

---

## 2. In scope / out of scope

### In scope

**Backend / environment**
- Wire a **hosted Supabase dev project**: apply the Phase-2 migrations (`supabase/migrations/0001..0005`), deploy the Custom Access Token Hook (`supabase/functions/custom-access-token-hook`) and register it as the access-token hook, load `supabase/seed.sql` (tenants Alpha/Bravo, branches, devices, members).
- Create **real auth users** with passwords for the seeded members (owner.alpha, manager.alpha, owner.bravo, manager.bravo) so login is exercised for real.
- **Live-verify** the deferred Phase-2 isolation items (ADR-0002 AC 32–35) against the hosted DB as a by-product of the slice (see AC G).

**Auth (both surfaces)**
- Email/password sign-in via Supabase Auth; sign-out; session persistence/restore on app launch / page reload.
- Resolve identity from the **signed `app_metadata` claim** (`tenant_id`, `roles`, `is_super_admin`) per ADR-0003 — never from client input or a `profiles` hot-path lookup.
- Resolve the active tenant + role; resolve the user's branches from `tenant_members`/`branches` (RLS-scoped).

**Branch selection (both surfaces)**
- If the active tenant has exactly one branch, auto-select it. If it has multiple, present a **branch switcher**; persist the active branch locally (per device/session). Devices/sessions render only for the active tenant + active branch.

**Devices (mobile + web)**
- List devices for the active tenant/branch from the `devices` table (RLS-scoped), showing **free / busy** status (maintenance shown but not actionable). Web may be **read-only**.

**Start session (mobile only)**
- Tapping a **free** device creates: one `sessions` row (`billing_mode='open'`, `status='active'`, `started_at = nowIso()`, `manager_id = auth.uid()`, the active `branch_id`/`tenant_id`) **+** one first `session_segments` row (snapshot of the resolved open-meter rate is acceptable but a flat snapshot is fine for the skeleton) **+** sets the device `status='busy'`.
- **Idempotent:** the session/segment ids are **client-generated UUIDs** (`@ps/core uuidv4`) and writes are **upserts**, so a retry/double-tap cannot create two sessions for one device (also guarded by the Phase-2 partial unique index `(tenant_id, device_id) where status='active'`).

**Close session (mobile only)**
- Compute `time_total` via `@ps/core` open-meter math from `started_at` to `nowIso()` (elapsed minutes → cost with the segment's rate, rounding/min-charge from the rule). Set `grand_total = time_total` (no orders/discount this phase), set `ended_at`, set `status='closed'`, free the device (`status='free'`), and write an `audit_log` row (`action='session.close'`, actor, tenant, branch, amount).

**Owner web read view**
- After login (+ branch select), an owner sees a **read-only** list of current/recent sessions and live device states for the active tenant/branch. No mutations from web this phase.

**Design**
- Fresh UX for the above screens via the `ui-ux-pro-max` skill + 21st.dev magic MCP — Arabic-first/RTL, Arabic-Indic numerals where the trial displayed them. **Not** the trial's look.

**Web shell**
- Built **fresh** under `apps/web` (Next.js). The existing `wip/web-scaffold` branch is **not** used.

### Out of scope (deferred — and why)
- **Pricing rate-rule editor / full pricing engine** (`resolveRule`, segments across peak/play-mode boundaries, prepaid, fixed-match) → **Phase 4**. The skeleton uses **open-meter only** and a single rate snapshot; no rule editing.
- **Products / orders / order builder / inventory ledger writes** → **Phase 5**. `grand_total = time_total`; no order items.
- **Shifts / cash drawer / reconciliation** → **Phase 5**. Sessions may run with `shift_id = null`.
- **Prepaid & fixed-match billing modes** → **Phase 4**. Only `billing_mode='open'`.
- **Offline outbox hardening, dead-letter, realtime sync UI** → **Phase 8**. The skeleton may assume connectivity; idempotent client-UUID upserts are required now, but full offline queue resilience is not.
- **Super-admin portal & impersonation UX** → **Phase 7**. No impersonation path is exercised on these surfaces this phase.
- **Owner web write actions, KPIs, charts, reports, CSV** → **Phase 6**. Web is read-only.
- **Tenant switching across multiple tenants** (one human in 2+ tenants). The Phase-2 hook stamps the *first active* tenant (placeholder). Multi-tenant switching is **out of scope**; only **branch** switching within the single active tenant is in scope (see Open Question 1).
- **SaaS billing / paywall** → **Phase 9**.

---

## 3. User stories

- **As an `owner`**, I want to sign in on the web with my email/password and see my tenant's live device states and current/recent sessions for a branch, so that I can check on my café without standing at the counter.
- **As a `manager`/`staff` operator**, I want to sign in on the mobile app and see the devices for my branch as free/busy, so that I know what's available at a glance.
- **As a `manager`/`staff` operator**, I want to tap a free device to start an open session and later close it to get a correct total, so that I can run the floor and bill a customer for time played.
- **As an `owner`/`manager`/`staff` belonging to a multi-branch tenant**, I want to pick which branch I'm operating, so that I only see and act on that location's devices.
- **As any signed-in user**, I want my tenant resolved from a trusted token claim, so that I can never accidentally (or maliciously) see or touch another café's data.
- **As an `owner`**, I want to sign out on either surface, so that my session does not stay open on a shared machine.
- **As `security-reviewer`**, I want the live hosted DB to prove tenant A cannot read or write tenant B's devices/sessions, so that ADR-0002/0003/0004 graduate from "static pass" to live-verified.

---

## 4. Acceptance criteria (numbered, testable — Given/When/Then)

### A. Auth (both surfaces)
1. **Given** a registered user with a valid email/password, **when** they submit the sign-in form on **mobile**, **then** a Supabase session is established and the app navigates to the device/branch surface; invalid credentials show an error and do **not** navigate.
2. **Given** a registered user with a valid email/password, **when** they submit the sign-in form on **web**, **then** a Supabase session is established and the page renders the owner read view; invalid credentials show an error and do **not** render protected data.
3. **Given** a signed-in user, **when** they reload the web page or relaunch the mobile app, **then** the session is restored from persisted storage without re-entering credentials (until expiry/sign-out).
4. **Given** a signed-in user, **when** they tap/click **Sign out** on either surface, **then** the Supabase session is cleared, protected screens are no longer reachable, and they are returned to the sign-in screen.
5. **Given** an unauthenticated visitor, **when** they attempt to reach any protected route directly (deep link / URL), **then** they are redirected to sign-in and no tenant data is fetched or rendered.

### B. Claim & active tenant/branch resolution
6. **Given** a successful sign-in, **when** the access token is inspected, **then** `app_metadata` carries a scalar `tenant_id`, a `roles` value, and `is_super_admin` (per ADR-0003), and the app reads tenant/role **from the claim** — never from a client-supplied value or a `profiles` table read in the auth hot path.
7. **Given** a user whose active tenant has **exactly one** branch, **when** they sign in, **then** that branch is auto-selected and the device list renders for it without a switcher prompt.
8. **Given** a user whose active tenant has **two or more** branches (e.g. seeded tenant Alpha), **when** they sign in, **then** a branch switcher is shown listing only that tenant's branches, and no device list renders until a branch is chosen.
9. **Given** a user picks a branch, **when** they reload/relaunch, **then** the previously chosen active branch is restored from local persistence (and remains changeable via the switcher).
10. **Given** the branches list, **when** it is fetched, **then** it contains **only** branches of the user's active tenant (RLS-scoped); no branch of another tenant ever appears.

### C. Devices listing (both surfaces)
11. **Given** a signed-in user with an active branch, **when** the device list loads on mobile, **then** it shows that branch's devices with a clear **free / busy** state (and maintenance distinctly), ordered by `sort_order`, sourced from the `devices` table.
12. **Given** the same user, **when** the device list loads on web, **then** it shows the same devices and states for the active tenant/branch, **read-only** (no start/close controls).
13. **Given** a device is set `busy` by an active session, **when** either surface refreshes, **then** that device renders as busy on both; when the session closes, it renders as free on both (refresh interval per `mobile-patterns.md`, e.g. 15–30s grid refresh; no realtime required this phase).

### D. Tenant isolation (live, hosted DB) — the trust gate
14. **Given** a signed-in **tenant-A** user (e.g. manager.alpha), **when** the device list loads, **then** it contains **only** tenant-A devices; **no** tenant-B device (`PS5 Bravo 1` / `PS4 Bravo 2`) is ever returned or rendered.
15. **Given** a signed-in tenant-A user, **when** the session/device read queries run against the hosted DB, **then** **zero** tenant-B `sessions`, `session_segments`, or `devices` rows are returned (RLS `SELECT` isolation, verified live).
16. **Given** a tenant-A user, **when** a start/close mutation is attempted with a `tenant_id` or `branch_id` belonging to tenant B (forced via a tampered request), **then** the write is **rejected** by RLS `WITH CHECK` (no row created/updated), not silently re-scoped.
17. **Given** a tenant-A user, **when** any session they create is inspected, **then** its `tenant_id` equals the claim tenant and its `branch_id` belongs to that tenant (composite-FK consistency from ADR-0004 holds live).

### E. Start session (mobile)
18. **Given** a **free** device and a signed-in operator with an active branch, **when** they tap to start a session, **then** exactly one `sessions` row is created (`billing_mode='open'`, `status='active'`, `started_at` set to a UTC ISO timestamp, `manager_id = auth.uid()`, correct `tenant_id`/`branch_id`) **and** one `session_segments` row **and** the device flips to `busy`.
19. **Given** the start action is submitted twice (double-tap / retry with the **same** client-generated UUIDs), **when** both reach the server, **then** only **one** active session exists for that device (idempotent upsert + the `(tenant_id, device_id) where status='active'` partial unique index prevents a duplicate).
20. **Given** a device that is already `busy` (or in maintenance), **when** an operator tries to start a session on it, **then** the action is unavailable/blocked and no second active session is created.
21. **Given** a started session, **when** the device card is viewed, **then** elapsed time is derived from `started_at` via `@ps/core` (`elapsedSeconds`/`formatClock`), **not** from a `setInterval` counter (a backgrounded app must not corrupt elapsed time — CLAUDE.md §2.2).

### F. Close session (mobile) — correctness gate
22. **Given** an active open-meter session started at a known `started_at`, **when** it is closed at a known `now`, **then** `time_total` equals the value computed by `@ps/core` open-meter math for `elapsedMinutes(started_at, now)` at the segment's snapshot rate with the rule's rounding/min-charge — computed in `@ps/core`, with **no float money** and **no `Date.now()` inside the cost math** (timestamps passed in).
23. **Given** the close completes, **when** the session row is read, **then** `status='closed'`, `ended_at` is set, `grand_total = time_total` (no orders/discount this phase), and `grand_total >= 0`.
24. **Given** the close completes, **when** the device is read, **then** its `status` is back to `free` and it is startable again.
25. **Given** the close completes, **when** the `audit_log` is read, **then** exactly one row exists for this close with `action='session.close'`, the actor (`auth.uid()`), the `tenant_id` (and `branch_id`), a timestamp, and `amount = grand_total` (CLAUDE.md §2.7).
26. **Given** money/time are displayed in the close summary, **when** rendered, **then** currency uses `@ps/core formatEgp` and displayed digits use Arabic-Indic where the trial did (`toArabicDigits`) — no hardcoded currency math or strings (CLAUDE.md §2.6, §6).

### G. Live verification of deferred Phase-2 isolation
27. **Given** the hosted DB with Phase-2 migrations + seed applied, **when** the `rls-tenant-audit` suite (`supabase/tests/01_tenant_isolation.test.sql`) is executed **live** against it, **then** ADR-0002 AC 32–35 pass (A↮B SELECT/INSERT/UPDATE/DELETE isolation across every tenant-scoped table, including child tables via parent `EXISTS`), graduating the Phase-2 verdict from "static pass" to **live-verified**.
28. **Given** the Custom Access Token Hook is deployed and registered, **when** a real user signs in, **then** the issued token's `app_metadata.tenant_id`/`roles`/`is_super_admin` are populated from `tenant_members`/`profiles` (not `user_metadata` or request input), confirming the hook works live.

### H. RTL / i18n & verification
29. **Given** every user-facing string on the new screens, **when** inspected, **then** it comes from i18n resources (Arabic-first), with RTL layout (start/end spacing, `row-reverse`), and no hardcoded user strings (CLAUDE.md §2.6).
30. **Given** the completed work, **when** `ps-verify` runs, **then** `tsc --noEmit` passes with **0 errors** across `@ps/core`, `apps/mobile`, `apps/web`; `jest` passes; `expo export` builds the mobile bundle; `next build` produces a successful web production build (CLAUDE.md §7).

---

## 5. Domain notes (links to `CLAUDE.md` / ADRs)

- **Tenant identity from the signed `app_metadata` claim; RLS on every table; `WITH CHECK` on writes; isolation tests mandatory** (`CLAUDE.md` §5; ADR-0002; ADR-0003) — AC 6, 14–17, 27–28. Branch is an ordinary FK filter **within** a tenant, **not** a second isolation boundary (ADR-0004) — branch scoping in the UI is convenience/own-scope, never the isolation surface.
- **Money is integer piastres; no floats; helpers in `@ps/core`** (`§2.1`, `§4`) — AC 22, 23, 26.
- **Timers/time derive from timestamps; store UTC `started_at`; compute elapsed at render; Africa/Cairo for day logic** (`§2.2`, `§2.3`) — AC 18, 21, 22. A backgrounded/offline app must never corrupt a bill.
- **`@ps/core` is pure; no `Date.now()` in cost math** (`§2.4`) — AC 22. The surfaces pass `nowIso()` into core; core never reads the clock for cost.
- **Auditable money** — every session close writes an `audit_log` row (`§2.7`) — AC 25.
- **Idempotent writes; client UUIDs; upsert** (`§2.8`; `mobile-patterns.md` outbox idempotency) — AC 18, 19. Multi-row start (session + segment + device-busy) is queued/applied together.
- **Arabic-first / RTL; i18n resources; Arabic-Indic numerals** (`§2.6`; `mobile-patterns.md` i18n) — AC 26, 29.
- **Schema shapes** (ADR-0004): `sessions`/`session_segments`/`devices` carry `tenant_id`; the five physically-located tables (incl. `devices`, `sessions`) carry `branch_id not null`; `billing_mode='open'`; `payment_method` enum is `cash|wallet|other|debt` (inert here) — AC 17, 18.
- **Definition of done = `ps-verify` green + acceptance criteria + `security-reviewer` sign-off on the live RLS verification** (`§7`, `§8`) — AC 27, 30.

---

## 6. Open questions

1. **Active-tenant selection when a user belongs to multiple tenants.** The Phase-2 hook stamps the *first active* membership (`limit(1)`, ordered by `created_at`) as a placeholder. Phase 3 scopes only **branch** switching within a single active tenant. Confirm: do any seeded/real users belong to >1 tenant in this phase? If yes, what is the intended default and is a tenant switcher (refresh-to-re-mint, per ADR-0003 Option 1A) in or out of Phase 3? → **architect** (claim/refresh contract) · likely **defer multi-tenant switch to a later phase**.
2. **Branch persistence scope.** Active branch is persisted locally (per device/session) in Phase 3. Should it ever be persisted server-side (e.g. a `tenant_members.last_branch_id`)? → **architect/backend** (low risk; local-only is acceptable for the skeleton).
3. **First-segment rate snapshot for the skeleton.** Phase 4 owns full rule resolution/segments. For Phase 3 open-meter, do we (a) resolve the single applicable open rate rule from seed and snapshot it onto the first segment, or (b) snapshot a flat configured rate? Either keeps the bill reconstructible; confirm which to avoid leaking Phase-4 pricing logic into Phase 3. → **architect + product-manager**; recommend (a) using a minimal "resolve the one open rule for this device_type" lookup, with full `resolveRule` deferred to Phase 4.
4. **Hosted Supabase project ownership & secrets.** Who owns the hosted dev project, and where do `apps/web`/`apps/mobile` read `SUPABASE_URL`/anon key from (`.env`, gitignored)? Service-role key for the hook stays server-side only. → **human + architect/backend**.
5. **Real auth-user provisioning.** The seed documents placeholder user UUIDs; live login needs real passworded users. Are these created via a seeding script / Supabase dashboard, and what are the dev credentials? → **backend + human**.
6. **Web auth pattern (Next.js).** Client-side Supabase session vs. server components with cookie-based session (`@supabase/ssr`). The choice affects the read-view data path and how RLS is enforced on the server. → **architect** (web auth ADR or design note).
7. **Maintenance-state handling.** Devices can be `maintenance`. The skeleton shows it as non-actionable; confirm no maintenance toggle is in scope this phase (it is device CRUD → Phase 4). → **product-manager** (assume out of scope).

---

## 7. Hand-off

### architect must decide
- **Web auth pattern** (Open Q6): client Supabase vs. `@supabase/ssr` cookie sessions for the Next.js read view, and how RLS is enforced on server-rendered reads. Blocks web build.
- **Active-tenant scope for Phase 3** (Open Q1): confirm single-active-tenant + branch-only switching; defer multi-tenant switching or define the refresh-to-re-mint contract per ADR-0003.
- **First-segment rate snapshot approach** (Open Q3): the minimal open-rate lookup vs. flat snapshot, drawing the line so Phase-4 pricing logic does not leak in.
- **Branch persistence** (Open Q2): local-only vs. server-side last-branch.
- Confirm the hosted-project wiring contract (env var names, where the anon/service keys live) with backend (Open Q4).

### ux-designer must design (fresh, via `ui-ux-pro-max` + magic MCP — not the trial's look)
- **Mobile:** sign-in screen; branch switcher; device grid/list with free/busy/maintenance states; start-session affordance on a free device; live session card (timestamp-derived elapsed + live cost); close-session confirmation + summary (EGP via `formatEgp`, Arabic-Indic digits); sign-out; empty/loading(skeleton)/error states (per `mobile-patterns.md` component kit). Arabic-first/RTL.
- **Web:** sign-in; branch switcher; read-only device-state list + current/recent sessions list; sign-out; empty/loading/error states. Arabic-first/RTL.
- All strings via i18n resources; no hardcoded copy.

### engineers build
- **backend / supabase-migrate:** wire the **hosted** dev project — apply migrations `0001..0005`, deploy + register the `custom-access-token-hook`, load `seed.sql`, create real passworded auth users for the seeded members; run the live `rls-tenant-audit` suite (AC 27); document env wiring (AC G, Open Q4/Q5).
- **core (consume only):** no new `@ps/core` code expected beyond what Phase 2 shipped; if the open-meter compute helper the close path needs is not already exposed, expose a minimal pure helper (timestamps-in, piastres-out) — **no** `Date.now()` in cost math, **no** floats (AC 22).
- **mobile engineer:** Expo app — auth (sign-in/out/restore), claim-driven tenant/role + branch resolution + switcher (persisted), device list (free/busy), start session (idempotent multi-row write with client UUIDs), close session (core compute → set totals → free device → audit row), timestamp-derived live timer, RTL/i18n.
- **web engineer:** fresh Next.js `apps/web` — auth (sign-in/out/restore), claim-driven tenant/role + branch resolution + switcher, **read-only** device-state + sessions list, RTL/i18n. Not the `wip/web-scaffold` branch.

### QA gates on (the testable success checks)
- **Auth & routing:** AC 1–5 on both surfaces.
- **Claim & branch resolution:** AC 6–10.
- **Devices both-surface:** AC 11–13.
- **Tenant isolation (live, the trust gate):** AC 14–17 + the live `rls-tenant-audit` run AC 27–28 — `security-reviewer` signs off; this is the criterion that graduates Phase 2 from "static pass" to live-verified.
- **Start session correctness + idempotency:** AC 18–21.
- **Close session correctness (core time_total, device freed, audit row):** AC 22–26.
- **RTL/i18n + full `ps-verify`** (tsc, jest, `expo export`, `next build`): AC 29–30.
- Residual-risk note for the human gate: offline resilience is intentionally thin (Phase 8); only open-meter is exercised (Phase 4); web is read-only (Phase 6); multi-tenant switching deferred.
