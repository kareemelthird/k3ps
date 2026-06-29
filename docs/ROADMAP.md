# Roadmap

Built phase by phase. Each phase runs through the `feature` workflow and ends at a **human approval gate** before the next begins. Localization is Arabic-first/EGP (like Pochinki); multi-currency/i18n generalization is deferred.

> **Current status (2026-06-29):** All 10 phases built and verified. `ps-verify` green across all three workspaces: `tsc --noEmit` 0 errors, 493 `@ps/core` Jest tests passing, `next build` all routes ≤ 300 kB First-Load JS, `expo export` clean. Live pgTAP isolation suite `01–07` passing in CI. The platform is **feature-complete** and pending the owner's hands-on test and live-account setup (Sentry DSN, EAS build, Stripe live keys, Supabase auth hook deployment, Realtime publication — see `docs/BACKLOG.md` for the operator checklist).

| Phase | Goal | Surfaces | Status |
| --- | --- | --- | --- |
| **1. The factory** | Agent team + workflows + skills + monorepo scaffolding + CLAUDE.md | — | ✅ done |
| **2. Tenant foundation** | ADR on isolation model; Supabase schema with `tenant_id`+`branch_id`; auth + JWT claim; multi-tenant RLS; super-admin tenant provisioning; build `@ps/core` (money/time/inventory/types) | core, backend | ✅ done |
| **3. Walking skeleton** | Thin end-to-end slice: login → tenant → branch → device → start/close one session, on mobile + web | all | ✅ done |
| **4. Devices + Sessions + Pricing** | Pricing engine in `@ps/core`; live device grid; session lifecycle + segments (open/prepaid/fixed-match) | core, backend, mobile | ✅ done |
| **5. Products + Orders + Inventory + Shifts** | Catalog, order builder, stock ledger, walk-ins, shift open/close + cash reconciliation | core, backend, mobile | ✅ done |
| **6. Owner web dashboard + Reports** | KPIs, charts, reports by date/device/product, CSV export | backend, web | ✅ done |
| **7. Super-admin portal** | Tenant lifecycle, support tools, guarded+audited impersonation | backend, web | ✅ done |
| **8. Offline-first hardening** | Port/harden the outbox + realtime for multi-tenant; dead-letter + sync UI | core, backend, mobile | ✅ done |
| **9. SaaS billing** | Stripe subscriptions, trial → tiers, paywall, super-admin plan management | backend, web | ✅ done |
| **10. Production hardening** | Sentry observability (DSN-gated, core scrubber), audit-atomicity trigger, EAS build profiles, perf/a11y/security pass | all | ✅ done |

