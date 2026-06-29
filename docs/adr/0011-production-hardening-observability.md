# ADR-0011: Production hardening — DSN-gated Sentry observability with a pure `@ps/core` scrubber, the audit-atomicity trigger that completes §2.7, EAS build profiles, and the perf/a11y/security gates

- **Status:** Accepted (Phase-10 design gate — the **final** roadmap phase / launch-readiness pass. **`security-reviewer` sign-off REQUIRED — release blocker** on: (a) the Sentry **`beforeSend`/breadcrumb scrubbing policy + safe-tag allowlist** — proof that no auth token, card/Stripe data, email/PII, `.env` value, or raw tenant money row can reach Sentry — spec Block A AC 3–4, Block F AC 29; (b) the **audit-atomicity trigger** in migration `0011` — that it completes §2.7 by construction without weakening any RLS policy or adding a `SECURITY DEFINER` data path — spec Block B AC 6–10; (c) the **full platform security sweep** over RLS on all tables `0001–0011`, edge-function auth, the impersonation + webhook trust boundaries, and **secret hygiene on a PUBLIC repo** (working tree **and** git history) — Block F AC 24–29; and (d) confirmation that **no secret is committed** and that the Sentry DSN is publishable/client-safe while any `SENTRY_AUTH_TOKEN` stays server/CI-only — AC 5, 28. The human project owner approves at the Phase-10 gate: the **observability privacy posture** (Q1 — may `tenant_id`/`role` be sent as triage tags?), the **performance-budget targets** (Q4), and the **a11y conformance target + CI mechanism** (Q5). All external accounts — Sentry DSNs, Expo/EAS credentials, `SENTRY_AUTH_TOKEN` — are **USER-only and MUST NOT block CI**; every integration **no-ops when its env var is absent**.)
- **Date:** 2026-06-26
- **Deciders:** architect (deciding — tenant-isolation & cross-cutting authority) · `security-reviewer` (scrubbing policy / audit-trigger / full-platform RLS + secret-hygiene sweep / no-secret-leak sign-off — **required, release blocker**) · core-engineer (the pure `@ps/core/observability` scrubber + the hot-path sanity check) · web-engineer (Sentry for Next.js, DSN-gated; perf wins; a11y fixes; route catalog/rate-rule writes through the atomic path) · mobile-engineer (Sentry for Expo, DSN-gated; `eas.json` + app-config profiles; list virtualization; mobile a11y) · backend / supabase-migrate (authors `0011` from the normative SQL — the audit trigger + any hot-path index) · ux-designer (a11y token/contrast/focus-visible adjustments + safety-critical-surface accessibility) · human project owner (Phase-10 gate)
- **Builds on:** [ADR-0002 — isolation model](0002-tenant-isolation-model-ratified.md) (shared-DB + `tenant_id` + RLS; `current_tenant_id()` the only tenant resolver — this phase **verifies it across all tables, changes none of it**) · [ADR-0003 — auth claim & impersonation model](0003-auth-claim-and-impersonation-model.md) (`app_metadata` signed claims; `current_impersonator_id()`) · [ADR-0007 — reporting RLS read path](0007-reporting-aggregation-and-rls.md) (the **no-`SECURITY DEFINER`-on-a-tenant-data-path** discipline the audit trigger and any index honor) · [ADR-0008 — super-admin & impersonation](0008-super-admin-and-impersonation.md) (the `audit_log` **`stamp_impersonator()` BEFORE INSERT trigger** that derives `meta.impersonator_id` from the signed claim — the audit-atomicity trigger composes with it; the **`request.jwt.claims`-empty / `role=service_role` context-skip** guard reused verbatim) · [ADR-0009 — offline hardening](0009-offline-outbox-and-realtime.md) (the **`SECURITY INVOKER` `close_session_tx`** atomic-write-plus-audit pattern this ADR generalizes to config writes; the **explicit deferral of dead-letter→Sentry telemetry "to Phase 10"** — partially addressed here) · [ADR-0010 — SaaS billing](0010-saas-billing-stripe.md) (the Stripe **webhook trust boundary** + **no secret in any client bundle** re-verified by the security sweep).
- **Reference:** `docs/specs/phase-10-production-hardening.md` §3 (scope) / §6 (Q1–Q7) / Appendix (AC 1–32) · `CLAUDE.md` §2.1 (money integer piastres — unchanged), §2.4 (`@ps/core` purity — the scrubber obeys it), §2.6 (Arabic-first RTL — a11y extends it), §2.7 (auditable money — **this phase completes the invariant**), §5 (tenancy/security; **no secret committed; repo is PUBLIC**), §7 (`ps-verify` must stay green **with and without** Sentry/Expo secrets) · `apps/web/src/components/products/ProductForm.tsx` + `ProductsView.tsx` + `RateRulesView.tsx` (the **non-atomic client-side audit insert** gap — `product.*`/`rate_rule.*` write the data upsert then a **separate** `audit_log` insert) · `supabase/migrations/0002_operational_tables.sql` (`audit_log(tenant_id, branch_id, actor_id, action, entity, entity_id, amount, meta, created_at)`; `products`/`rate_rules` shape) · `0004_rls_policies.sql` (`products_owner_write`/`rate_rules_owner_write` — owner-only `for all` with `WITH CHECK`) · `0008_super_admin_and_impersonation.sql` (`stamp_impersonator()`, the context-skip pattern) · `0009_outbox_realtime_and_close_rpc.sql` (`close_session_tx` `SECURITY INVOKER`) · `apps/mobile/app.json` (`slug: ps-managment`, bundle/package ids, `expo-secure-store`/`expo-sqlite` plugins).

## Context

PS-Managment is **feature-complete through Phase 9** (pure `@ps/core`; a Next.js owner-dashboard + reports + super-admin + billing web app; an Expo offline-first counter app; a Supabase backend at migrations `0001–0011` with live pgTAP isolation tests). What it lacks is **launch-readiness**: there is **no production error visibility** (a crash on web or mobile is invisible — the exact gap ADR-0009 deferred "to Phase 10"); the **§2.7 audit invariant is mostly-but-not-provably honored** — web catalog/rate-rule changes record their `audit_log` row as a **separate client-side insert *after* the data upsert** (`ProductForm.tsx` lines 232–286), so a skipped/failed/forged second request persists the change **unaudited**; the mobile app has **no distributable build config**; there is **no performance budget**, **no formal accessibility pass**, and — now that **the repo is PUBLIC** and every table/function/trust-boundary exists — **no final security sign-off**.

Phase 10 is a **cross-cutting hardening pass, not feature work**. It must add observability, complete the audit invariant, make the app buildable/fast/accessible, and sign off security **without regressing any `CLAUDE.md` non-negotiable** and **without ever requiring a committed secret**. The defining constraint is **graceful degradation without secrets**: contributors and CI have no Sentry DSN and no Expo account, so every integration must **no-op when its env var is absent** and `ps-verify` (tsc / jest / `expo export` / `next build`) plus the 3-job CI (incl. live pgTAP) must stay green either way.

