# Phase 10 — Production hardening (the launch-readiness pass)

> Surfaces: **all** (`apps/web`, `apps/mobile`, `supabase`, `packages/core`) — but **cross-cutting**, not feature work. This is the **final roadmap phase**: it makes the feature-complete platform (Phases 2–9) observable, auditable end-to-end, buildable for distribution, fast, accessible, and security-clean — **without adding product features and without regressing any CLAUDE.md non-negotiable.**
> Anchors: [CLAUDE.md §2.1](../../CLAUDE.md) (money is integer piastres — unchanged), [§2.7](../../CLAUDE.md) (auditable money — this phase *completes* the audit invariant), [§5](../../CLAUDE.md) (RLS/tenant isolation + **no secret committed**; the repo is **PUBLIC**), [§2.6](../../CLAUDE.md) (Arabic-first RTL — a11y builds on it), [§7](../../CLAUDE.md) (`ps-verify` gate must stay green). Prior decisions reused: every ADR 0002–0010 (this phase verifies them, does not relitigate them). New decisions land as **ADR-0011 (observability, build & hardening)**.
> Status: 🟡 needs spec → architect (ADR-0011) → build → review. **Security- and privacy-sensitive** (Sentry must never exfiltrate tenant/PII/money/secret data; the repo is public so a secret-hygiene scan is mandatory). `security-reviewer` sign-off REQUIRED. **External-account dependencies (Sentry DSN, Expo/EAS credentials) are USER-only and MUST NOT block CI** — every integration **no-ops / degrades gracefully when its env var is absent** (dev/CI). Nothing requiring paid external infra is run in CI.

---

## 1. Problem & goal

PS-Managment is feature-complete through Phase 9: pure `@ps/core` (money/time/pricing/inventory/outbox/entitlements), a Next.js web app (owner dashboard + reports + super-admin portal + billing), an Expo mobile counter app (sessions/orders/inventory/shifts + offline outbox), and a Supabase backend (migrations `0001–0011`, edge functions, live pgTAP isolation tests in CI). **What it lacks is launch-readiness.** When something breaks in production there is **no error visibility** (no crash/exception reporting on web or mobile). The **audit invariant (§2.7)** is *mostly* honored but has not been swept end-to-end, and at least one class of writes (web catalog/rate-rule changes) records its `audit_log` row as a **separate client-side insert after** the data write — non-atomic and client-skippable. The mobile app **has no distributable build config** (no `eas.json`, no build profiles). There is **no performance budget** (bundle/route sizes, query shapes, list virtualization are unmeasured). There has been **no formal accessibility pass** (RTL is implemented, but semantic roles, focus management, contrast, touch targets, keyboard nav are unverified). And there has been **no final platform-wide security sweep** now that all tables, edge functions, and the billing trust boundary exist — on a **public repository**.

Phase 10 closes all six gaps as **hardening**: (1) **error tracking/observability** — Sentry on web + mobile, **init gated by a DSN env var**, with a strict `beforeSend` **scrubbing policy** so no PII/secrets/money-identifying tenant data ever leaves the device beyond what triage needs; (2) **audit-trail completeness** — a sweep that proves every money/lifecycle action writes an `audit_log` row with actor/tenant/(amount where applicable), and closes any gap found (atomicity of web audit writes is the headline finding); (3) **EAS build config** — `eas.json` + app config for dev/preview/production profiles with env wiring and documented commands, building locally without cloud credentials; (4) **performance pass** — measurable web bundle/route budgets, an N+1 audit of report/admin queries, mobile list virtualization where lists can grow, and `@ps/core` hot-path sanity; (5) **accessibility pass** — WCAG-AA-where-feasible on web (roles, labels, focus, contrast, keyboard) and mobile (`accessibilityLabel`/`accessibilityRole`, touch targets), with **extra scrutiny on safety-critical surfaces** (impersonation banner, money/discard confirmations, paywall/read-only state); (6) **full security pass** — a final `security-reviewer` sweep over RLS across all tables (incl. `0010`/`0011`), edge-function auth, the impersonation + webhook trust boundaries, and **secret hygiene on a public repo** (.env gitignored, history clean, the standing exposed-key rotation reminder). The win: the platform can be launched and operated with confidence — failures are visible, money is provably auditable, the mobile app is distributable, the UI is fast and accessible, and the security posture is signed off.