## Phase 10 — Production hardening — ✅ APPROVED / done
> Spec: [`docs/specs/phase-10-production-hardening.md`](specs/phase-10-production-hardening.md) · Decision: [ADR-0011](adr/0011-production-hardening-observability.md) · Anchors: [CLAUDE.md §2.7](../CLAUDE.md) (auditable money — **this phase completes the invariant** platform-wide), §5 (RLS/tenant isolation + no secret committed), §2.4 (`@ps/core` stays pure; scrubber follows purity), §7 (`ps-verify` green with and without Sentry/Expo secrets).
> Status (2026-06-29): DSN-gated Sentry observability wired on web + mobile; pure `@ps/core/observability` scrubber (deny-by-default `beforeSend`/`beforeBreadcrumb`, `SAFE_TAG_KEYS` allowlist, >90% coverage with adversarial-payload tests); audit-completeness trigger `audit_config_change()` lands in **migration `0012`** (ADR-0011 named it `0011` but that slot was occupied by `0011_cap_reactivation_fix.sql`); `audit_log_entity_idx` added; `eas.json` three-profile build config; ESLint `jsx-a11y` + manual a11y pass; perf pass (dynamic imports, list virtualization); full security sweep and `security-reviewer` sign-off. `ps-verify` green: `tsc` 0 errors × 3 workspaces, 493 Jest tests, `next build` ≤300 kB/route, `expo export` clean. pgTAP `01–07` green. **Human gate: APPROVED.**
> Residual (operator-only steps, cannot be done by agents): Sentry — create projects + supply `NEXT_PUBLIC_SENTRY_DSN`/`EXPO_PUBLIC_SENTRY_DSN`; EAS — `eas login` + cloud `eas build`; Stripe — provide live keys + webhook endpoint; Supabase — deploy + enable `custom-access-token` auth hook; Supabase — enable Realtime + apply `0009` publication; **ROTATE any Supabase `service_role` key exposed in public history**. See `docs/BACKLOG.md` for the full operator checklist.
- ✅ `@ps/core/observability` (pure, >90%): `scrubEvent`/`scrubBreadcrumb`/`redactValue`/`scrubUrl`/`scrubTags`; `SENSITIVE_KEY_PATTERNS`/`SENSITIVE_VALUE_PATTERNS`/`SAFE_TAG_KEYS` constants; deny-by-default, bounded recursion, never throws; adversarial-payload jest suite (JWT, Stripe key, email, money row, Authorization header — none survive; `tenant_id`/`role`/`release` tags and exception frames do). No `@sentry/*` import. Re-exported from core root.
- ✅ Web (Next.js): Sentry init via `instrumentation-client.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts`, `instrumentation.ts` (`onRequestError`), `global-error.tsx`; DSN-gated (`if (!dsn) return;`), `tracesSampleRate:0`, no Replay, `sendDefaultPii:false`, `beforeSend`/`beforeBreadcrumb` delegating to the core scrubber; `withSentryConfig` source-map upload gated on `SENTRY_AUTH_TOKEN` (skip when absent). Removed separate client-side `audit_log` upsert from `ProductForm.tsx`/`ProductsView.tsx`/`RateRulesView.tsx` — trigger is now the sole writer. ESLint `jsx-a11y` (recommended) added; a11y fixes (roles/labels/focus-management/keyboard/contrast). Dynamic imports for reports chart/CSV path; bundle stays within 300 kB/route budget.
- ✅ Mobile (Expo): Sentry init via `apps/mobile/src/observability/sentry.ts` (`initSentry()` DSN-gated, `Sentry.wrap(App)`, scrubber-delegated `beforeSend`/`beforeBreadcrumb`; no-op when `EXPO_PUBLIC_SENTRY_DSN` absent). `eas.json` (`development`/`preview`/`production` profiles, publishable `EXPO_PUBLIC_*` only, no auth token). `runtimeVersion: { policy: "appVersion" }` in `app.json`. Growable lists virtualized. `accessibilityLabel`/`accessibilityRole` + 44 pt touch targets.
- ✅ Backend: migration `0012_audit_atomicity_and_perf_indexes.sql` — `audit_config_change()` `SECURITY INVOKER` `AFTER INSERT OR UPDATE` trigger on `products`/`rate_rules` (atomic, un-skippable, composes with `stamp_impersonator()`, context-skip for seed/service-role); `audit_log_entity_idx` (`tenant_id`, `entity`, `entity_id`) forward-only index; no policy change, no `SECURITY DEFINER` data path. pgTAP `07_audit_atomicity.test.sql` proves the trigger fires atomically and cannot cross tenants.
- ✅ Security sweep (`security-reviewer` sign-off): RLS across all tables `0001–0012`; edge-function auth (only `stripe-webhook` `verify_jwt=false`+signature; no service-role key in any bundle); impersonation + webhook trust boundaries intact; public-repo secret hygiene confirmed (working tree clean; standing rotation reminder for any key in history; publishable DSN is client-safe; `SENTRY_AUTH_TOKEN` uncommitted).
- ✅ architect decisions resolved in [ADR-0011](adr/0011-production-hardening-observability.md): Sentry init architecture + scrubbing policy + `SAFE_TAG_KEYS` allowlist (Q1); EAS profile/env strategy (Q2); audit-atomicity mechanism — trigger over RPC (Q3); perf budget targets (Q4); a11y conformance target + CI mechanism (Q5); RLS impact = zero (Q6); release/version + source-map strategy (Q7).
- ⚪ Out of scope (user/operator steps, post-gate): live Sentry ingestion verification, cloud `eas build` + store submission, Stripe live-key cutover, `custom-access-token-hook` deployment, Realtime publication; Sentry performance tracing/session-replay/APM; load/pen testing as paid service; hosted axe/Lighthouse a11y CI; web offline support; `stripe_events` retention policy.