**Hard constraints (`CLAUDE.md`):** §5 — RLS on every table; tenant identity from the signed claim; **no secret in any client bundle or in the repo** (the publishable Sentry **DSN is client-safe by design**; any `SENTRY_AUTH_TOKEN` is server/CI-only). §2.7 — every money/lifecycle action writes an `audit_log` row with actor/tenant/(amount). §2.4 — `@ps/core` is pure (no framework imports, no `Date.now()` in logic, >90% covered); the Sentry SDK is **never** imported into core. §2.6 — Arabic-first RTL; accessible names come from i18n, never hardcoded. §2.1 — money stays integer minor units (untouched this phase).

**New external actor: Sentry** — an error-ingest endpoint that must receive **only scrubbed, non-sensitive data**. The novel risk is the **inverse of every prior phase**: prior phases stopped data *entering* the wrong tenant; observability risks tenant/PII/secret/money data *leaving the device entirely*. The mitigation is a documented, enforced, **provably-tested `beforeSend` scrubbing policy** built on a **pure, unit-tested `@ps/core` helper** — the security-review artifact.

The seven open questions (spec §6) are locked below.

---

## Decisions (Q1–Q7, locked)

### Decision Q1 (decided first — it is the central privacy/security call) — Sentry init architecture, `beforeSend`/breadcrumb scrubbing, and the safe-tag allowlist: **DSN-gated init per runtime; a pure `@ps/core/observability` scrubber the init delegates to; errors-only (no tracing/replay); allow only `tenant_id`/`role`/`release`/`environment`/`route` as tags — NEVER email/PII/tokens/money rows**

**Evidence established (verified):** Sentry's SDKs treat the **DSN as the gate** — "If this is not set, the SDK will not send any events" ([Sentry — Options](https://docs.sentry.io/platforms/javascript/configuration/options/)); `enabled:false` alone does **not** remove all instrumentation overhead, so the canonical "fully off" pattern is to **conditionally call `init` based on environment**. `beforeSend(event, hint)` runs after all scope is applied and can **modify the event or return `null` to drop it** — the documented hook for "manual PII stripping before sending"; `beforeBreadcrumb` likewise filters/redacts breadcrumbs. Next.js (App Router) initializes via **`instrumentation-client.ts`** (client), **`sentry.server.config.ts`** + **`sentry.edge.config.ts`** (loaded by **`instrumentation.ts`** which also exports **`onRequestError`** to capture Server Component/middleware errors), plus **`app/global-error.tsx`** ([Sentry — Next.js manual setup](https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/)). Expo uses **`@sentry/react-native`** (Expo SDK 50+), wired as the **`@sentry/react-native/expo` config plugin** in `app.json` and **`getSentryExpoConfig`** in `metro.config.js`, with the root wrapped by **`Sentry.wrap(App)`**; the **auth token must never be in `app.json`/`app.config`** (it embeds in the bundle) — it is an env var / EAS secret ([Sentry — Expo manual setup](https://docs.sentry.io/platforms/react-native/manual-setup/expo/); [Expo — Using Sentry](https://docs.expo.dev/guides/using-sentry/)).

**Mechanism (locked):**

