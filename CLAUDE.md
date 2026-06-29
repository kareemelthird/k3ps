# CLAUDE.md — PS-Managment

The shared knowledge base for everyone working in this repo, **human and agent**. Read it fully before writing code. The agent "company" treats these as hard rules.

---

## 1. What we are building

A **multi-tenant SaaS for gaming cafés** (PlayStation lounges). One platform, many independent café businesses, with tenancy, a branch layer, web surfaces, and a super-admin.

> The earlier single-café app (`Pochinki`) is a **trial — a learning input, not a blueprint.** We learn from it and reuse genuinely sound ideas (the money model, the pricing math, the offline-outbox concept), but we build PS-Managment **fresh, more advanced, and better**. We never copy its UI/design and never import its code.

**Tenancy hierarchy:**

```
Tenant (café business / owner account)
  └─ Branch (a physical location)        <-- NEW vs Pochinki
       └─ Devices (PS4/PS5/VIP), Staff, Shifts, Sessions, Orders, Products, Stock
```

**Surfaces:** `apps/mobile` (Expo — counter/manager) · `apps/web` (Next.js — owner dashboard + super-admin) · `packages/core` (pure logic) · `supabase` (Postgres + Auth + RLS).

**Roles:** `super_admin` (platform) > `owner` (a tenant) > `manager`/`staff` (a branch).

---

## 2. Non-negotiable rules

These caused real bugs in the trial or are core to trust in a cash business. Violating them fails review.

1. **Money is integer piastres.** 100 piastres = 1 EGP. Never use floats for money. Round once per segment, never accumulate rounding. All money helpers live in `@ps/core`.
2. **Timers derive from timestamps.** Never trust `setInterval`/elapsed counters for billing. Store UTC `started_at`; compute elapsed at render from the clock. A backgrounded app or dropped network must never corrupt a bill.
3. **Timezone is Africa/Cairo** for all business-day logic (weekday/weekend, peak windows). Store UTC, convert with dayjs Cairo plugin. Egypt weekend = **Friday/Saturday**.
4. **`@ps/core` is pure.** No imports from React, React Native, Expo, Next.js, or Supabase. It must run in plain Node under Jest. No `Date.now()` *inside* cost math — pass timestamps in as arguments.
5. **RLS on every table.** Tenant isolation is enforced in Postgres, not just the app. See §5.
6. **Arabic-first, RTL.** All user-facing strings come from i18n resources, never hardcoded. Numerals display as Arabic-Indic where the trial did.
7. **Auditable money.** Every money-affecting action (session close, void, refund, shift close, stock adjust, debt) writes an `audit_log` row with actor, tenant, timestamp, amount.
8. **Idempotent writes.** Client generates UUIDs; mutations upsert. Offline queue must survive crashes without double-counting.

---

## 3. The pricing model (the café business — rebuilt cleanly, informed by the trial)

Three billing modes, all driven by owner-configured **rate rules** (per device type / play mode / day type / time window / priority):

- **Open meter** — cost = billable minutes × resolved hourly rate, with rounding + min-charge.
- **Prepaid** — pay for a block upfront; price is **locked** at purchase (rate changes mid-session do not re-price).
- **Fixed match** — cost = match count × fixed price.

A session is split into **segments**; switching single↔multi or crossing a peak boundary closes the current segment (freezing its rate snapshot) and opens a new one. `grand_total = Σ segment costs + Σ order items − discount`. Every bill must be reconstructible from stored snapshots.