## Phase 9 — SaaS billing (Stripe subscriptions, trial → tiers, paywall, plan management) — ✅ APPROVED / done
> Spec: [`docs/specs/phase-9-saas-billing-stripe.md`](specs/phase-9-saas-billing-stripe.md) · Decision: ADR-0010 (SaaS billing — subscriptions, entitlements, Stripe webhook isolation) · Anchors: [CLAUDE.md §5](../CLAUDE.md) (tenant identity from signed JWT; **Stripe secret key + webhook signing secret are server-only**; no secret in any bundle), §2.8 (idempotent writes — Stripe delivers at-least-once/out-of-order → dedupe on `event.id`), §2.1/§2.7 (integer minor units + auditable money), §2.6 (Arabic-first RTL), §2.4 (pure `@ps/core` entitlements helper).
> Status (2026-06-26): `@ps/core` entitlements resolver (pure, "now" as argument, >90%); migration `0010_billing.sql` (`plans`/`subscriptions`/`stripe_events` + RLS at birth + billing SECURITY DEFINER RPCs, service-role-only; seeded catalog; trial backfill) + `0011_cap_reactivation_fix.sql`; `stripe-webhook` (raw-body signature verify, `event.id` dedupe, server-side `customer→tenant` map, idempotent write RPC, audit per change, `verify_jwt=false`); `create-checkout-session` + `create-portal-session`; `set-tenant-plan` (super-admin comp/override); owner `/dashboard/billing` + super-admin subscriptions view + comp dialog; plan-limit enforcement; RTL/Arabic-first throughout. All work **Stripe test-mode**; live-key cutover = post-gate user step. `security-reviewer` SIGN-OFF. CI green — **Files=7 Tests=114**. Commit **b33c3ea**. **Human gate: APPROVED.**
- ✅ `@ps/core` `entitlements/` (pure, >90%): resolver `(plan + status + now) → {limits, features, isReadOnly, graceUntil}`; trialing/active = full, past_due-in-grace = banner, past_due-after-grace/canceled = read-only (billing always reachable), comped = plan overrides.
- ✅ Backend: migration `0010_billing.sql` + `0011_cap_reactivation_fix.sql`; `stripe-webhook` (signature verify, dedupe, idempotent write RPC, audit); `create-checkout-session` + `create-portal-session`; `set-tenant-plan`; `provision-tenant` extended. Secrets in edge env only.
- ✅ Web (Next.js): owner `/dashboard/billing`; plan-limit-reached messaging; super-admin subscriptions view + comp dialog. No Stripe secret in bundle.
- ✅ Fresh RTL/Arabic-first billing UX.
- ⚪ Out of scope: live Stripe live-mode key/price/endpoint cutover (separate user step); tax/VAT + multi-currency deferred; mobile billing surface; Sentry/EAS/perf/a11y/full-security-pass (Phase 10).

## Phase 8 — Offline-first hardening (the durable write queue) — ✅ APPROVED / done
> Spec: [`docs/specs/phase-8-offline-first-hardening.md`](specs/phase-8-offline-first-hardening.md) · Decision: ADR-0009 (offline outbox + realtime sync for multi-tenant).
> Status (2026-06-26): pure `@ps/core` outbox (state machine / idempotent dedupe / dependency-ordered drain / retry-backoff + error taxonomy / dead-letter / pure transitions, >90%); durable crash-safe mobile queue + dead-letter; every mutation rerouted through the `persistRow` bridge; network watcher + auto-drain on reconnect; tenant-scoped realtime invalidation; `useSync` store + rehydration; RTL/Arabic-first sync-status UI. `security-reviewer` SIGN-OFF. CI green — **Files=6 Tests=93**. Commit **6139484**. **Human gate: APPROVED.**
- ✅ `@ps/core` `outbox/` (pure, >90%): `OutboxEntry` type (+`tenant_id`/`branch_id`/`dependsOn`); idempotent enqueue/dedupe; drain with dependency ordering; retry/backoff + permanent-vs-transient error taxonomy; dead-letter decision; pure transition fns.
- ✅ Mobile (Expo): durable crash-safe persistence; `persistRow`/outbox bridge; rerouted every existing mutation; ordered drain; network watcher; tenant-scoped realtime invalidation; `useSync` store; sync-status UI (pending/syncing/failed/last-synced + retry/discard, confirm on money discard).
- ✅ Fresh RTL/Arabic-first sync UX.
- ⚪ Out of scope: OS background-terminated sync (drains on next launch); web stays online-only; live hosted-Supabase realtime verification per operator setup; SaaS billing/paywall (Phase 9).