1. **DSN-gated init, both apps.** Each runtime reads its **publishable** DSN env (`NEXT_PUBLIC_SENTRY_DSN` web, `EXPO_PUBLIC_SENTRY_DSN` mobile). **If the DSN is falsy the app does not call `Sentry.init` at all** (an early `return`) — defense beyond the SDK's own "no DSN ⇒ no events", so there is zero instrumentation overhead, zero network call, zero console noise in dev/CI/contributor builds (AC 1). When present, `init` captures **unhandled errors + unhandled promise rejections** with `release`, `environment`, `route`/`screen`, and error type/stack (AC 2).
2. **Web init files (Next.js 15 App Router):** `apps/web/instrumentation-client.ts` (client), `apps/web/sentry.server.config.ts`, `apps/web/sentry.edge.config.ts`, `apps/web/instrumentation.ts` (`register()` imports the server/edge config by runtime + re-exports `onRequestError`), and `apps/web/src/app/global-error.tsx` (renders + `Sentry.captureException`). Each config: `dsn: process.env.NEXT_PUBLIC_SENTRY_DSN` guarded as above, `tracesSampleRate: 0`, **no Replay integration**, `sendDefaultPii: false`, `beforeSend`/`beforeBreadcrumb` delegating to the core scrubber (below).
3. **Mobile init (Expo):** `apps/mobile/src/observability/sentry.ts` exporting `initSentry()` called once at the top of the root component module; `Sentry.init({ dsn: EXPO_PUBLIC_SENTRY_DSN, enabled: !!dsn, sendDefaultPii: false, tracesSampleRate: 0, beforeSend, beforeBreadcrumb })` **wrapped in `if (!dsn) return;`**; the root is `export default Sentry.wrap(App)`. The `@sentry/react-native/expo` plugin is added to `app.json` with `url`/`org`/`project` placeholders and **no auth token**; `metro.config.js` uses `getSentryExpoConfig`. RN captures unhandled JS errors + promise rejections by default once initialized.
4. **Errors only.** Tracing (`tracesSampleRate: 0`) and Session Replay are **off** this phase (spec out-of-scope: APM/replay). This also shrinks the attack surface for accidental data capture (no request waterfalls, no DOM snapshots).
5. **The scrubber lives in `@ps/core` (decided — shared + testable).** A pure `@ps/core/observability` module owns the redaction logic; both apps' `beforeSend`/`beforeBreadcrumb` are **thin adapters** that pass the Sentry event/breadcrumb (a plain object) through it. Core imports **no** Sentry types (it operates on a minimal structural `SentryLikeEvent`), no framework, calls no `Date.now()`, and is **>90% covered** (AC 4, §2.4). Rationale over per-app filters: the policy is **security-critical and identical** on both surfaces; one audited, unit-tested implementation (fed adversarial payloads in jest) is the single source of truth the `security-reviewer` signs off, instead of two drifting copies.
6. **The scrubbing policy (NORMATIVE — the security-review artifact, mirrored in `docs/`):**
   - **NEVER transmitted (redacted to `[redacted]` before send, by key-name denylist AND value-pattern):** any access/refresh/JWT/session token or `Authorization`/`apikey`/`cookie`/`set-cookie` header; Stripe keys/secrets (`sk_*`, `rk_*`, `whsec_*`) and any card PAN/CVC; **user email / name / phone**; `.env` values / `service_role` keys; raw tenant **rows** carrying money (`grand_total`, `price`, `amount`, `cost`, session/order/subscription row bodies); request/response **bodies** and form data; query-string credentials. Denylist key-substrings (case-insensitive): `token`, `authorization`, `apikey`, `api_key`, `secret`, `password`, `cookie`, `email`, `phone`, `card`, `cvc`, `pan`, `dsn`, `service_role`, `jwt`, `access_token`, `refresh_token`, `signing`, `whsec`. Value patterns redacted regardless of key: JWT-shaped (`eyJ…\.…\.…`), `sk_/rk_/whsec_`-prefixed, 13–19-digit card-like runs, email-shaped strings.
   - **ALLOWED as triage tags (subject to the human's Q1 privacy approval at the gate):** `tenant_id` (a coarse grouping key — groups errors by café **without exposing café data**), `role` (`owner`/`manager`/`staff`/`super_admin`), `release`/app version, `environment`, and `route`/`screen` name. **`email`/name/phone are NOT allowed.** We **do not** set Sentry user identity (`Sentry.setUser`) — no `auth.uid` or email is attached; `sendDefaultPii:false` keeps IP/cookies off. Tenant grouping is achieved via the `tenant_id` **tag** only.
   - `beforeSend` runs the event through `scrubEventContext` (deep-redacts `request`, `extra`, `contexts`, `breadcrumbs[].data/message`, and scrubs `request.url`/`request.query_string`) **and** strips any tag not on the allowlist; `beforeBreadcrumb` runs `scrubBreadcrumb`. Exception **type + stack frames** are preserved (needed for triage; frames are code locations, not data) but breadcrumb/extra **values** are redacted.
7. **No secret in any client bundle.** Only the **publishable DSN** ships to the client (AC 5); `SENTRY_AUTH_TOKEN` (source maps, Q7) is server/CI-only. A bundle scan (Block F) confirms no auth token or `service_role` key in `next build` output.

**Privacy decision is security-central — `security-reviewer` co-signs Block A AC 3–4 + Block F AC 29; the human approves whether `tenant_id`/`role` may be sent at all.**

### Decision Q2 — EAS profile/env strategy: **`eas.json` with `development`/`preview`/`production`; non-secret `EXPO_PUBLIC_*` wired per profile; `runtimeVersion` = `appVersion` policy; channels match profiles; cloud build is a USER step, local `expo export`/prebuild needs no account**

`apps/mobile/eas.json` (normative shape below) defines three profiles. The `EXPO_PUBLIC_*` values wired per profile are **publishable/client-safe** (Supabase URL, Supabase **anon** key, `EXPO_PUBLIC_SENTRY_DSN`) — these are already client-exposed by design and are **not** secrets; **no `service_role` key, no `SENTRY_AUTH_TOKEN`** is ever placed in `eas.json`. `runtimeVersion: { policy: "appVersion" }` ties OTA-update compatibility to `app.json`'s `version`; each profile's `channel` matches its name so EAS Update routes correctly. **Local verifiability (AC 11):** `expo export` (already in `ps-verify`) and `expo prebuild --no-install` / config validation succeed **without** an Expo account or credentials — that is what CI proves. **Cloud `eas build`, credential generation (`eas build:configure`), and store submission require the USER's Expo account** and are post-gate hand-offs (§User-only), never run in CI.

```jsonc
// apps/mobile/eas.json — NORMATIVE shape (no secrets; values are publishable)
{
  "cli": { "version": ">= 12.0.0", "appVersionSource": "remote" },
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal",
      "channel": "development",
      "env": {
        "EXPO_PUBLIC_SUPABASE_URL": "https://<project>.supabase.co",
        "EXPO_PUBLIC_SUPABASE_ANON_KEY": "<anon-publishable>",
        "EXPO_PUBLIC_SENTRY_DSN": ""        // empty ⇒ Sentry no-ops in dev
      }
    },
    "preview": {
      "distribution": "internal",
      "channel": "preview",
      "env": {
        "EXPO_PUBLIC_SUPABASE_URL": "https://<project>.supabase.co",
        "EXPO_PUBLIC_SUPABASE_ANON_KEY": "<anon-publishable>",
        "EXPO_PUBLIC_SENTRY_DSN": "<publishable-dsn-or-empty>"
      }
    },
    "production": {
      "autoIncrement": true,
      "channel": "production",
      "env": {
        "EXPO_PUBLIC_SUPABASE_URL": "https://<project>.supabase.co",
        "EXPO_PUBLIC_SUPABASE_ANON_KEY": "<anon-publishable>",
        "EXPO_PUBLIC_SENTRY_DSN": "<publishable-dsn>"
      }
    }
  },
  "submit": { "production": {} }   // store creds supplied by the USER at submit time
}
```

`runtimeVersion` is declared in `app.json` (`"runtimeVersion": { "policy": "appVersion" }`); the `@sentry/react-native/expo` plugin is added to `app.json` `plugins` with `url`/`org`/`project` and **no auth token**. Source-map upload (Q7) is gated on `SENTRY_AUTH_TOKEN` being present at build time and **skipped when absent** — the build still succeeds.

### Decision Q3 (the audit-completeness headline) — Close the web catalog/rate-rule gap with an **`AFTER INSERT OR UPDATE` `SECURITY INVOKER` trigger** on `products`/`rate_rules` that writes the `audit_log` row **by construction, atomically, in the same statement** — stronger than an RPC because it audits even a direct PostgREST write; the web client drops its separate audit insert

The current pattern (`ProductForm.tsx`) does `upsert(products)` then a **second** `upsert(audit_log)` request — two round-trips. If the second is skipped (a tampered client), fails (network/RLS), or is never sent, the catalog change persists **unaudited**, violating §2.7's intent even though these are non-money config changes. We make the audit **un-skippable by construction**, mirroring the two server-authoritative audit patterns already in the codebase: ADR-0008's `stamp_impersonator()` BEFORE INSERT trigger and ADR-0009's atomic `close_session_tx`.

**Mechanism (locked) — migration `0011` adds one trigger function `audit_config_change()` on `products` and `rate_rules`:**
- **`AFTER INSERT OR UPDATE … FOR EACH ROW`**, `SECURITY INVOKER`, `set search_path = public`. Because it is **`SECURITY INVOKER`** the `audit_log` insert runs under the **caller's** RLS (the owner has the `audit_log` insert grant), and **the existing `stamp_impersonator()` BEFORE INSERT trigger still fires** on that row — so `meta.impersonator_id` is stamped automatically from the signed claim (ADR-0008 preserved, AC 9). It adds **no policy** and **no `SECURITY DEFINER` data path** (ADR-0007 discipline intact).
- **Action verb derived from `TG_OP` + the `is_active` transition:** INSERT ⇒ `product.create`/`rate_rule.create`; UPDATE with `old.is_active=true → new.is_active=false` ⇒ `*.deactivate`; `false → true` ⇒ `*.reactivate`; otherwise ⇒ `*.update`. `entity`/`entity_id`/`tenant_id`/`branch_id` come from `NEW`; `actor_id = auth.uid()`; `amount = null` (config, not money); `meta` carries `before`/`after` (or `snapshot` on insert) built from OLD/NEW.
- **Context-skip (ADR-0008 verbatim):** if `request.jwt.claims` is empty (migration/seed/`psql`) **or** the JWT `role` is `service_role`, **or** `auth.uid()` is null, the trigger returns without writing — so seeds, backfills, and service-role admin edits are never blocked by `audit_log`'s `NOT NULL actor_id`. The audit guarantee applies precisely to authenticated end-user (owner) writes — the path we care about.
- **Idempotent (§2.8):** the `audit_log` id is **deterministic** — `md5(action || ':' || entity_id || ':' || extract(epoch from new.updated_at))::uuid` — inserted `ON CONFLICT (id) DO NOTHING`, so a replayed/retried upsert that re-stamps the same `updated_at` does not duplicate the audit row (matching the client's prior `uuidv5(action:id:now)` intent).
- **Web client change:** `ProductForm.tsx`, `ProductsView.tsx`, `RateRulesView.tsx` **remove** their separate client-side `audit_log` upsert — the trigger now owns it atomically. The data upsert is unchanged. (This both fixes the gap and removes ~50 lines of client audit plumbing.)

**Why a trigger over the SECURITY INVOKER RPC (the runner-up):** an RPC (`upsert_product_tx(p_row, p_audit)`) is atomic **only if the client calls it** — but `products_owner_write` still permits a **direct** PostgREST `.upsert('products')`, which would bypass the RPC and skip the audit unless we *also* revoke direct write grants and reroute every caller. The trigger guarantees the audit on **any** write path (RPC, direct PostgREST, future surface) with a single additive object — the "app filtering is never the only line / defense in depth" rule applied to auditability. It is the smaller, stronger change.

**Audit-taxonomy completeness checklist (the sweep's reference artifact — every money/lifecycle write path is covered or an explicit non-audit):**

| Action | Surface | Write path | Audited | Atomic |
|---|---|---|---|---|
| `session.close` (amount) | mobile | `close_session_tx` RPC (ADR-0009) | yes | **yes (same txn)** |
| `order.pay` / `order_item.void` (amount) | mobile | outbox upsert + audit entry | yes | idempotent keys (ADR-0009) |
| `stock.restock` / `stock.adjust` | mobile | outbox + audit | yes | idempotent keys |
| `shift.open` / `shift.close` (amount on close) | mobile | outbox + audit | yes | idempotent keys |
| `product.create\|update\|deactivate\|reactivate` | web | **`audit_config_change()` trigger (NEW)** | yes | **yes (same statement)** |
| `rate_rule.create\|update\|deactivate\|reactivate` | web | **`audit_config_change()` trigger (NEW)** | yes | **yes (same statement)** |
| `tenant.suspend` / `tenant.reactivate` / `tenant.provision` | edge | service-role RPC, audit in txn (ADR-0008) | yes | yes |
| `impersonation.start` / `impersonation.stop` | edge | service-role RPC, audit in txn (ADR-0008) | yes | yes |
| `subscription.*` (comp/override/webhook, amount) | edge | `apply_stripe_subscription_event`/`set_tenant_plan` (ADR-0010) | yes | yes |
| **session start / switch-mode / device status** | mobile | outbox upsert | **intentional non-audit** | n/a — **no money committed; the bill is reconstructed from segments at `session.close`** which IS audited; device status is operational state, not money |
| **discount application** | mobile | folded into the `session.close` snapshot | covered by `session.close` | n/a |

The two intentional non-audits (session-open lifecycle micro-events; bare device status) carry **no money effect** and are reconstructible from the audited close — documented here as covered, not gaps (AC 6, AC 10).

### Decision Q4 — Performance budget: **per-route First-Load JS ≤ 300 kB, total shared JS ≤ 220 kB (web, read from `next build`); mobile lists > 20 rows MUST be virtualized; report/admin/subscriptions reads MUST be index-backed on `tenant_id`/`branch_id`/date; enforced via a checked-in budget doc + a no-dependency build-output check, NOT a paid service**

- **Web bundle budget (current routes ~100–300 kB First-Load JS):** per-route **First-Load JS ≤ 300 kB**, **total shared JS ≤ 220 kB**, recorded in `docs/reference/performance-budget.md` from the `next build` route table. Any route over budget is either justified (with a note) or fixed by an **obvious win only** — dynamic-import a heavy chart/CSV path, drop an unused dep — **no behavior change**. Enforcement: the budget doc is the inspectable artifact; a small **node script that parses the `next build` output** (no external/paid service) may run in `ps-verify` as a soft check. The recharts/CSV-export paths on `/dashboard/reports` are the first dynamic-import candidates.
- **Backend/query budget:** the `/dashboard/reports`, `/admin`, and subscriptions read paths are audited for **N+1** and for an index on every hot filter column (`tenant_id`, `branch_id`, business-day/date-range). The reporting RPCs (`0007`) already aggregate server-side; the audit **documents each query's shape and confirms its index** and adds a **forward-only index migration only if a hot path lacks one** (in `0011`, RLS-neutral). No new aggregation behavior.
- **Mobile virtualization threshold:** any list that can exceed **~20 rows** (device grid, order/catalog lists, sync dead-letter list, sessions/audit history) **must** use a virtualized list (`FlatList`/`FlashList`) rather than `.map()` into a `ScrollView`; each list is documented as checked.
- **`@ps/core` hot paths** (pricing/outbox/entitlements resolvers): a sanity check that no accidental quadratic/unbounded loop exists; **no public API change**; the existing jest suite stays green.

Targets are achievable without behavior change (they bracket the current measured sizes). **Human approves the numbers at the gate.**

### Decision Q5 — Accessibility: **target WCAG 2.1 AA where feasible; automated gate = `eslint-plugin-jsx-a11y` (recommended) in the existing web lint + the extended `rtl-i18n-check`; a documented manual checklist owns the safety-critical, focus-management, and contrast items lint cannot catch; Stripe-hosted pages exempt**

**Target: WCAG 2.1 AA where feasible.** The CI/check split:
- **Automated (no external service):** add **`eslint-plugin-jsx-a11y`** with its **`recommended`** config to `apps/web` ESLint — it statically catches missing `alt`, unlabeled controls, invalid ARIA, non-interactive handlers, etc., and runs inside the **existing lint step** with no paid dependency ([eslint-plugin-jsx-a11y](https://github.com/jsx-eslint/eslint-plugin-jsx-a11y)). **Extend `rtl-i18n-check`** so accessible names are asserted to come from i18n resources (no hardcoded labels) and focus order respects RTL.
- **Manual checklist (the items lint provably cannot verify), documented in `docs/reference/accessibility-checklist.md`:** dialog **focus management** (focus moves in, is trapped, `Esc` closes, focus restores — all modals: lifecycle, comp/override, money/discard confirm, paywall — AC 19); **keyboard navigation** + visible focus ring across primary flows (AC 20); **color contrast** of text/control/status colors **against the design tokens** (≥ 4.5:1 normal text — ux-designer adjusts tokens on failure, AC 21); **safety-critical surfaces** — the **impersonation banner** (announced/unmistakable), **money/discard confirmations** (focus-managed, not accidentally dismissible), and the **paywall/read-only** state (perceivable to assistive tech) get explicit manual sign-off (AC 23). **Mobile** is checklist-only: `accessibilityLabel` + `accessibilityRole` on interactive elements, status/badges expose state, **touch targets ≥ 44×44 pt** (AC 22).
- **Documented exceptions:** Stripe-hosted Checkout/Portal pages (external, not our markup) and any item deferred with a written rationale. `jsx-a11y` is necessary-not-sufficient (it is static-only; rendered-DOM/contrast checks are the manual layer) — stated so the gate is honest.

**Human approves the conformance target + this CI mechanism at the gate.**

### Decision Q6 — RLS / data-model impact: **NO RLS policy changes this phase.** The only schema delta is migration `0011`: the additive `audit_config_change()` `SECURITY INVOKER` trigger (Q3) + any forward-only hot-path **index** (Q4). Neither alters/weakens a policy nor touches tenant isolation

`0011` **alters no existing policy**, adds **no** `WITH CHECK`, adds **no** `SECURITY DEFINER` on any tenant-visible data path. The audit trigger only **adds** an `audit_log` row under the caller's own RLS; an index only speeds a read. Because the trigger touches the **audit write path**, it is **flagged for `security-reviewer`** and the `rls-tenant-audit` pgTAP suite (`01–04` + billing) is **re-run** to prove no regression — but the expectation, and the design intent, is **"no RLS change this phase."** The full security sweep (Block F) is a *verification* of `0001–0010`, not a modification.

### Decision Q7 — Release/version & source-map strategy: **tag releases by app version (`package.json` web / `app.json` `version`+`runtimeVersion` mobile); source-map upload via the Sentry build plugin gated on a server/CI-only `SENTRY_AUTH_TOKEN` that is SKIPPED when absent — so CI/contributors are never blocked**

Sentry **release** = the app version (web `package.json` version + git SHA; mobile `app.json` `version`/`runtimeVersion`), set in each `init` so events group by release (AC 2). **Source-map upload** is performed by the Sentry bundler plugin (`withSentryConfig` for Next.js; the `@sentry/react-native/expo` plugin + metro for mobile) **only when `SENTRY_AUTH_TOKEN` is present** at build time; when it is **absent** (every contributor build, all of CI) the plugin **skips upload and the build still succeeds** — no error, no blocker (spec graceful-degradation rule, AC 1, AC 30–31). `SENTRY_AUTH_TOKEN` is **server/CI-only, never committed, never in `app.json`/`eas.json`** (it would embed in the bundle). Symbolication without uploaded maps degrades gracefully to minified frames — acceptable; full maps are a USER opt-in.

---

## The `@ps/core` scrubber — NORMATIVE API (core-engineer builds exactly this)

A new **pure** module `packages/core/src/observability/` (re-exported from the core root). **No** Sentry import (operates on a minimal structural type), no framework, no `Date.now()` in logic, **>90% line coverage**, extends `purity.test.ts` (AC 4). The apps' `beforeSend`/`beforeBreadcrumb` are thin adapters that call these functions.

```ts
// packages/core/src/observability/scrub.ts

/** Sentry-shaped, but structural — core imports NO @sentry types. */
export interface SentryLikeBreadcrumb {
  type?: string; category?: string; message?: string;
  data?: Record<string, unknown>; level?: string;
}
export interface SentryLikeEvent {
  message?: string;
  request?: { url?: string; query_string?: string | Record<string, unknown>;
              headers?: Record<string, unknown>; data?: unknown; cookies?: unknown };
  tags?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  breadcrumbs?: SentryLikeBreadcrumb[];
  user?: Record<string, unknown>;
  // exception/stacktrace are intentionally preserved by the scrubber (code locations, not data)
  [k: string]: unknown;
}

export const REDACTED = '[redacted]';

/** Case-insensitive key substrings whose VALUE is always redacted. */
export const SENSITIVE_KEY_PATTERNS: readonly string[]; // token, authorization, apikey, api_key,
// secret, password, cookie, email, phone, card, cvc, pan, dsn, service_role, jwt, access_token,
// refresh_token, signing, whsec

/** String value patterns redacted regardless of key (JWT, sk_/rk_/whsec_, card-like, email). */
export const SENSITIVE_VALUE_PATTERNS: readonly RegExp[];

/** Tags permitted to leave the device. Everything else is stripped from event.tags. */
export const SAFE_TAG_KEYS: readonly string[]; // ['tenant_id','role','release','environment','route','screen']

export interface RedactOptions { maxDepth?: number; } // default depth bound (e.g. 8) — no unbounded recursion

/** Deep clone + redact: keys matching SENSITIVE_KEY_PATTERNS → REDACTED;
 *  string values matching SENSITIVE_VALUE_PATTERNS → REDACTED. Pure, bounded depth. */
export function redactValue(value: unknown, opts?: RedactOptions): unknown;

/** Strip tokens/credentials from a URL or query string. */
export function scrubUrl(url: string): string;

/** Drop any tag whose key is not in SAFE_TAG_KEYS; redact remaining values defensively. */
export function scrubTags(tags: Record<string, unknown> | undefined): Record<string, unknown>;

/** The event scrubber beforeSend delegates to: redacts request/extra/contexts/breadcrumbs,
 *  scrubs request.url + query_string, enforces the tag allowlist, removes user PII.
 *  Preserves exception type + stack frames. Returns the cleaned event (never null here —
 *  dropping is the app's policy choice). */
export function scrubEvent(event: SentryLikeEvent, opts?: RedactOptions): SentryLikeEvent;

/** The breadcrumb scrubber beforeBreadcrumb delegates to. Returns null to drop a crumb
 *  whose category is inherently sensitive (e.g. an auth/xhr body crumb), else redacts data/message. */
export function scrubBreadcrumb(crumb: SentryLikeBreadcrumb): SentryLikeBreadcrumb | null;
```

The jest suite feeds adversarial payloads — a JWT in `extra`, an email in a breadcrumb message, a Stripe `sk_` key in `request.data`, a `grand_total` money row, an `Authorization` header, a token in `request.url` query string, a disallowed `customer_email` tag — and asserts **none survive** `scrubEvent`/`scrubBreadcrumb` while `tenant_id`/`role`/`release` tags and exception stack frames **do** (AC 3–4). This is the security-review artifact.

---

## Forward-only migration (`supabase/migrations/0011_audit_atomicity_and_perf_indexes.sql`) — NORMATIVE

backend/supabase-migrate authors the file from this spec. **`security-reviewer` sign-off required (AC 6–10, 24).** Forward-only. It adds **one** trigger function + its triggers on `products`/`rate_rules`, and (only if the Q4 audit finds a hot path lacking one) forward-only indexes. It **alters no existing policy**, adds **no** `SECURITY DEFINER` data path, and changes **no** business/money behavior.

```sql
-- =============================================================================
-- Migration 0011 — Phase 10 production hardening:
--   (1) Atomic, by-construction audit for catalog/rate-rule config changes
--       (closes the web non-atomic client-insert gap; completes §2.7).
--   (2) (Optional) forward-only hot-path indexes if the perf audit finds a gap.
--
-- RLS-safe by construction:
--   * audit_config_change() is SECURITY INVOKER → the audit_log INSERT runs under
--     the caller's RLS (owner has the audit_log insert grant) and the existing
--     stamp_impersonator() BEFORE INSERT trigger still stamps meta.impersonator_id
--     from the signed claim (ADR-0008 preserved).
--   * Adds NO policy, NO WITH CHECK, NO SECURITY DEFINER data path (ADR-0007).
--   * Context-skip (ADR-0008): no JWT claims / role=service_role / null uid ⇒ no-op,
--     so seeds/backfills/service-role edits are never blocked by NOT NULL actor_id.
--   * Idempotent: deterministic audit id + ON CONFLICT DO NOTHING (§2.8).
--
-- SECURITY REVIEWER: required sign-off (AC 6–10, 24). Verify the trigger cannot
-- write another tenant's audit row (tenant_id/branch_id come from NEW; the audit_log
-- insert is RLS-checked under the caller), cannot be forged to fake impersonation
-- (stamp_impersonator strips client-supplied meta.impersonator_id), and changes no
-- money/business behavior.
-- =============================================================================

-- ── 1. audit_config_change() — atomic audit for products & rate_rules (Q3) ────
create or replace function public.audit_config_change()
returns trigger
language plpgsql security invoker set search_path = public
as $$
declare
  _claims text;
  _actor  uuid := (select auth.uid());
  _action text;
  _entity text := tg_argv[0];          -- 'product' | 'rate_rule'
  _meta   jsonb;
  _id     uuid;
begin
  -- (a) Skip non-end-user contexts (migration/seed/psql, and service_role).
  _claims := current_setting('request.jwt.claims', true);
  if coalesce(_claims, '') = '' then return null; end if;
  if (_claims::jsonb ->> 'role') = 'service_role' then return null; end if;
  if _actor is null then return null; end if;

  -- (b) Derive the action verb from TG_OP + the is_active transition.
  if tg_op = 'INSERT' then
    _action := _entity || '.create';
    _meta := jsonb_build_object('snapshot', to_jsonb(new) - 'tenant_id');
  else
    if old.is_active is distinct from new.is_active then
      _action := _entity || case when new.is_active then '.reactivate' else '.deactivate' end;
    else
      _action := _entity || '.update';
    end if;
    _meta := jsonb_build_object('before', to_jsonb(old) - 'tenant_id',
                                'after',  to_jsonb(new) - 'tenant_id');
  end if;

  -- (c) Deterministic id (idempotent on a retried upsert with the same updated_at).
  _id := md5(_action || ':' || new.id::text || ':' ||
             extract(epoch from new.updated_at)::text)::uuid;

  -- (d) Append the audit row. amount=null (config, not money). stamp_impersonator
  --     BEFORE INSERT trigger fires here and stamps meta.impersonator_id if present.
  insert into public.audit_log
    (id, tenant_id, branch_id, actor_id, action, entity, entity_id, amount, meta, created_at)
  values
    (_id, new.tenant_id, null, _actor, _action, _entity, new.id, null, _meta, now())
  on conflict (id) do nothing;

  return null;   -- AFTER trigger: return value ignored
end;
$$;

drop trigger if exists products_audit_change on public.products;
create trigger products_audit_change
  after insert or update on public.products
  for each row execute function public.audit_config_change('product');

drop trigger if exists rate_rules_audit_change on public.rate_rules;
create trigger rate_rules_audit_change
  after insert or update on public.rate_rules
  for each row execute function public.audit_config_change('rate_rule');

-- ── 2. (Optional) forward-only hot-path indexes (Q4) ─────────────────────────
-- Add ONLY if the perf audit finds a hot report/admin/subscriptions filter lacking
-- an index. Operational tables already carry (tenant_id, branch_id) indexes (0002).
-- Example (uncomment only if the audit confirms a gap — RLS-neutral):
-- create index if not exists sessions_tenant_started_idx
--   on public.sessions (tenant_id, started_at);

-- =============================================================================
-- END OF MIGRATION 0011
-- =============================================================================
```

**RLS-safety reasoning:** the trigger is `SECURITY INVOKER`, so its `audit_log` insert is subject to the caller's RLS and the `stamp_impersonator()` trigger exactly as today's client insert is — it cannot write another tenant's audit row (`tenant_id` is `NEW.tenant_id`, already RLS-bound by `products_owner_write`/`rate_rules_owner_write`), cannot be forged to fake impersonation (client-supplied `meta.impersonator_id` is stripped by `stamp_impersonator` when not impersonating — ADR-0008), and the context-skip prevents `NOT NULL actor_id` failures on seed/service-role paths. No policy is altered; no read path gains `SECURITY DEFINER`. **Verify in `rls-tenant-audit` (re-run `01–04` + billing) and `security-reviewer` sign-off (AC 6–10, 24).**

---

## Options considered (the load-bearing choices)

### Scrubber location (Decision Q1.5)
- **Option A — a pure `@ps/core/observability` scrubber both apps delegate to (CHOSEN).** Pros: one audited, unit-tested, >90%-covered source of truth for a security-critical policy; identical behavior web + mobile; `security-reviewer` signs off one artifact; fed adversarial payloads under jest with no SDK/device. Cons: a structural `SentryLikeEvent` type (no Sentry import) must track the shape loosely. Evidence: [Sentry — `beforeSend`/`beforeBreadcrumb` (modify or drop before send)](https://docs.sentry.io/platforms/javascript/configuration/options/); `CLAUDE.md` §2.4 (core purity).
- **Option B — each app owns its `beforeSend` filter.** Pros: no core type. Cons: two copies of a security policy drift; double the review surface; the exact "money/PII leak" failure mode this phase exists to prevent. Rejected.

### DSN gating (Decision Q1.1)
- **Option A — explicit `if (!dsn) return;` before `Sentry.init`, both apps (CHOSEN).** Pros: zero instrumentation overhead, zero network, zero console noise when absent — true graceful degradation (AC 1); robust beyond the SDK's implicit "no DSN ⇒ no events". Cons: a one-line guard per runtime. Evidence: [Sentry — Options (`enabled:false` does not remove all overhead; conditionally call init)](https://docs.sentry.io/platforms/javascript/configuration/options/).
- **Option B — always `init`, rely on empty DSN / `enabled:false`.** Cons: residual instrumentation overhead and ambiguous "is it on?" state in dev/CI. Rejected as the sole gate.

### Audit-atomicity mechanism (Decision Q3)
- **Option A — `AFTER INSERT OR UPDATE` `SECURITY INVOKER` trigger on `products`/`rate_rules` (CHOSEN).** Pros: audits by construction on **any** write path (RPC, direct PostgREST, future surface); composes with the existing `stamp_impersonator` trigger; one additive object; idempotent; the smallest change that is also the strongest. Cons: trigger logic to review; deterministic-id requires the `updated_at` stamp. Evidence: [PostgreSQL — trigger procedures (AFTER ROW, OLD/NEW, TG_OP)](https://www.postgresql.org/docs/current/plpgsql-trigger.html); ADR-0008 `stamp_impersonator()`.
- **Option B — a `SECURITY INVOKER` RPC `upsert_*_tx(row, audit)` (the Phase-8/9 RPC pattern).** Pros: explicit, mirrors `close_session_tx`. Cons: atomic **only if** the client calls it — `products_owner_write` still allows a direct `.upsert`, so the guarantee needs *also* revoking direct write grants + rerouting all callers (a larger change). Weaker by default. Runner-up.
- **Option C — document an accepted exception (non-money config, owner-only, RLS-guarded).** Pros: zero change. Cons: leaves §2.7 only-mostly-true on a public, launch-bound platform; the spec names this the headline gap to close. Rejected.

### A11y CI mechanism (Decision Q5)
- **Option A — `eslint-plugin-jsx-a11y` (recommended) in existing lint + extended `rtl-i18n-check` + a manual checklist for focus/contrast/safety-critical (CHOSEN).** Pros: automated gate runs with no external/paid service; catches the bulk of static violations; the manual layer owns what static analysis provably cannot (focus management, rendered contrast, screen-reader announcement). Cons: not a full WCAG audit (static-only is necessary-not-sufficient — stated honestly). Evidence: [eslint-plugin-jsx-a11y](https://github.com/jsx-eslint/eslint-plugin-jsx-a11y); [npm](https://www.npmjs.com/package/eslint-plugin-jsx-a11y).
- **Option B — a hosted axe/Lighthouse CI service.** Cons: requires an external service/runner — violates "no paid external infra in CI"; rendered-DOM checks need a running app. Deferred to operator tooling.

---

## Per-engineer hand-off

- **core-engineer:** build `packages/core/src/observability/` to the **normative scrubber API** above — `redactValue`/`scrubUrl`/`scrubTags`/`scrubEvent`/`scrubBreadcrumb`, the `SENSITIVE_KEY_PATTERNS`/`SENSITIVE_VALUE_PATTERNS`/`SAFE_TAG_KEYS` constants, bounded recursion depth; **pure** (no Sentry/framework import, no `Date.now()` in logic); re-export from the core root; **>90% coverage** with the adversarial-payload suite; extend `purity.test.ts` (AC 4). Plus the **hot-path sanity check** (pricing/outbox/entitlements — no quadratic loops, no public API change, AC 17).
- **web-engineer:** add Sentry for Next.js (`instrumentation-client.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts`, `instrumentation.ts` with `onRequestError`, `app/global-error.tsx`) — **DSN-gated `if (!dsn) return;`**, `tracesSampleRate:0`, no Replay, `sendDefaultPii:false`, `beforeSend`/`beforeBreadcrumb` delegating to the core scrubber; `withSentryConfig` source-map upload gated on `SENTRY_AUTH_TOKEN` (skip when absent, Q7). **Remove** the separate client-side `audit_log` upsert from `ProductForm.tsx`/`ProductsView.tsx`/`RateRulesView.tsx` (the `0011` trigger now owns it, Q3). Apply perf wins to hit the route/bundle budget (dynamic-import the reports chart/CSV, Q4). Add `eslint-plugin-jsx-a11y` (recommended) + a11y fixes (roles/labels/focus-management/keyboard/contrast, Q5). **No Sentry auth token in the bundle** (AC 5).
- **mobile-engineer:** add Sentry for Expo (`@sentry/react-native`, the `@sentry/react-native/expo` plugin in `app.json` with no auth token, `getSentryExpoConfig` in `metro.config.js`, `initSentry()` **DSN-gated**, `Sentry.wrap(App)`, scrubber-delegated `beforeSend`/`beforeBreadcrumb`) — no-op when `EXPO_PUBLIC_SENTRY_DSN` absent (AC 1). Author **`eas.json`** (`development`/`preview`/`production`) + `app.json` `runtimeVersion: {policy:"appVersion"}` + per-profile `EXPO_PUBLIC_*` (publishable only) + documented `eas build`/submit commands (Q2), verified by `expo export`/`expo prebuild` locally (AC 11–13). Ensure every growable list is virtualized (Q4, AC 16). Add `accessibilityLabel`/`accessibilityRole` + 44pt touch targets, extra care on the offline/sync + money-discard surfaces (Q5, AC 22–23).
- **backend / supabase-migrate:** author `0011_audit_atomicity_and_perf_indexes.sql` **verbatim** from the normative SQL (the `audit_config_change()` `SECURITY INVOKER` trigger on `products`/`rate_rules`; forward-only indexes **only** where the Q4 audit confirms a gap). Forward-only; weaken no policy. Support the security sweep — **re-run `rls-tenant-audit` `01–04` + billing isolation across `0001–0011`**. **`security-reviewer` sign-off before merge.**
- **ux-designer:** a11y token/contrast adjustments (≥ 4.5:1 against current tokens), a consistent **focus-visible** ring, dialog **focus-management** behavior, and accessible presentation of the **impersonation banner / money-discard confirm / paywall-read-only** surfaces — within the existing design system, no restyle (§7, Q5).
- **security-reviewer (REQUIRED — release blocker):** owns **Block F** (full platform security pass) + **co-signs Q1** (scrubbing). Confirm: (1) the core scrubber provably blocks tokens/cards/Stripe/email-PII/`.env`/raw-money-rows and enforces the tag allowlist (Block A AC 3–4, Block F AC 29) — review the adversarial jest suite; (2) `0011`'s audit trigger completes §2.7 without weakening RLS or adding a `SECURITY DEFINER` data path, cannot cross tenants, cannot fake impersonation (Block B AC 6–10, AC 24); (3) RLS on **all** tables `0001–0011`, correct edge-function auth (only `stripe-webhook` `verify_jwt=false` + signature on raw body; service-role in no client bundle), impersonation + webhook trust boundaries intact (ADR-0008/0010 preserved — AC 24–27); (4) **secret hygiene on the PUBLIC repo** — `.env` gitignored, **no secret in the working tree OR git history**, the publishable DSN is client-safe, no `SENTRY_AUTH_TOKEN` committed, and the **exposed-key rotation reminder** is carried to the user (AC 28). Any leak, unscrubbed PII path, committed secret, or RLS regression **blocks the gate**.
- **QA gates on:** **Block A** (DSN-gated init + no-op-when-absent + scrubbing) and **Block F** (security/RLS/secret-hygiene) as **hard gates**; **Block B** (audit completeness) as a money-integrity gate; **Block C** (EAS builds locally without credentials), **Block D** (perf budgets), **Block E** (a11y) as functional gates; **Block G** (`ps-verify` green **with and without** secrets) as definition of done. Critical set: **AC 1–4, 8–11, 24–29, 31.**

## Consequences

- **Becomes easy:** production failures on web + mobile become visible (the ADR-0009 deferral closed) **without** ever leaking tenant/PII/secret/money data — one pure, >90%-tested scrubber is the single audited policy; the §2.7 audit invariant becomes **provably complete and atomic by construction** (config changes can no longer persist unaudited, even via direct PostgREST); the mobile app is distributable via documented EAS profiles; perf and a11y have inspectable budgets/gates; the platform has a final, signed-off security posture on a public repo. CI and contributors are **never blocked on an external account** — every integration no-ops without its env var.
- **Becomes hard / accepted risk:** the `0011` audit trigger fires on every `products`/`rate_rules` write (negligible at café scale, but it is one more object on the write path — mitigated by the context-skip + deterministic-id idempotency); source maps require a USER `SENTRY_AUTH_TOKEN` (without it, symbolication degrades to minified frames — acceptable, opt-in); `eslint-jsx-a11y` is static-only (the manual checklist owns focus/contrast/screen-reader items — stated, not hidden); live Sentry ingestion, cloud `eas build`, and store submission are **post-gate USER steps** (CI proves only graceful-degradation-without-secrets); tracing/replay are off (no APM this phase).
- **Follow-up / deferred:** live-Sentry ingestion verification, cloud EAS builds + store submission, and key rotation (USER steps); Sentry performance tracing / session replay / APM; load + penetration testing as paid services; a hosted axe/Lighthouse a11y CI; web offline support; `stripe_events` retention. (All explicit spec out-of-scope.)
- **Must verify (Phase-10 gates):** `ps-verify` green **with and without** Sentry/Expo secrets (AC 30–31); the scrubber's adversarial jest suite proves **no** token/card/Stripe/email/`.env`/money-row survives `beforeSend` and only allowlisted tags ship, with **>90%** core coverage (AC 3–4); `rls-tenant-audit` (`01–04` + billing) stays green across `0001–0011` with the `0011` trigger added (AC 24–25); the audit-completeness inventory shows **zero** unaudited money/lifecycle write paths and the catalog/rate-rule write is now atomic (AC 6–10); a bundle scan finds **no** auth token / `service_role` key in `next build` output (AC 5, 28); `expo export`/`eas.json` validate **without** an Expo account (AC 11–13); the secret-hygiene scan over working tree **and git history** is clean (AC 28). **Sign-off:** `security-reviewer` on the scrubbing policy + the `0011` trigger + the full platform sweep (release blocker); human project owner at the Phase-10 gate on the Q1 privacy posture, the Q4 perf budget, and the Q5 a11y target — **this is the platform's launch-readiness sign-off. Never auto-approve.**

## User-only actions (cannot be done by the CLI/agents — required before/at the gate, none committed)

1. **Sentry:** create a Sentry account + a project each for web and mobile; supply the **publishable** `NEXT_PUBLIC_SENTRY_DSN` (web env) and `EXPO_PUBLIC_SENTRY_DSN` (mobile env / EAS profile). Optional: a **server/CI-only** `SENTRY_AUTH_TOKEN` for source-map upload (uncommitted, EAS secret / CI env). Verify live event ingestion post-gate (not in CI).
2. **Expo/EAS:** create/confirm an Expo account; run `eas login` + `eas build:configure` (credential generation); perform cloud `eas build` (development/preview/production) and any store submission (post-gate; not in CI).
3. **Secret hygiene / rotation (PUBLIC repo):** confirm all `.env` files are local-only and gitignored; **rotate any key ever exposed** in the public repo's history (Stripe secret/signing, Supabase `service_role`, any Sentry auth token) — the standing reminder; keep all live keys out of the repo.
4. **Approve at the gate:** the observability **privacy posture** (Q1 — whether `tenant_id`/`role` may be sent as triage tags), the **performance budget** (Q4), and the **a11y conformance target + CI mechanism** (Q5). Acknowledge that live Sentry ingestion / cloud EAS builds / store submission are separate human steps post-gate.

## Sources

- Sentry — Options (DSN is the gate: "if this is not set, the SDK will not send any events"; `enabled:false` does not remove all overhead — conditionally call init; `beforeSend`/`beforeBreadcrumb` modify or drop before send; manual PII stripping): https://docs.sentry.io/platforms/javascript/configuration/options/
- Sentry — Next.js manual setup (App Router init files: `instrumentation-client.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts`, `instrumentation.ts` + `onRequestError`, `app/global-error.tsx`; `NEXT_PUBLIC_SENTRY_DSN`): https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/
- Sentry — Expo manual setup (`@sentry/react-native`, `@sentry/react-native/expo` config plugin, `getSentryExpoConfig` metro, `Sentry.wrap`, never put authToken in app.json — it embeds in the bundle): https://docs.sentry.io/platforms/react-native/manual-setup/expo/
- Expo — Using Sentry (Expo SDK 50+, plugin + metro config, source maps via env auth token, not committed): https://docs.expo.dev/guides/using-sentry/
- eslint-plugin-jsx-a11y (static a11y AST checker; `recommended`/`strict` shareable configs; static-only — pair with rendered-DOM checks): https://github.com/jsx-eslint/eslint-plugin-jsx-a11y
- eslint-plugin-jsx-a11y — npm: https://www.npmjs.com/package/eslint-plugin-jsx-a11y
- W3C — WCAG 2.1 (Level AA success criteria: 4.5:1 contrast, visible focus, keyboard operability, labels): https://www.w3.org/TR/WCAG21/
- PostgreSQL — Trigger procedures (AFTER ROW triggers, OLD/NEW, TG_OP, raising with errcode): https://www.postgresql.org/docs/current/plpgsql-trigger.html
- Expo — EAS Build configuration with `eas.json` (build profiles, channels, env, runtimeVersion policy): https://docs.expo.dev/build/eas-json/
</content>
</invoke>
