# Feature design — Super-Admin Impersonation (time-boxed, audited, visually unmistakable)

> Surface: **web** (Next.js + shadcn/ui), platform-only (`super_admin`). Tokens & primitives: `docs/design/design-system.md`.
> Spec: `docs/specs/phase-2-tenant-foundation.md` (US: time-boxed audited impersonation; AC H **38–39**; hand-off §7: "impersonation must be visually unmistakable + audited").
> Sibling: entry point lives on Tenant detail → `docs/design/super-admin-console.md` §3.3.
> Anchor: ADR-0002 (claim from signed `app_metadata`). The exact token TTL + claim shape come from the architect's impersonation ADR (spec open Q2/Q3) — this doc owns the **UX contract**, not the crypto.

---

## 1. Why this needs its own design

Impersonation is the single most dangerous, most abusable path on the platform: a platform operator acting *as* a tenant, inside that tenant's data. The spec is explicit — it must be **explicit, time-boxed, audited, and visually unmistakable**, with **no silent cross-tenant read path** (AC 38). The design's whole job is to make sure the operator (and anyone glancing at the screen) can **never forget they are impersonating**, that it **auto-expires**, and that **every entry/exit is logged**.

The design uses the dedicated `impersonation` token (violet `#8B5CF6` dark / `#7C3AED` light) — a **one-purpose color** reserved exclusively for this state (design-system §2.2), never reused for brand or status, so the mode is instantly recognizable and never confused with normal operation.

---

## 2. The flow (start → active → end)

```
Tenant detail ──[Impersonate]──▶ Consent dialog ──[confirm]──▶ Active impersonation
                                       │                              │
                                  [cancel]                    [End now] / [auto-expire]
                                       ▼                              ▼
                                 (no change)              Return to console + audit row
```

### 2.1 Entry — Consent dialog (high-friction, never one-click)

Triggered by the guarded **Impersonate** button on Tenant detail. Opens a `ConfirmDialog` (not a silent jump) that states the consequences and captures intent:

- **Title:** `الدخول كـ <اسم العميل>` / `Impersonate <tenant name>` — with the impersonation violet icon.
- **Body (consequences, plain):**
  - "ستتصرّف داخل بيانات هذا العميل كأنك المالك." / "You will act inside this tenant's data as the owner."
  - "الجلسة محدودة بـ <مدة> وتنتهي تلقائيًا." / "This session is limited to <duration> and ends automatically." — the **time-box duration is shown explicitly** (value from the impersonation ADR; render Arabic-Indic).
  - "سيُسجَّل الدخول والخروج في سجل التدقيق." / "Entry and exit are written to the audit log." (AC 39)
- **Required reason field:** `TextField` "سبب الدخول (للتدقيق)" / "Reason (for audit)" — **required**, persisted to the audit row. Validated on blur; non-empty.
- **Optional duration selector:** if the ADR allows operator-chosen bounds, a `SegmentedControl` of allowed presets (e.g. ١٥ / ٣٠ / ٦٠ دقيقة); otherwise the fixed time-box is shown read-only. Never unbounded.
- **Actions:** Cancel (start edge, ghost) · **Confirm — Impersonate** (end edge, uses `impersonation` violet fill, not the brand teal — so even the confirm button signals the special mode). Loading + disabled on submit (`loading-buttons`).
- **On confirm:** mints/activates the time-boxed session (mechanism per ADR), writes the **start** `audit_log` row (actor = super_admin, tenant, timestamp, reason), then routes into the impersonated context. (AC 38)

### 2.2 Active — the impersonation chrome (always on screen)

While impersonating, the entire viewport is wrapped so the state is impossible to miss:

- **Persistent top banner** (`ImpersonationBanner`), full-width, sticky, `e3` elevation, `impersonation` violet surface, **above all other chrome** (highest z-index tier). It contains:
  - Left/start: violet icon + `أنت تتصرّف كـ <اسم العميل>` / `You are acting as <tenant name>`.
  - Center: a **live countdown** to auto-expiry — `TimerText` in `remaining` mode, derived from the session's expiry timestamp (never an interval counter; design-system §9 / `CLAUDE.md` §2.2). Tabular, Arabic-Indic. Turns `warning` under ~2 min, `danger` under ~30s.
  - End: **"إنهاء الآن" / "End now"** button (`danger`-adjacent, always reachable) — exits immediately.
- **Persistent border frame:** a 3px `impersonation` violet inset border around the whole app shell, so even if the banner scrolls in a child iframe/region the frame still reads. (Belt-and-suspenders for "unmistakable.")
- **No global brand teal** while impersonating — the primary CTA color inside an impersonated screen stays teal for the tenant's own UI, but the *platform chrome* is violet, keeping the two layers distinct.

### 2.3 Expiry & exit