## Phase 7 — Super-admin portal (platform operations) — ✅ APPROVED / done
> Spec: [`docs/specs/phase-7-super-admin-portal.md`](specs/phase-7-super-admin-portal.md) · Decision: [ADR-0008](adr/0008-super-admin-and-impersonation.md).
> Status (2026-06-26): super-admin portal at `/admin`; migration `0008_super_admin_and_impersonation.sql`; `custom-access-token-hook` deployed/hardened; `impersonate-tenant` completes a real short-lived session; `end-impersonation` + `reactivate-tenant` edge fns; pgTAP `04_super_admin_impersonation.test.sql`. `security-reviewer` SIGN-OFF. CI green. Commit **eef736c**. **Human gate: APPROVED.**
- ✅ Backend: forward-only migration `0008_*`; deployed + enabled `custom-access-token-hook`; completed `impersonate-tenant` (real short-lived session); `end-impersonation` + `reactivate-tenant`; lifecycle + impersonation start/stop write `audit_log`; impersonated audit rows stamp `impersonator_id`.
- ✅ Web (Next.js) `/admin`: dual-layer role gate; platform overview; tenant lifecycle (provision/suspend/reactivate, each audited); guarded impersonation (start dialog + RTL banner with countdown + End control); platform cross-tenant audit view.
- ✅ Fresh RTL/Arabic-first super-admin UX.
- ⚪ Out of scope: offline outbox/realtime (Phase 8); Stripe billing (Phase 9); cross-tenant money analytics (deferred, own ADR needed).

## Phase 6 — Owner web dashboard + Reports (the analytics surface) — ✅ APPROVED / done
> Spec: [`docs/specs/phase-6-owner-dashboard-reports.md`](specs/phase-6-owner-dashboard-reports.md) · Decision: ADR-0007 (reporting/aggregation).
- ✅ Backend: `security invoker` reporting RPCs; business-day/range params; `0004` RLS confirmed for full report path.
- ✅ Web (Next.js) owner dashboard at `/dashboard/reports/*`: owner-only route gate; business-day date-range picker + branch filter; revenue KPIs; session + device-utilization metrics; top-products; shift-reconciliation summary; charts (RTL + Arabic-Indic); per-day/device/product/shift report tables; CSV export.
- ✅ Fresh RTL/Arabic-first dashboard UX. `formatEgp` + Arabic-Indic throughout.
- ⚪ Out of scope: super-admin / cross-tenant analytics (Phase 7); offline / realtime auto-refresh (Phase 8); Stripe analytics (Phase 9).

## Phase 5 — Products + Orders + Inventory + Shifts (daily ops complete) — ✅ APPROVED / done
> Spec: [`docs/specs/phase-5-products-orders-inventory-shifts.md`](specs/phase-5-products-orders-inventory-shifts.md) · Decision: [ADR-0006](adr/0006-orders-inventory-shifts.md).
> Status (2026-06-25): core helpers (`computeOrderTotal`, `computeOrdersTotalForSession`, `computeShiftReconciliation`, `businessDayKey`) + web product catalog + mobile order builder/walk-ins/stock/shifts built; migration `0006` landed. Commits 7d212d1, a666faf, ef3c3b9. **Human gate: APPROVED.**
- ✅ `@ps/core`: `computeOrderTotal`, `computeOrdersTotalForSession`, `computeShiftReconciliation`, `businessDayKey`.
- ✅ Web (Next.js) owner product catalog: list + create/edit/deactivate/reactivate; stock-tracking toggle.
- ✅ Mobile (Expo) order builder + walk-ins + stock + shifts: add items to session or walk-in; snapshot `unit_price`; per-line void + audit; walk-in pay; shift open/close via `@ps/core`; one open shift per branch.
- ✅ Backend: migration `0006` (`order_items.is_void`/`voided_at` + `shifts_one_open_per_branch`); Phase-5 `audit_log` actions wired.
- ⚪ Out of scope: owner reports (Phase 6); offline outbox (Phase 8); debts/discount UI (deferred); per-branch catalog overrides (future ADR).

