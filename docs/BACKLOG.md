# Backlog

Living list, owned by `product-manager`. Items get pulled into a phase, specced (`docs/specs/`), and gated by the human.

---

## Operator actions — required before live launch

These cannot be done by agents. They are pre-requisites for a fully operational production system.

1. **ROTATE the Supabase `service_role` key** (and any other key ever exposed in the public repo's history) in the Supabase dashboard. This is a standing requirement for any public repository: assume any secret ever committed is compromised.
2. **Deploy and enable the `custom-access-token` auth hook** in the Supabase dashboard (Functions → Auth Hooks). This is the hook that sets `tenant_id` and `role` in the JWT `app_metadata` claims that RLS policies depend on. Until enabled, claim-based tenant isolation does not fire on the hosted project.
3. **Enable Realtime and apply the `0009` publication** on the hosted Supabase project (Table Editor → Replication → enable for `devices`, `sessions`, `session_segments`, `orders`). Mobile realtime invalidation requires this.
4. **Stripe — provide live keys and configure the webhook endpoint.** The system runs entirely in Stripe test-mode until the owner supplies `STRIPE_SECRET_KEY` (live), `STRIPE_WEBHOOK_SECRET` (live), and registers the `stripe-webhook` edge-function URL in the Stripe dashboard. Test-mode keys (`sk_test_…`, `whsec_…`) remain in `.env` for local development.
5. **Sentry — create projects and supply DSNs.** Create a Sentry account with one project for web and one for mobile. Set `NEXT_PUBLIC_SENTRY_DSN` (web env) and `EXPO_PUBLIC_SENTRY_DSN` (mobile env / EAS profile). Until set, Sentry is a no-op by design — no events are sent, no overhead, no errors. Optionally set `SENTRY_AUTH_TOKEN` (server/CI-only, never committed) to enable source-map upload.
6. **EAS/Expo — create the Expo account and run the cloud build.** Create or confirm an Expo account, run `eas login` then `eas build:configure` (credential generation), then perform cloud `eas build` per the profiles in `apps/mobile/eas.json` (`development` / `preview` / `production`) and any store submission. Local `expo export` works without an account (and is what CI verifies).

> **How to test right now (no setup):** use the **hosted demo** — it already has a working login (`owner@k3ps.test`) with `tenant_id` baked into the JWT, so RLS and the full app work without enabling the auth hook (#2). A fresh **local** `supabase db reset` is wired for the pgTAP isolation suite, **not** for interactive login: `supabase/seed.sql` intentionally omits passwords (pgTAP sets JWT claims directly), the local auth hook is not enabled, and the demo tenants have no `subscriptions` row and only `open`-mode rate rules. Interactive local testing therefore requires enabling the hook and provisioning a tenant via the `provision-tenant` edge function (or adding demo credentials/data to the seed — deliberately not done, to avoid perturbing the live pgTAP gate).

---

## Future / deferred work

These items were explicitly deferred from the 10-phase roadmap and require a new spec/ADR cycle before implementation.

- **Debts / customer-credit ledger UI** — the `payment_method='debt'` enum is inert. A full debt-tracking UI (customer ledger, settlement, balance reporting) needs its own ADR and Phase 11+ spec.
- **Discount and prepaid-topup UI** — the schema and `@ps/core` support prepaid lock and discount; dedicated UI was deferred.
- **Mobile billing surface** — the counter app respects resolved read-only/cap status from entitlements but has no in-app billing page. Owner billing is web-only.
- **Per-branch catalog and pricing overrides** — currently all branches in a tenant share the product catalog and rate rules. Branch-level overrides need a new ADR.
- **Cross-tenant money analytics / platform KPIs** — super-admin can read audit trails cross-tenant but not aggregate financial metrics. A separate ADR is required (materialized-view safety with RLS is the core concern).
- **Annual/multi-interval plans, coupons, usage-based billing** — current billing is monthly + trial only.
- **Tax/VAT and multi-currency** — EGP only; the architecture notes the extension point but does not implement it.
- **In-app invoice/receipt PDF** — Stripe Portal covers billing history; session/shift receipts are not yet generated.
- **Device CRUD / maintenance scheduling UI** — devices can be marked maintenance from mobile; a full device management screen (add/remove/rename) is deferred.
- **Purchase orders, suppliers, stock transfers, barcode scanning** — inventory is inbound-restock / outbound-sale only.
- **Scheduled / emailed / PDF reports and saved report presets** — reports are on-demand web only.
- **Mobile manager mini-dashboard** — managers see operational data; a KPI summary view for managers is deferred.
- **Sentry performance tracing / session replay / APM** — error capture only; tracing (`tracesSampleRate: 0`) and Replay are off.
- **Hosted axe / Lighthouse a11y CI** — the Phase 10 a11y gate is `eslint-plugin-jsx-a11y` + manual checklist. A rendered-DOM automated suite needs a running app in CI.
- **Load / penetration testing as a paid service** — out of scope for CI.
- **Web offline support** — the web app is online-only; offline is mobile-only via the outbox.
- **`stripe_events` retention policy** — the dedupe table grows without bound; a TTL policy or archival job is needed.
- **GDPR data export on cancel** — no self-service data export.
- **Cross-tenant audit page pagination** — the super-admin audit view (`/admin/audit`) hard-caps at `LIMIT 500` with no date filter or pagination; tenants exceeding 500 events cannot see the full log. Needs a paged/filtered read.
- **OS background-terminated sync** — the mobile outbox drains on next launch/foreground/reconnect; background delivery while the app is terminated is not implemented.

---

## Done / changelog

### Phase 10 — Production hardening — ✅ APPROVED / done
> Spec: [`docs/specs/phase-10-production-hardening.md`](specs/phase-10-production-hardening.md) · Decision: [ADR-0011](adr/0011-production-hardening-observability.md) · `security-reviewer` SIGN-OFF (scrubbing policy + audit trigger + full platform sweep).
> Status (2026-06-29): DSN-gated Sentry on web + mobile (no-op without DSN); pure `@ps/core/observability` scrubber (deny-by-default, `SAFE_TAG_KEYS` allowlist, adversarial-payload jest suite); `audit_config_change()` `SECURITY INVOKER` trigger in **migration `0012`** (ADR-0011 named it `0011` — that slot was `0011_cap_reactivation_fix.sql`); `audit_log_entity_idx` added; client-side `audit_log` upsert removed from `ProductForm.tsx`/`ProductsView.tsx`/`RateRulesView.tsx`; `eas.json` three-profile build config; `eslint-plugin-jsx-a11y` (recommended) + manual a11y pass; perf pass (dynamic imports, list virtualization, ≤300 kB/route budget); full security sweep. `ps-verify` green: `tsc` 0 errors × 3 workspaces, 493 Jest tests, `next build` ≤300 kB/route, `expo export` clean. pgTAP `01–07` green. **Human gate: APPROVED.**
- ✅ `@ps/core/observability`: `scrubEvent`/`scrubBreadcrumb`/`redactValue`/`scrubUrl`/`scrubTags`; deny-by-default key and value patterns; `SAFE_TAG_KEYS` allowlist; pure, >90% covered, never throws.
- ✅ Web Sentry: DSN-gated init across all Next.js runtimes; core-scrubber delegates; no auth token in bundle; `withSentryConfig` source-map upload skips when `SENTRY_AUTH_TOKEN` absent.
- ✅ Mobile Sentry: `initSentry()` DSN-gated; `Sentry.wrap(App)`; `@sentry/react-native/expo` plugin (no auth token in `app.json`); `getSentryExpoConfig` in metro.
- ✅ Migration `0012`: `audit_config_change()` `SECURITY INVOKER` trigger on `products`/`rate_rules`; `audit_log_entity_idx`; no policy change.
- ✅ `eas.json`: `development`/`preview`/`production` profiles; publishable `EXPO_PUBLIC_*` only; `runtimeVersion: { policy: "appVersion" }`; cloud build is user-only.
- ✅ A11y: `eslint-plugin-jsx-a11y` in web lint; semantic roles/labels; dialog focus-trap; keyboard nav; contrast per design tokens; mobile `accessibilityLabel`/`accessibilityRole`; 44 pt touch targets; impersonation banner + money-discard confirm + paywall surfaces reviewed.
- ✅ Perf: per-route First-Load JS ≤300 kB; `audit_log_entity_idx` for entity-history reads; mobile growable lists virtualized.
- ✅ Security sweep: RLS `0001–0012` confirmed; edge-function auth correct; impersonation + webhook trust boundaries intact; secret hygiene on public repo confirmed.
- ⚪ Explicitly out of scope: live Sentry ingestion verification / cloud EAS builds / store submission (user steps); Sentry tracing/replay/APM; load/pen testing; hosted axe/Lighthouse CI; web offline; `stripe_events` retention.

### Pre-handoff whole-system audit — ✅ fixes applied (commit a15413d, 2026-06-29)
> First integration audit across all phases (per-phase reviews only saw their own diff). Verdict before fixes: NOT-READY (1 money blocker + UX issues). After fixes: ready for hands-on testing.
- ✅ **B3 (money blocker)** — `sessions.orders_total` was never updated after orders were added, so a session closed *with* orders stored `grand_total = time_total − discount` (orders excluded), cascading into wrong shift cash reconciliation. Fixed: mobile close now sums non-void order lines via `@ps/core` `computeOrdersTotalForSession` (reusing the existing orders fetch); the live prepaid/fixed-match on-screen total had the same stale-column read and is fixed too. Dead `_syncSessionOrdersTotal` + false "realtime updates it" comment + dead `useCloseSession` export removed.
- ✅ **UX/i18n/a11y** — mobile shift/stock validation errors showed field *labels* instead of error text (added `*.error.*` keys); web hardcoded Arabic retry + status-filter strings → i18n; RTL breadcrumb arrow direction; RateRulesView modals migrated to the shared focus-trapping `Dialog`; `toArabicDigits` on sync times; stale `0011`→`0012` comments.
- ⚪ Deferred (documented above, not code): local-seed login/data and auth-hook enablement (test via hosted demo / `provision-tenant`); cross-tenant audit pagination; Stripe live price IDs (test-mode).

### Phase 9 — SaaS billing (Stripe subscriptions, trial → tiers, paywall, plan management) — ✅ APPROVED / done
> Spec: [`docs/specs/phase-9-saas-billing-stripe.md`](specs/phase-9-saas-billing-stripe.md) · Decision: ADR-0010.
> Status (2026-06-26): entitlements resolver; migration `0010_billing.sql` + `0011_cap_reactivation_fix.sql`; `stripe-webhook` + `create-checkout-session` + `create-portal-session` + `set-tenant-plan`; owner `/dashboard/billing`; super-admin subscriptions view; plan-limit enforcement; RTL/Arabic-first. All Stripe test-mode. `security-reviewer` SIGN-OFF. CI green — **Files=7 Tests=114**. Commit **b33c3ea**. **Human gate: APPROVED.**
> Residual follow-ups: live-mode Stripe key/price/endpoint cutover is a separate human step; tax/VAT + multi-currency deferred; mobile billing surface deferred; Sentry/EAS/perf/a11y/full-security-pass delivered in Phase 10.

### Phase 8 — Offline-first hardening (the durable write queue) — ✅ APPROVED / done
> Spec: [`docs/specs/phase-8-offline-first-hardening.md`](specs/phase-8-offline-first-hardening.md) · Decision: ADR-0009.
> Status (2026-06-26): pure `@ps/core` outbox + dead-letter; every mutation rerouted; network watcher + auto-drain; tenant-scoped realtime invalidation; `useSync` + rehydration; RTL sync-status UI. `security-reviewer` SIGN-OFF. CI green — **Files=6 Tests=93**. Commit **6139484**. **Human gate: APPROVED.**
> Residual follow-ups: OS background-terminated sync deferred; web stays online-only; live hosted-Supabase realtime verification per operator setup.

### Phase 7 — Super-admin portal (platform operations) — ✅ APPROVED / done
> Spec: [`docs/specs/phase-7-super-admin-portal.md`](specs/phase-7-super-admin-portal.md) · Decision: [ADR-0008](adr/0008-super-admin-and-impersonation.md).
> Status (2026-06-26): portal at `/admin`; migration `0008`; `custom-access-token-hook` hardened; guarded+audited impersonation; pgTAP `04`. `security-reviewer` SIGN-OFF. CI green. Commit **eef736c**. **Human gate: APPROVED.**

### Phase 6 — Owner web dashboard + Reports — ✅ APPROVED / done
> Spec: [`docs/specs/phase-6-owner-dashboard-reports.md`](specs/phase-6-owner-dashboard-reports.md) · Decision: ADR-0007.
> Owner dashboard at `/dashboard/reports/*`; `security_invoker` reporting RPCs; business-day date-range + branch filter; revenue KPIs; charts; CSV export; RTL/Arabic-Indic throughout. **Human gate: APPROVED.**

### Phase 5 — Products + Orders + Inventory + Shifts — ✅ APPROVED / done
> Spec: [`docs/specs/phase-5-products-orders-inventory-shifts.md`](specs/phase-5-products-orders-inventory-shifts.md) · Decision: [ADR-0006](adr/0006-orders-inventory-shifts.md).
> Commits 7d212d1, a666faf, ef3c3b9. **Human gate: APPROVED.**

### Phase 4 — Devices + Sessions + Pricing — ✅ APPROVED / done
> Spec: [`docs/specs/phase-4-pricing-engine.md`](specs/phase-4-pricing-engine.md) · Decision: [ADR-0005](adr/0005-pricing-engine-segments-and-boundaries.md).
> Commits 004338f, aa5df70, 6132420. **Human gate: APPROVED.**

### Phases 1–3 — Factory + Tenant foundation + Walking skeleton — ✅ APPROVED / done
> Decisions: [ADR-0002](adr/0002-tenant-isolation-model-ratified.md) (isolation model), [ADR-0003](adr/0003-auth-claim-and-impersonation-model.md) (auth claim), [ADR-0004](adr/0004-tenant-schema-scoping-and-keys.md) (schema keys).
> Monorepo scaffolding, agent team, `@ps/core` v1, multi-tenant schema + RLS, walking skeleton (auth → session → audit). **Human gate: APPROVED.**