- **Auto-expiry:** when the countdown reaches zero the session ends automatically (token no longer valid). The UI shows a non-dismissible interstitial — "انتهت جلسة الدخول المؤقت" / "Impersonation session expired" — and routes back to the tenant detail. The **end** `audit_log` row is written (with end timestamp + reason of "expired"). No silent extension.
- **Manual end ("End now"):** `ConfirmDialog` ("إنهاء الدخول المؤقت؟") → on confirm, ends the session, writes the **end** audit row (reason "ended by operator"), returns to console with a toast "تم إنهاء الدخول المؤقت".
- **Re-entry** requires a fresh consent dialog (new reason, new audit pair). Never resumed silently.

---

## 3. Component contracts (new to this feature)

### `ImpersonationConsentDialog`
- **Props:** `open`, `tenant: TenantSummary`, `allowedDurations?: number[]`, `fixedDurationMin?: number`, `onConfirm({reason, durationMin})`, `onCancel`, `submitting`, `error`.
- **States:** default · reason-invalid (inline error, confirm disabled) · submitting (spinner, disabled) · error (inline, form preserved).
- **RTL/a11y:** title + body + reason field start-aligned; tenant name LTR-isolated if it contains Latin; focus trap, Esc cancels; confirm button labeled with the consequence ("الدخول كـ X"), not just "تأكيد"; first-invalid-field focus on submit error. Confirm uses the `impersonation` token, visually distinct from any normal primary.

### `ImpersonationBanner`
- **Props:** `tenantName`, `expiresAtIso`, `nowIso` (injected), `onEndNow`.
- **Renders:** sticky violet bar + `TimerText(remaining)` countdown + End-now button; mounts the 3px app-shell frame.
- **States:** active (violet) · warning (<2min, amber accent on the timer only) · critical (<30s, danger timer + subtle attention, reduced-motion-safe) · expiring (interstitial). Never hidden, never dismissible while active.
- **RTL/a11y:** layout mirrored (identity at start, countdown center, End-now at end); `role="status"` / `aria-live="polite"` announces "impersonating <tenant>"; countdown has an `accessibilityLabel` reading remaining time in Arabic; End-now is keyboard-reachable from anywhere (skip-link target). Color is never the only signal — the explicit "أنت تتصرّف كـ" text label always accompanies the violet.

### `ImpersonationExpiredInterstitial`
- **Props:** `tenantName`, `onReturn`.
- Non-dismissible modal, scrim, single action "العودة إلى لوحة التحكم" / "Return to console". `aria-modal`, focus moved to it (`focus-on-route-change`).

### Audit integration
Impersonation produces a **start row and an end row** in the platform `AuditTable` (super-admin-console §3.4), tinted with the `impersonation` token at low alpha + a violet icon, carrying actor / tenant / timestamp / reason / outcome (ended | expired). These are first-class, filterable audit entries (AC 38–39).

---

## 4. The four states (this feature)

- **Loading** — consent dialog submit shows spinner + disabled; entering the impersonated context shows a skeleton of the tenant shell with the banner already painted (so the mode is signaled before content loads).
- **Empty** — n/a as a data surface; the audit view's empty state is covered in super-admin-console §3.4.
- **Error** — consent submit failure: inline cause + retry, no session started, no audit "start" written for a failed mint (audit reflects only real sessions). If "End now" fails, the banner stays (fail-safe: never leave the operator silently still-impersonating without the chrome) and shows a retry toast.
- **Offline / degraded** — impersonation **cannot be started while offline** (the Impersonate button + consent confirm are disabled with a banner): minting a time-boxed audited session requires the live backend. An already-active session keeps its banner and countdown (timestamp-derived, so it expires correctly even offline); "End now" queues and reconciles, and the local frame/countdown still enforces the visual time-box.

---

## 5. RTL & a11y notes (feature-specific)

- The impersonation chrome is fully RTL-mirrored; the countdown uses `formatClock` + `toArabicDigits`, tabular, never wraps.
- The violet `impersonation` token meets contrast in both themes; the state is conveyed by **violet + a persistent text label + the frame + a live countdown** — four redundant signals, never color alone (`color-not-only`).
- "End now" is the highest-priority escape route: reachable by keyboard from any focus position, always visible, never behind a menu (`escape-routes`).
- Every entry and exit (manual or auto) writes an audit row; there is **no UI path that enters or leaves impersonation without a corresponding audit pair** — this is the design's hard invariant mapping to AC 38–39.
- Reduced-motion: the critical-countdown attention cue is a color/weight change, not a flashing animation.

---

## 6. Open dependencies (block final visual build, not this contract)

Map to spec open questions §6 (architect-owned):
- **Impersonation mechanics & time-box duration (Q2)** — minted short-lived token vs RLS bypass; the exact TTL and whether the operator may pick a preset. The UX renders whatever the ADR fixes; the consent dialog and banner already reserve the "duration" slot.
- **Claim freshness (Q3)** — if a role/tenant changes mid-impersonation, the banner's source of truth (expiry timestamp) is unaffected, but the architect must confirm the session cannot silently outlive its claim.
- **`super_admin` placement (Q4)** — only the platform-level super_admin flag may reach this surface; no tenant-scoped role can impersonate.