## Phase 4 — Devices + Sessions + Pricing (the pricing engine) — ✅ APPROVED / done
> Spec: [`docs/specs/phase-4-pricing-engine.md`](specs/phase-4-pricing-engine.md) · Decision: [ADR-0005](adr/0005-pricing-engine-segments-and-boundaries.md).
> Status (2026-06-24): core engine + web rate-rule editor + mobile session lifecycle built; code-review + security-review done (all blockers fixed); gates green (tsc core/web/mobile, jest 220, next build, expo export). Commits 004338f, aa5df70, 6132420. **Human gate: APPROVED.**
- ✅ `@ps/core` pricing engine: `ruleMatches`/`resolveRule`/`rateBoundaryInstants`/`planSegments`/`aggregateOpenMeter`/`computePrepaidCost`/`computeFixedMatchCost`/`computeGrandTotal`/`reconstructTimeCost`. >90% coverage.
- ✅ Web (Next.js) owner rate-rule editor: list/create/edit/deactivate; resolved-rate preview using `resolveRule`.
- ✅ Mobile (Expo) deeper session lifecycle: mode-aware start (open/prepaid/fixed-match); switch play mode mid-session; live per-segment + total cost from timestamps; itemized close summary.
- ✅ Backend: seed realistic rule sets per tenant; confirm owner-only `rate_rules` write policy.

## Phase 3 — Walking skeleton — ✅ APPROVED / done
> Spec: [`docs/specs/phase-3-walking-skeleton.md`](specs/phase-3-walking-skeleton.md) · Anchors: [ADR-0002](adr/0002-tenant-isolation-model-ratified.md), [ADR-0003](adr/0003-auth-claim-and-impersonation-model.md), [ADR-0004](adr/0004-tenant-schema-scoping-and-keys.md).
- ✅ Hosted Supabase dev project wired; migrations `0001–0005` applied; seed + real auth users.
- ✅ `rls-tenant-audit` live-verified against hosted DB — Phase-2 isolation graduated from static to live-verified.
- ✅ Mobile (Expo): email/password auth + sign-out; claim-driven tenant/role + branch switcher; device list; start/close session with `@ps/core` timer; timestamp-derived live timer.
- ✅ Web (Next.js, fresh): auth; branch switcher; read-only device-state + session view.
- ✅ Fresh RTL/Arabic-first UX.

## Phase 2 — Tenant foundation — ✅ APPROVED / done
> Spec: [`docs/specs/phase-2-tenant-foundation.md`](specs/phase-2-tenant-foundation.md) · Decision: [ADR-0002](adr/0002-tenant-isolation-model-ratified.md).
- ✅ ADR: tenant isolation model (shared-DB+RLS) — ADR-0002 accepted.
- ✅ Schema: `tenants`, `branches`, `tenant_members`, `profiles` (+`super_admin` role), JWT claim hook (`current_tenant_id()` + `is_active_member()` SECURITY DEFINER helpers).
- ✅ RLS on every table + `WITH CHECK` on writes + `rls-tenant-audit` isolation suite (≥2 seeded tenants; live exec in CI).
- ✅ `@ps/core`: money (piastres), time (Cairo TZ), id, inventory ledger, multi-tenant types — tests >90%.

## Phase 1 — The factory — ✅ done
- ✅ Agent team scaffolded (`docs/AGENTS.md`), feature workflow (`.claude/workflows/feature.js`), skills (`.claude/skills/`), monorepo npm workspaces (`packages/core`, `apps/mobile`, `apps/web`, `supabase`), `CLAUDE.md`.

## Principles
- **Learn from the trial, build fresh** — reuse the sound algorithms (pricing/money/time/inventory) and the offline-sync idea, with a cleaner API and improvements; never copy its UI or import its code (`learn-from-trial` skill).
- **Design with the tooling** — fresh UX via the `ui-ux-pro-max` skill + 21st.dev magic MCP, not the trial's look.
- **Tenant isolation before features** — Phase 2 locked the isolation model with an ADR and isolation tests; every subsequent phase inherits it unchanged.
- **Definition of done** = `ps-verify` green + acceptance criteria met + (for backend) `security-reviewer` sign-off.
- **One phase at a time** — the human approves each gate.