**Roles touched:** indirectly **all** — but this phase adds **no role-facing feature**. `super_admin`/`owner`/`manager`/`staff` get a more reliable, accessible, observable app; the **developer/operator** (and the project owner) gain crash visibility, build pipelines, and a security checklist. The new external actor is **Sentry** (an error-ingest endpoint that must receive only scrubbed, non-sensitive data) and **EAS/Expo** (a build service requiring the user's account for *cloud* builds only).

---

## 2. Prior art (reuse — do not reinvent)

| Asset | Location | Phase-10 use |
|---|---|---|
| `ps-verify` gate (tsc / jest / expo export / next build) | `docs/reference`, CI | The hard floor — Phase 10 must keep all four green **with and without** Sentry/EAS secrets present. New deps must not break offline-of-secrets builds. |
| CI: 3 jobs incl. **live pgTAP** isolation suite | `.github/workflows/ci.yml` | The security/RLS sweep re-runs and extends this; the secret-hygiene scan is added here. CI must stay green **without** any Sentry/Expo secret. |
| `rtl-i18n-check` skill | `.claude/skills` | The accessibility pass extends (does not replace) it — a11y ACs are checked alongside RTL/i18n. |
| `rls-tenant-audit` + `security-reviewer` patterns; isolation pgTAP `01–04` | `supabase/tests/*`, ADR-0002/0004/0008 | The full security pass re-runs the whole suite across `0001–0011` and signs off; no policy is relitigated, only verified + gaps closed. |
| `audit_log` schema (`tenant_id`, `actor_id`, `action`, `entity`, `entity_id`, `amount`, `meta`, `created_at`; `impersonator_id`) + locked taxonomy | `0002_*`, ADR-0006/0008, Phase-9 | The audit-completeness sweep inventories every action against this schema; any new atomicity fix reuses it (no schema change expected — confirm). |
| Existing audit actions in code | mobile `session.close`/`order.pay`/`order_item.void`/`stock.restock`/`stock.adjust`/`shift.open`/`shift.close`; web `product.*`/`rate_rule.*`; edge `tenant.suspend`/`tenant.reactivate`/`impersonation.start`/`impersonation.stop`/`subscription.*` | The sweep's checklist; the headline gap is **web catalog/rate-rule audit rows written as a separate client-side insert** (`ProductForm.tsx`, `ProductsView.tsx`, `RateRulesView.tsx`) — non-atomic, client-skippable. |
| `@ps/core` purity model (`no Date.now()` in decisions, no framework imports, >90%) | `packages/core` | If a tiny scrubber helper lands in core (§6 Q1) it follows these rules. Hot-path perf sanity checks reuse the existing jest setup. |
| `OfflineBanner` / sync-status UI; impersonation banner; money/discard confirms; paywall/read-only banners | Phases 7/8/9 (`apps/web`, `apps/mobile`) | The **safety-critical a11y surfaces** — these get extra scrutiny, not redesign. |
| Web design tokens / design system | `docs/design/design-system.md`, `apps/web` Tailwind config | Color-contrast checks run **against these tokens**; the pass reports failures, the ux-designer adjusts tokens if needed. |
| Expo app config | `apps/mobile/app.json` (`slug: ps-managment`, bundle/package ids set, `expo-secure-store`/`expo-sqlite` plugins) | EAS config extends this; identifiers already exist. |

**Default stance:** Phase 10 **verifies and hardens** what Phases 2–9 built. It adds infrastructure (Sentry, EAS, perf/a11y/security checks), not product behavior. Anything that would change tenant data, money math, RLS, or business logic is **out of scope** unless it is closing an audit/security gap, and any such change is called out explicitly (§7) and signed off.

---

## 3. Scope

### In scope

- **3.1 Error tracking / observability (web + mobile).** Integrate Sentry in `apps/web` (Next.js — client, server, and edge runtimes as applicable) and `apps/mobile` (Expo). **Init is gated by an env var** (`NEXT_PUBLIC_SENTRY_DSN` for web, `EXPO_PUBLIC_SENTRY_DSN` for mobile — publishable DSNs are client-safe per Sentry's model). When the DSN is **absent** (dev/CI/contributors), Sentry **does not initialize** and the app behaves exactly as today (no crash, no console noise, no network calls). When present, it captures **unhandled errors + unhandled promise rejections** with scrubbed context (§3.1.1). Any **server-side/auth token** (e.g. a source-map upload `SENTRY_AUTH_TOKEN`) is **server/CI-only and uncommitted**; source-map upload is optional and skipped when the token is absent.
  - **3.1.1 Scrubbing / `beforeSend` policy (CRITICAL).** A documented, enforced policy defines what may and may not leave the device. **NEVER sent:** card data, Stripe secrets/keys, any access/refresh/JWT token or auth header, user **email**/name/phone, raw tenant **rows** (sessions/orders/money amounts tied to a tenant), request/response bodies containing the above, `.env` values. **Allowed for triage (subject to the architect/security privacy call, §6 Q1):** a coarse `tenant_id` **tag** and `role` for grouping, app version/release, route/screen name, error type/stack. `beforeSend` (and breadcrumb scrubbing) strips disallowed fields **before** transmission; URLs/query strings are scrubbed of tokens. The policy lives in `docs/` and is the security-review artifact.
- **3.2 Audit-trail completeness sweep (§2.7).** Produce an **inventory** mapping every money- and lifecycle-affecting action across Phases 4–9 to its `audit_log` write (actor / tenant / amount-where-applicable / entity). Confirm each is present and **atomic with the state change**. Close any gap found. Known candidates to resolve:
  - The **web catalog/rate-rule audit gap**: `product.create|update|deactivate|reactivate` and `rate_rule.deactivate|reactivate` write the `audit_log` row as a **separate client-side insert after** the data upsert — if that insert is skipped/fails/forged, the change persists unaudited. Decide and apply the fix (atomic DB trigger or SECURITY DEFINER RPC vs. accept-with-rationale because non-money config) — §6 Q3.
  - Confirm **money** actions (`session.close`, `order.pay`, `order_item.void`, `stock.*`, `shift.*`, `subscription.*`) carry `amount` (in the correct money axis) and an actor; confirm **impersonated** rows stamp `impersonator_id`.
  - Confirm there is **no money/lifecycle write path with no corresponding audit row** (e.g. session start, device status, discount application if reachable) — list each as covered or a documented intentional non-audit (non-money config).
  - **No new business tables/features.** The output is a doc + (if needed) a forward-only migration/code fix that only adds/relocates audit writes, signed off by `security-reviewer`.
- **3.3 EAS build config (mobile).** Add `eas.json` with **`development`, `preview`, `production`** profiles, extend `app.json`/app config as needed (channels, runtime version policy, env wiring per profile via `EXPO_PUBLIC_*`), and document the build/submit commands. **Local verification only:** `expo prebuild` (or config validation) and the existing `expo export` must succeed **without** an Expo account/credentials. **Actual cloud builds (`eas build`) and store submission require the USER's Expo account** and are flagged as a USER-only hand-off (§8) — not run in CI.
- **3.4 Performance pass (measurable, inspectable — not "make it fast").**
  - **Web:** record a **bundle/route-size budget** (current routes are ~100–300 kB First Load JS; set a per-route ceiling and a total-shared-JS ceiling) verified from `next build` output; identify and apply **obvious wins only** (e.g. dynamic-import a heavy chart/CSV path, drop an unused dep) without behavior change.
  - **Backend/queries:** audit the **report/admin/subscriptions** read paths for **N+1** patterns and missing indexes on the hot filter columns (`tenant_id`/`branch_id`/business-day/date-range); document each query's shape and confirm it uses an index. No new aggregation behavior — verify, and add an index migration only if a hot path lacks one (forward-only, no RLS change).
  - **Mobile:** ensure every **growable list** (device grid, order/catalog lists, audit/sync dead-letter lists, sessions history) uses a **virtualized** list (`FlatList`/`FlashList`-style) rather than mapping into a `ScrollView`; document which lists were checked.
  - **`@ps/core`:** a hot-path sanity check (pricing/outbox/entitlements resolvers run in O(reasonable) with no accidental quadratic loops); no API change. Perf-budget **targets** are an architect call (§6 Q4).
- **3.5 Accessibility pass (a11y, building on RTL §2.6).**
  - **Web (target WCAG 2.1 AA where feasible — §6 Q5):** semantic roles/landmarks; every interactive control has an accessible name/label; **focus management in dialogs** (focus trap, restore focus on close, `Esc` to close) for all modals (lifecycle dialogs, comp/override, money/discard confirms); **keyboard navigation** for all primary flows (tab order, visible focus ring); **color contrast** of text/controls/status colors **against the design tokens**; form fields have associated labels and error messaging; data tables have headers. Report failures; ux-designer adjusts tokens/markup.
  - **Mobile:** interactive elements carry `accessibilityLabel` + `accessibilityRole`; status/badges expose state to screen readers; **touch targets ≥ 44×44 pt**; dynamic content (timers, sync status) announces appropriately where safety-relevant.
  - **Safety-critical surfaces get extra scrutiny:** the **impersonation banner** (must be announced/unmistakable), **money/discard confirmations** (clear, focus-managed, not dismissible by accident), and the **paywall/read-only** state must be perceivable by assistive tech.
  - **How it's checked in CI** (lint/axe addition vs. manual checklist) is an architect call (§6 Q5); at minimum a documented a11y checklist + the extended `rtl-i18n-check`.
- **3.6 Full security pass (final platform-wide sweep — REQUIRED sign-off).** `security-reviewer` re-runs and extends the standing checks across the **whole** platform now that all tables/functions exist:
  - **RLS across all tables incl. `0010`/`0011`** — every `public` table has RLS enabled + explicit policies; tenant A cannot read/write tenant B (re-run `rls-tenant-audit` pgTAP `01–04` + billing isolation); no operational policy carries an `OR is_super_admin()` / `OR true` / service-role escape.
  - **Edge-function auth** — each function (`provision/suspend/reactivate-tenant`, `impersonate/end-impersonation`, `custom-access-token-hook`, `stripe-webhook`, `create-checkout/portal-session`, `set-tenant-plan`) has the correct guard: DB-authoritative role checks for user-invoked functions; `verify_jwt=false` **only** for the signature-verified webhook; service-role used only server-side; no service-role key in any client bundle.
  - **Trust boundaries** — re-verify **impersonation** (server-minted, time-boxed, audited, no RLS-bypass branch — ADR-0008) and the **Stripe webhook** (raw-body signature verify, idempotent on `event.id`, server-side `customer→tenant` map — ADR-0010) hold.
  - **Secret hygiene on a PUBLIC repo (CRITICAL)** — a scan confirming `.env`/secret files are **gitignored**, **no secret is committed anywhere in the working tree**, and **git history is clean** of keys since the repo went public. Carry forward the **standing exposed-key rotation reminder** (any key ever exposed must be rotated by the user). Confirm Sentry DSNs are publishable/client-safe and any auth token stays server/CI-only.
  - Output: a **security checklist** (the ACs in Block F) signed off as a release blocker.

### Out of scope (deferred / not this phase)

- **Net-new product features** of any kind (no new screens, money math, business tables, or role capabilities). Phase 10 is hardening only.
- **Load testing / penetration testing as a paid service**, third-party security audit, SOC2/compliance certification — note as future operator work; not run here.
- **Anything requiring paid external infra to RUN in CI** — actual Sentry event ingestion verification, `eas build` cloud builds, store submissions, live Stripe charges. These are USER-only hand-offs; CI proves only graceful-degradation-without-secrets.
- **APM / performance monitoring / tracing / session replay / uptime monitoring** as products (Sentry **error** capture only this phase; performance-tracing/replay sampling = note-only, default off).
- **Structured logging / log aggregation backend, alerting/on-call, dashboards** beyond Sentry error capture.
- **Web offline support, new realtime, multi-currency/timezone generalization** (unchanged prior deferrals).
- **Redesigns** — the a11y pass adjusts tokens/markup/labels to meet criteria; it does not restyle surfaces.
- **i18n language expansion** beyond Arabic-first/EGP (unchanged).
- **CI infra migration** (new runners/services); only additive checks (secret scan, optional a11y lint) that pass without external secrets.

---

## 4. User stories

- **As the platform operator, I want unhandled errors on web and mobile reported to Sentry with scrubbed context,** so that I can diagnose production failures without combing logs.
- **As the project owner, I want certainty that error reports never contain card data, tokens, customer PII, or tenant money rows,** so that observability never becomes a data leak. (Privacy-critical story — enforced by the `beforeSend` scrubbing policy and proven by tests.)
- **As a developer/contributor, I want the app to build and run identically when no Sentry DSN or Expo credentials are present,** so that CI and local dev are never blocked on external accounts. (Graceful-degradation story.)
- **As the project owner, I want proof that every money and lifecycle action writes an audit row atomically with the change,** so that the §2.7 "auditable money" guarantee actually holds in production.
- **As the platform operator, I want documented EAS build profiles and commands,** so that I can produce distributable dev/preview/production builds of the mobile app.
- **As any user, I want the app to load fast and lists to stay smooth as data grows,** so that the counter and dashboard are usable under real load. (Verified via budgets, not vibes.)
- **As a user relying on assistive technology or a keyboard, I want labels, focus management, contrast, and adequate touch targets,** so that I can operate the app — especially the impersonation banner, money confirmations, and paywall.
- **As the project owner, I want a final platform-wide security sign-off on a public repo,** so that I can launch knowing isolation holds, secrets aren't committed, and trust boundaries are intact.
- **As a tenant, I want certainty that hardening changed none of my isolation, money, or RTL guarantees,** so that launch-readiness work introduced no regression. (Negative story — the `ps-verify` + isolation + RTL gates must stay green.)

---

## 5. Domain notes (CLAUDE.md / ADR links)

- **§2.7 Auditable money (the completeness target):** the invariant is "every money-affecting action writes an `audit_log` row with actor, tenant, timestamp, amount." Phase 10 *proves* it holds and closes gaps. The **atomicity** concern is central: a web audit row written as a separate client insert **after** the data write is **not** equivalent to an atomic guarantee — the architect decides whether to enforce atomicity (trigger/RPC) or document an accepted exception for non-money config changes (§6 Q3). No new money math; amounts stay integer minor units (§2.1) in the correct axis (café EGP piastres vs. subscription currency — Phase 9).
- **§5 Tenancy & security + PUBLIC repo:** the security sweep re-confirms RLS on every table (incl. `0010`/`0011`), `WITH CHECK` on writes, JWT-claim-derived tenant identity, and **no secret committed**. Because the repo is **public**, secret hygiene is elevated: gitignore + working-tree + **history** scan, and the standing rotation reminder for any previously-exposed key. Sentry DSNs are **publishable** (client-safe by design); any `SENTRY_AUTH_TOKEN` is server/CI-only and uncommitted.
- **Privacy / data-minimization (new, Sentry-driven):** observability must honor data-minimization. `tenant_id` as a triage **tag** is likely acceptable (it groups errors without exposing café data) but it is a **privacy call for the architect/security** (§6 Q1) — user **email/PII is NOT** acceptable. The `beforeSend` policy is the enforcement mechanism and a security-review artifact.
- **§2.6 Arabic-first / RTL → a11y:** the a11y pass **extends** RTL/i18n. Accessible names must come from i18n resources (no hardcoded labels); contrast is checked against the existing design tokens; focus order respects RTL. The a11y target (WCAG AA where feasible) and CI-check mechanism are §6 Q5.
- **§2.4 `@ps/core` purity:** if a scrubber helper is warranted in core (§6 Q1), it is pure (no framework imports, no `Date.now()` in logic, >90% tested). The Sentry SDK itself is **never** imported into `@ps/core` (core stays framework-free). Perf hot-path checks add no API.
- **§7 `ps-verify` must stay green:** all four steps (tsc / jest / expo export / next build) plus CI's live pgTAP must pass **with and without** Sentry/Expo secrets. A new dependency that breaks the secret-absent build is a defect.
- **ADRs 0002–0010 preserved:** Phase 10 verifies them. The security sweep must find **no** regression to the shared-DB+RLS model (0002/0004), the auth-claim/impersonation model (0003/0008), pricing/orders/reporting invariants (0005/0006/0007), the outbox/realtime model (0009), or the billing/webhook isolation (0010). Any change that *touches* RLS is flagged (§6 Q6) — none is expected beyond possibly an index migration.

---

## 6. Architect decisions to flag (need ADR-0011 — do not decide here)

> The product spec deliberately does **not** decide these. The architect resolves them in **ADR-0011 (observability, build & hardening)** before build.

- **Q1 — Sentry init architecture + `beforeSend` scrubbing + safe context (central privacy/security call).** Where/how is Sentry initialized for each runtime — Next.js client vs. server vs. edge (instrumentation/config files), and Expo (root + error boundary)? What is the exact `beforeSend`/breadcrumb scrubbing implementation and the **allowlist of tags** (is `tenant_id` acceptable for triage? `role`? release/version? — **email/PII is NOT**)? Is a small **pure `@ps/core` scrubber** helper warranted (shared, testable) or does each app own its filter? Confirm sampling (errors only; tracing/replay off or minimal) and that init is fully **no-op when the DSN env is absent**. **Privacy decision is security-central** — co-sign with `security-reviewer`.
- **Q2 — EAS profile/env strategy.** The `eas.json` profile matrix (`development`/`preview`/`production`): distribution (internal vs. store), `EXPO_PUBLIC_*` env wiring per profile (incl. the Supabase URL/anon key and `EXPO_PUBLIC_SENTRY_DSN`), runtime-version policy, and update channels. Confirm what is verifiable locally (`expo prebuild`/`expo export` config validity) vs. what needs the user's Expo account (cloud `eas build`). No secret committed.
- **Q3 — Audit-completeness: does closing the gap need a migration or is it code/doc only?** For the web catalog/rate-rule non-atomic audit writes: enforce **atomicity** via a DB trigger or a SECURITY DEFINER RPC that writes the row in the same txn, **or** accept the current pattern with documented rationale (non-money config, owner-only, RLS-guarded)? If money actions are involved anywhere, atomicity is required. Likely **doc + small code/trigger** only — confirm whether any forward-only migration lands and that it changes **no** RLS/business behavior.
- **Q4 — Performance budget targets.** The concrete numbers: per-route First-Load-JS ceiling and total shared-JS ceiling for web (against current ~100–300 kB), the list-size threshold that mandates virtualization on mobile, and which query shapes must be index-backed. How is the budget enforced/inspected (manual from `next build` output vs. a checked-in budget file)? Targets must be achievable without behavior change.
- **Q5 — Accessibility conformance target + CI mechanism.** Confirm the target (e.g. **WCAG 2.1 AA where feasible**, with documented exceptions for Stripe-hosted external pages and any deferred item). How is a11y checked in CI — extend `rtl-i18n-check`, add an axe/eslint-jsx-a11y lint (must pass without external services), or a documented manual checklist per surface? Define the minimum automated gate vs. manual review split.
- **Q6 — Does anything here touch RLS / data model? (Expect: no.)** Confirm the only possible schema change is a **forward-only index** migration for a hot query (Q4) and/or an audit-atomicity trigger (Q3) — neither weakening RLS nor altering tenant isolation. If any change touches a policy, it is flagged and re-runs `rls-tenant-audit` with `security-reviewer` sign-off. If truly none, state "no RLS change this phase."
- **Q7 — Release/version & source-map strategy.** How are releases/versions tagged in Sentry (app version from `app.json`/`package.json`) for both apps, and is source-map upload enabled (optional, requires a server-only `SENTRY_AUTH_TOKEN`, **skipped when absent** so CI/contributors are unaffected)? Confirm no auth token is committed.

---

## 7. Open questions (design / human call)

**UX-designer — must design/adjust (fresh, RTL/Arabic-first; `ui-ux-pro-max` + magic MCP):**

- Any **token/contrast adjustments** the a11y pass surfaces (text/status/control colors failing AA against current tokens) — minimal, within the existing design system, not a restyle.
- **Focus-visible** styling (visible keyboard focus ring) consistent across web controls, and the **focus-management** behavior for dialogs (lifecycle, comp/override, money/discard confirms, paywall).
- The accessible presentation of **safety-critical surfaces** (impersonation banner, money/discard confirmation, read-only/paywall state) — perceivable to assistive tech without changing their meaning.
- (No new screens.) Loading/empty/error states already exist; a11y verifies they are announced, not redesigned.

**Human call (at the gate):**

- Approve the **observability privacy posture** (Q1): whether `tenant_id`/`role` may be sent to Sentry as triage tags (the project owner's data-handling call).
- Approve the **performance budget targets** (Q4) and the **a11y conformance target + CI mechanism** (Q5).
- Acknowledge and perform the **USER-only setup** (§8): Sentry account/DSNs, Expo account + EAS credentials, and **rotate any previously-exposed key**.
- Confirm this gate verifies **graceful-degradation-without-secrets** and that live Sentry ingestion / cloud EAS builds / store submission are **separate human steps** post-gate. **Never auto-approve.**

---

## 8. Hand-off

- **Architect:** write **ADR-0011** resolving Q1–Q7; the central calls are the **Sentry init + `beforeSend` scrubbing + safe-tag allowlist (Q1, security-central)**, the **EAS profile/env strategy (Q2)**, the **audit-atomicity decision (Q3)**, the **perf budget targets (Q4)**, and the **a11y target + CI mechanism (Q5)**. Confirm **no RLS/data change** beyond at most a forward-only index/audit-trigger (Q6). Produce the audit-completeness **inventory** as the sweep's reference artifact.
- **Web engineer:** Sentry for Next.js (client/server/edge, DSN-gated, scrubbing per Q1, no-op when absent); apply perf wins to hit the route/bundle budget (Q4); implement a11y fixes (roles/labels/focus/keyboard/contrast — Q5); if Q3 elects a web-side fix, route catalog/rate-rule audit through the atomic path. No Sentry secret/auth-token in the bundle.
- **Mobile engineer:** Sentry for Expo (DSN-gated, scrubbing, no-op when absent, error boundary + unhandled-rejection capture); add `eas.json` + app-config profiles + env wiring + documented commands (Q2), verified by `expo prebuild`/`expo export` locally; ensure growable lists are virtualized (Q4); add `accessibilityLabel`/`accessibilityRole` + 44pt touch targets (Q5), extra care on the offline/sync + money-discard surfaces.
- **Backend engineer:** close any audit-completeness gap (atomic trigger/RPC per Q3, forward-only, no RLS/business change); add a hot-path index migration only if Q4 finds one missing; support the security sweep (re-run pgTAP `01–04` + billing isolation across `0001–0011`).
- **Core engineer (only if Q1 elects it):** a pure `@ps/core` scrubber helper (no framework imports, no `Date.now()` in logic, >90% tested); plus the `@ps/core` hot-path perf sanity check (no API change).
- **UX-designer:** a11y token/contrast/focus adjustments + safety-critical-surface accessibility per §7 (within the existing design system).
- **security-reviewer (REQUIRED sign-off — release blocker):** owns Block F (full security pass) and co-signs Q1 (Sentry privacy/scrubbing). Confirms: RLS across all tables incl. `0010`/`0011`; correct edge-function auth (incl. webhook `verify_jwt=false` + signature); impersonation + webhook trust boundaries intact; **no secret committed (working tree + history) on the public repo**; the `beforeSend` policy provably blocks PII/secrets/money/tenant-rows; the exposed-key rotation reminder carried to the user. Any leak, unscrubbed PII path, committed secret, or RLS regression blocks the gate.
- **QA gates on:** **Block A** (observability — DSN-gated init + no-op-when-absent + scrubbing) and **Block F** (security/RLS/secret-hygiene) as the **hard gates**; **Block B** (audit completeness) as a money-integrity gate; **Block C** (EAS builds locally without credentials), **Block D** (perf budgets), **Block E** (a11y) as functional gates; **Block G** (`ps-verify` green **with and without** secrets) as definition of done. Critical set: **AC 1–4, 8–11, 24–29, 31.**
- **USER-only setup actions (cannot be done by agents — required before/at the gate, none committed):**
  1. **Sentry:** create a Sentry account + a project each for web and mobile; supply `NEXT_PUBLIC_SENTRY_DSN` (web env) and `EXPO_PUBLIC_SENTRY_DSN` (mobile env). Optional: a server/CI-only `SENTRY_AUTH_TOKEN` for source-map upload (uncommitted). Verify live event ingestion (post-gate; not in CI).
  2. **Expo/EAS:** create/confirm an Expo account; run `eas login` + `eas build:configure` credentials; perform actual cloud `eas build` (dev/preview/production) and any store submission (post-gate; not in CI).
  3. **Secret hygiene / rotation (public repo):** confirm `.env` files are local-only; **rotate any key that was ever exposed** in the public repo's history (the standing reminder); keep all live keys (Stripe, Supabase service-role, Sentry auth token) out of the repo.
  4. **Approve** the observability privacy posture (Q1), perf budget (Q4), and a11y target (Q5) at the gate.
- **Gate summary (for the human):** what was built (Sentry on web+mobile DSN-gated with a scrubbing policy; audit-completeness sweep + any atomicity fix; EAS profiles + build docs; perf budget + applied wins; a11y pass; final security sign-off on a public repo), test results (`ps-verify` green **with and without** Sentry/Expo secrets; `rls-tenant-audit` + security checklist; a11y/RTL checks), residual risks (live Sentry ingestion / cloud EAS builds / store submission are post-gate user steps; load/pen-testing deferred; tracing/replay off), and decisions needing approval (Q1 privacy posture, Q4 perf budget, Q5 a11y target; the key-rotation reminder). **This is the final roadmap phase — the gate is the platform's launch-readiness sign-off. Never auto-approve.**

---

## Appendix — Acceptance criteria (numbered, testable Given/When/Then)

### Block A — Observability / error tracking (Sentry, DSN-gated, scrubbed)

1. **Given** no `NEXT_PUBLIC_SENTRY_DSN` / `EXPO_PUBLIC_SENTRY_DSN` in the environment, **when** the web app builds/runs and the mobile app bundles/runs, **then** Sentry does **not** initialize, **no** Sentry network call is made, and behavior is identical to today (no crash, no console error) — graceful degradation without secrets.
2. **Given** a DSN **is** present, **when** an unhandled error or unhandled promise rejection occurs (web client/server and mobile), **then** Sentry captures it as an event with release/version, route/screen, and error type/stack.
3. **Given** the `beforeSend`/scrubbing policy, **when** an event is built containing (or with breadcrumbs/URLs containing) a card number, a Stripe/secret key, an access/refresh/JWT token or auth header, a user email/name/phone, a `.env` value, or a raw tenant money row, **then** that data is **removed/redacted before transmission** — a unit test feeds such payloads and asserts none survive `beforeSend`.
4. **Given** the agreed safe-tag allowlist (per Q1), **when** an event is sent, **then** it contains **only** allowed tags (e.g. `tenant_id`/`role`/release if approved) and **no** disallowed PII/secret — and if `@ps/core` hosts the scrubber, its purity test passes and coverage is **>90%**.
5. **Given** the web app, **when** built (`next build`), **then** the production bundle contains **no** `SENTRY_AUTH_TOKEN` or any server-only secret (only the publishable DSN if configured) — verified by a bundle scan.

### Block B — Audit-trail completeness (§2.7)

6. **Given** the audit-completeness inventory, **when** reviewed, **then** every money/lifecycle action across Phases 4–9 (`session.close`, `order.pay`, `order_item.void`, `stock.restock`, `stock.adjust`, `shift.open`, `shift.close`, `product.*`, `rate_rule.*`, `tenant.suspend|reactivate`, `impersonation.start|stop`, `subscription.*`) maps to a documented `audit_log` write with actor + tenant + (amount where money-affecting) + entity — with **zero** unlisted money/lifecycle write paths.
7. **Given** a money-affecting action, **when** it commits, **then** its `audit_log` row is written **atomically** with the state change (same transaction / server-enforced) so a partial/failed/forged client cannot persist the change without the audit row — proven for at least one representative path per surface (mobile RPC, edge function, web).
8. **Given** the web catalog/rate-rule audit gap (separate client-side insert), **when** the Q3 decision is applied, **then** either the audit row is written atomically with the upsert (trigger/RPC) **or** the exception is documented with rationale (non-money config, owner-only, RLS-guarded) — and `security-reviewer` accepts the resolution.
9. **Given** an action performed during impersonation, **when** its audit row is written, **then** it stamps `impersonator_id` in addition to `actor_id` (ADR-0008 preserved).
10. **Given** the sweep is complete, **when** the gate summary is prepared, **then** it states the §2.7 invariant holds platform-wide and lists any intentionally-non-audited path with rationale.

### Block C — EAS build config (mobile, local-verifiable)

11. **Given** the repository with **no** Expo account/credentials, **when** `eas.json` + app config are validated and `expo export` runs, **then** the config is valid and the bundle graph builds successfully (no cloud account required) — and `ps-verify`'s `expo export` stays green.
12. **Given** `eas.json`, **when** reviewed, **then** it defines `development`, `preview`, and `production` profiles with per-profile env wiring (`EXPO_PUBLIC_*` incl. the Supabase URL/anon key and `EXPO_PUBLIC_SENTRY_DSN`) and a runtime-version/channel policy, and **no secret is committed**.
13. **Given** the build documentation, **when** an operator reads it, **then** the exact `eas build`/submit commands and the USER-only Expo-account prerequisites are documented (the cloud build itself is a post-gate user step).

### Block D — Performance pass (measurable)

14. **Given** the performance budget (per Q4), **when** `next build` runs, **then** each route's First-Load JS is within the per-route ceiling and shared JS within the total ceiling (recorded from build output); any route over budget is justified or fixed.
15. **Given** the report/admin/subscriptions read paths, **when** audited, **then** each query's shape is documented and confirmed index-backed on its hot filter columns (`tenant_id`/`branch_id`/date-range), with **no N+1** pattern; any missing index is added by a forward-only migration that changes no RLS/behavior.
16. **Given** the mobile app, **when** growable lists (device grid, order/catalog, sync dead-letter, sessions/audit history) are reviewed, **then** each uses a virtualized list (not a `ScrollView` map), documented per list.
17. **Given** `@ps/core` hot paths (pricing/outbox/entitlements), **when** sanity-checked, **then** no accidental quadratic/unbounded loop exists and the existing jest suite stays green with unchanged public APIs.

### Block E — Accessibility pass (a11y, building on RTL)

18. **Given** the web app at the agreed target (Q5), **when** the primary owner/super-admin flows are checked, **then** interactive controls have accessible names from i18n, landmarks/roles are present, and data tables have headers — no control is unlabeled.
19. **Given** any web modal/dialog (lifecycle, comp/override, money/discard confirm, paywall), **when** opened, **then** focus moves into the dialog, is trapped within it, `Esc` closes it, and focus returns to the trigger on close.
20. **Given** keyboard-only operation, **when** a user tabs through a primary flow, **then** all interactive elements are reachable in a sensible (RTL-aware) order with a visible focus indicator.
21. **Given** the design tokens, **when** text/control/status colors are measured, **then** contrast meets the agreed target (AA where feasible); failures are reported and tokens/markup adjusted.
22. **Given** the mobile app, **when** reviewed, **then** interactive elements carry `accessibilityLabel` + `accessibilityRole`, status/badges expose state to screen readers, and touch targets are ≥ 44×44 pt.
23. **Given** the safety-critical surfaces (impersonation banner, money/discard confirmation, read-only/paywall), **when** checked with assistive tech, **then** each is perceivable/announced and its meaning is unambiguous.

### Block F — Full security pass (REQUIRED sign-off — release blocker)

24. **Given** all migrations `0001–0011`, **when** scanned, **then** every `public` table has RLS enabled with explicit policies, and no operational policy carries an `OR is_super_admin()` / `OR true` / service-role escape.
25. **Given** the `rls-tenant-audit` pgTAP suite (incl. billing `0010`/`0011`), **when** run live in CI, **then** tenant A cannot read or write tenant B's rows for any table (or "static pass — pending live verification" consistent with prior-phase cadence) — and it passes.
26. **Given** each edge function, **when** reviewed, **then** its auth guard is correct: user-invoked functions are DB-authoritative on role; only `stripe-webhook` uses `verify_jwt=false` and it verifies the Stripe signature on the raw body; the service-role key appears in **no** client bundle.
27. **Given** the impersonation and webhook trust boundaries, **when** re-verified, **then** impersonation remains server-minted/time-boxed/audited with no RLS-bypass branch (ADR-0008) and the webhook remains signature-verified + idempotent on `event.id` + server-side `customer→tenant` mapped (ADR-0010).
28. **Given** the **public** repository, **when** a secret-hygiene scan runs over the working tree **and git history**, **then** no Stripe/Supabase-service-role/Sentry-auth-token/`.env` secret is present, `.env` files are gitignored, and the exposed-key **rotation reminder** is recorded for the user.
29. **Given** the observability scrubbing policy, **when** `security-reviewer` audits it, **then** they confirm no PII/secret/money/tenant-row path can reach Sentry (co-sign of Block A AC 3–4).

### Block G — Verification gate (definition of done)

30. **Given** the full change with **no** Sentry/Expo secrets present, **when** `ps-verify` runs, **then** `tsc --noEmit` (all touched workspaces) = 0 errors, `jest` passes (incl. any scrubber suite, >90% if in core), `expo export` builds, and `next build` succeeds — proving graceful-degradation-without-secrets.
31. **Given** the full change **with** a (publishable) DSN present, **when** the apps build, **then** all four `ps-verify` steps still pass and the CI 3-job pipeline (incl. live pgTAP) stays green **without** requiring any Sentry/Expo/paid external secret.
32. **Given** Phase 10 is the **final** roadmap phase, **when** the gate summary is prepared, **then** it records that no CLAUDE.md non-negotiable regressed (money/RLS/RTL/audit), lists the USER-only post-gate steps (live Sentry, cloud EAS, key rotation), and presents the platform's launch-readiness sign-off for human approval.
