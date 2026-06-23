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

---

## 4. Money & time API conventions (`@ps/core`)

- `toPiastres(egp)` / `formatEGP(piastres)` / `toArabicDigits(s)` — never inline currency math in UI.
- Time helpers take explicit `Date`/ISO inputs and a timezone; they do not read the system clock internally (testability).
- Keep functions pure and unit-tested; target **>90% line coverage** on pricing/money/time/inventory.

---

## 5. Tenancy & security

- Every tenant-scoped table has an **indexed `tenant_id`** (and `branch_id` where relevant).
- **Enable RLS on every `public` table.** No table ships without policies.
- Tenant identity comes from a **trusted JWT claim in `app_metadata`** (set via a Supabase auth hook), resolved in policies — **never** from a client-supplied body/header.
- Writes use `WITH CHECK` so a user cannot insert/update rows into another tenant.
- The isolation model (shared-DB+RLS vs schema/DB-per-tenant) is decided by an **ADR** (`docs/adr/`) in Phase 2 before schema lands.
- **Tenant-isolation tests are mandatory:** prove tenant A cannot read or write tenant B's rows. `security-reviewer` signs off on every RLS change.
- Secrets live in `.env` (gitignored) and Supabase config — never committed. The super-admin impersonation path must be guarded and audited.

---

## 6. Stack & tooling

- **Monorepo** via npm workspaces: `packages/*`, `apps/*`.
- **TypeScript strict** everywhere; `noUncheckedIndexedAccess` on in core.
- **State (mobile):** Zustand (live state) + TanStack Query (server cache). **Offline:** outbox queue (sound idea reused from the trial, rebuilt for tenancy).
- **Design:** built fresh with the **`ui-ux-pro-max`** skill + the **21st.dev magic MCP** (`mcp__magic__*`) — not the trial's look. The `ux-designer` owns the design system in `docs/design/`. See `docs/reference/design-approach.md`.
- **Tests:** Jest (ts-jest) for `@ps/core` and unit logic; integration tests for full-shift flows.
- **Backend:** Supabase CLI for migrations; RLS in SQL; edge functions for auth hooks/webhooks.

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

- Roadmap & phases: `docs/ROADMAP.md`
- Backlog: `docs/BACKLOG.md`
- The team (org chart, ownership, handoffs): `docs/AGENTS.md`
- **Engineering handbook** (lessons distilled from the trial — read before building): `docs/reference/` — `core-api.md`, `schema-and-rls.md`, `mobile-patterns.md`, `design-approach.md`
- Architecture decisions: `docs/adr/`
- Trial app (read-only, for **lessons only — not a blueprint**, do not modify): `D:\K3\Pochinki`