> The trial at `D:\K3\Pochinki\src\pricing\` is a **learning reference** for these (sound) algorithms and their invariants. Re-derive them in `packages/core/src/pricing` with a fresh, cleaner API and improvements — never import from the trial. See the `learn-from-trial` skill and `docs/reference/core-api.md`.

**SaaS billing layer (Phase 9):** in addition to per-session café billing (EGP piastres), the platform has a Stripe subscription tier system for the SaaS product itself. Tenant plan + status are resolved by `@ps/core/entitlements` (pure helper, "now" as argument); the UI enforces `isReadOnly` when a subscription lapses. Stripe secret keys and the webhook signing secret are **server-only** (edge functions); the client only receives server-minted redirect URLs. All live in Stripe test-mode until the owner supplies live keys.

---

## 4. Money & time API conventions (`@ps/core`)

- `toPiastres(egp)` / `formatEGP(piastres)` / `toArabicDigits(s)` — never inline currency math in UI.
- Time helpers take explicit `Date`/ISO inputs and a timezone; they do not read the system clock internally (testability).
- Keep functions pure and unit-tested; target **>90% line coverage** on pricing/money/time/inventory.
- `@ps/core/entitlements` — `resolveEntitlements(plan, status, nowIso)` — pure, "now" as argument, no `Date.now()`.
- `@ps/core/observability` — `scrubEvent`/`scrubBreadcrumb` — the Sentry scrubber; pure, no `@sentry/*` import, never throws. Both apps' `beforeSend`/`beforeBreadcrumb` delegate here.

---

## 5. Tenancy & security

- Every tenant-scoped table has an **indexed `tenant_id`** (and `branch_id` where relevant).
- **Enable RLS on every `public` table.** No table ships without policies.
- Tenant identity comes from a **trusted JWT claim in `app_metadata`** (set via the `custom-access-token` Supabase auth hook), resolved via `current_tenant_id()` SECURITY DEFINER helper — **never** from a client-supplied body/header.
- Writes use `WITH CHECK` so a user cannot insert/update rows into another tenant.
- Isolation model decided in [ADR-0002](docs/adr/0002-tenant-isolation-model-ratified.md): **shared-DB + `tenant_id` + RLS**. Proven by the live pgTAP isolation suite (`supabase/tests/01–07`).
- **Tenant-isolation tests are mandatory:** prove tenant A cannot read or write tenant B's rows. `security-reviewer` signs off on every RLS change.
- Secrets live in `.env` (gitignored) and Supabase/EAS config — never committed. The repo is **public**; rotate any key ever exposed in history.
- **Super-admin impersonation** (Phase 7): server-minted, time-boxed, fully audited. The impersonation session stamps `meta.impersonator_id` on every `audit_log` row via the `stamp_impersonator()` BEFORE INSERT trigger. No `OR is_super_admin()` bypass on operational write policies.
- **`close_session_tx` and `audit_config_change()` are SECURITY INVOKER** — functions that also write to `audit_log` must be `SECURITY INVOKER` + carry their own tenant/member guard, not use `SECURITY DEFINER` as a shortcut (see `docs/reference/schema-and-rls.md` for the full lesson).
- **Observability (Phase 10):** Sentry is DSN-gated (no-op when `NEXT_PUBLIC_SENTRY_DSN`/`EXPO_PUBLIC_SENTRY_DSN` are absent). The `@ps/core/observability` scrubber enforces a deny-by-default policy: no JWT/token, email/PII, Stripe secret, `.env` value, or raw money row ever reaches Sentry. Only `tenant_id`/`role`/`release`/`environment`/`route`/`screen` tags are allowed. `SENTRY_AUTH_TOKEN` is server/CI-only, never committed.

---

## 6. Stack & tooling

- **Monorepo** via npm workspaces: `packages/*`, `apps/*`.
- **TypeScript strict** everywhere; `noUncheckedIndexedAccess` on in core.
- **State (mobile):** Zustand (live state) + TanStack Query (server cache). **Offline:** `@ps/core/outbox` state machine + crash-safe AsyncStorage persistence + dependency-ordered drain + dead-letter; every mutation goes through `persistRow`. Realtime invalidation via tenant-scoped `postgres_changes` subscription.
- **Design:** built fresh with the **`ui-ux-pro-max`** skill + the **21st.dev magic MCP** (`mcp__magic__*`) — not the trial's look. The `ux-designer` owns the design system in `docs/design/`. See `docs/reference/design-approach.md`.
- **Tests:** Jest (ts-jest) for `@ps/core` (493 tests) and unit logic; pgTAP for Supabase isolation (`supabase/tests/01–07`).
- **Backend:** Supabase CLI for migrations; RLS in SQL; edge functions for auth hooks, Stripe webhooks, billing session management.
- **Observability:** Sentry (web: Next.js instrumentation files; mobile: `@sentry/react-native`), both DSN-gated and delegating to `@ps/core/observability` for scrubbing.
- **Mobile distribution:** `apps/mobile/eas.json` — three EAS build profiles (`development`/`preview`/`production`); cloud builds are a user step; local `expo export` is CI-verified.
- **A11y:** `eslint-plugin-jsx-a11y` (recommended) in web lint; manual checklist for focus management, contrast, and safety-critical surfaces. Mobile: `accessibilityLabel`/`accessibilityRole` + 44 pt touch targets.

---

## 7. Verification — definition of "done"

A change is not done until the **`ps-verify`** skill passes:

1. `tsc --noEmit` across all workspaces — **0 errors**.
2. `jest` — all unit + integration tests pass.
3. `expo export` (mobile) — bundle graph builds.
4. `next build` (web) — production build succeeds.

Plus, where relevant: tenant-isolation tests (`rls-tenant-audit`), pricing invariants (`pricing-engine-guard`), and RTL/i18n coverage (`rtl-i18n-check`).

---

## 8. The agent-workflow contract

Work flows through a fixed pipeline (see `.claude/workflows/feature.js` and `docs/AGENTS.md`):

> **spec → design → build (parallel, isolated) → test → review (adversarial) → debate/reconcile → HUMAN APPROVES**

Rules for agents:

- **Stay in your lane.** Each agent owns specific paths/skills (see `docs/AGENTS.md`). Don't edit another agent's area without handing off.
- **Learn, don't replicate.** Search `packages/core` and existing code first to reuse what *we've* built. Treat the Pochinki trial as a learning input (sound ideas worth reusing-and-improving) — never a blueprint to copy and never a dependency (`learn-from-trial` skill).
- **Cite sources** when you use web research to make a decision; record hard decisions as an ADR.
- **Findings must be verified.** Reviewer claims are adversarially checked before they become work.
- **Never auto-approve.** The human (project owner) approves at the end of each phase. Agents prepare a concise gate summary: what was built, test results, residual risks, and any decisions needing a human.
- **Conventional commits**; one logical change per commit; never commit secrets.

---

## 9. Pointers

- Roadmap & phases (all 10 done): `docs/ROADMAP.md`
- Backlog (operator actions + future/deferred): `docs/BACKLOG.md`
- The team (org chart, ownership, handoffs): `docs/AGENTS.md`
- **Engineering handbook** (read before building or reviewing): `docs/reference/`
  - `core-api.md` — `@ps/core` API: money/time/pricing/outbox/entitlements/observability scrubber
  - `schema-and-rls.md` — schema shape, RLS model, migration sequence, audit-trigger lessons, pgTAP suite
  - `mobile-patterns.md` — offline outbox, realtime, Sentry init, EAS build, virtualization, a11y
  - `design-approach.md` — design engine, product UX truths, trial lessons
- Architecture decisions (ADR index): `docs/adr/README.md` (ADR-0001 through ADR-0011)
- Trial app (read-only, for **lessons only — not a blueprint**, do not modify): `D:\K3\Pochinki`
