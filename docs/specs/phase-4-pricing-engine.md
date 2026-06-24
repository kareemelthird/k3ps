# Spec — Phase 4: Devices + Sessions + Pricing (the pricing engine)

- **Phase:** 4 (Roadmap `docs/ROADMAP.md`) · **Surfaces:** `packages/core` (the pricing engine — primary deliverable), `apps/web` (Next.js — owner rate-rule editor), `apps/mobile` (Expo — deeper session lifecycle + segments), `supabase` (rate-rule writes + segment writes; no new tables)
- **Owner:** product-manager · **Status:** ready for design/build
- **Decision anchors:** [ADR-0002 — isolation model](../adr/0002-tenant-isolation-model-ratified.md) (ACCEPTED) · [ADR-0004 — schema scoping & keys](../adr/0004-tenant-schema-scoping-and-keys.md). New decisions this phase are captured as Open Questions for the architect (§6).
- **Builds on:** [Phase 3 spec](phase-3-walking-skeleton.md) — live, login-gated, tenant-isolated spine (auth + claim + branch select + device grid + open-meter start/close of ONE flat-rate session). Phase 4 replaces the Phase-3 "single flat snapshot" stopgap (Phase-3 Open Q3) with real rule resolution.
- **Already built (consume / extend, do not re-derive):** `@ps/core` `money` (`egpToPiastres`, `piastresToEgp`, `formatEgp`, `sumPiastres`, `toArabicDigits`), `time` (`CAFE_TZ`, `WEEKEND_DAYS=[5,6]`, `dayTypeAt`, `localHm`, `localHour`, `isWithinWindow` [start,end) end-exclusive + midnight-wrap, `elapsedMinutes`, `nowIso`), `id` (`uuidv4`), `pricing/open-meter` (`roundUpMinutes`, `billableMinutes`, `openMeterCostPiastres`). Schema `supabase/migrations/0002_operational_tables.sql` (`rate_rules`, `sessions`, `session_segments`, `orders`, `order_items` columns exist already).
- **References:** `docs/reference/core-api.md` (pricing engine + session pricing section), `docs/reference/schema-and-rls.md`, `docs/reference/mobile-patterns.md`, `docs/reference/design-approach.md`, `CLAUDE.md` §2 / §3 / §4 / §5.
- **Trial (learning input only — never import/copy):** `D:\K3\Pochinki\src\pricing\engine.ts` + `session.ts` (sound `ruleMatches`/`resolveRule`/`computeOpenMeterCost`/prepaid-lock/fixed-match algorithms and their invariants). Re-derive cleaner in `packages/core/src/pricing`.

---

## 1. Problem & goal

Phase 3 proved the stack runs end-to-end but deliberately faked pricing: it billed every session at a **single flat rate snapshot** with no rule editing, no peak/weekend windows, no play-mode switching, and only the `open` billing mode. A real gaming café charges **different rates by device type, single vs. multi play, weekday vs. weekend, and peak vs. off-peak windows**, and sells time three ways: by the meter, prepaid blocks, and per fixed match. Owners must be able to **configure** those rates, and counter staff must be able to **switch a customer between single and multi mid-session** and still produce a bill that is correct to the piastre and **reconstructible from stored snapshots**.

Phase 4 is the **pricing engine**: the heart of the cash business. It delivers (1) a pure, tested rate-rule **resolver** in `@ps/core` that picks the applicable hourly rate for a `(tenant, device_type, play_mode, day_type, time-of-day)` context at a given Cairo instant by priority; (2) the three **billing modes** (open-meter, prepaid with price locked at purchase, fixed-match); (3) **segmentation** — a session splits into segments and switching single↔multi or crossing a peak/weekend boundary freezes the current segment's rate snapshot and opens a new one; (4) an **owner rate-rule editor** on web with validation and a live "resolved rate for this instant" preview; and (5) a **deeper mobile session lifecycle** — switch play mode mid-session, watch live per-segment + total cost, and close with a fully reconstructible bill.

**The win:** owners can price their floor exactly how they run it, and every bill — live or closed — is derived by `@ps/core` from stored rate snapshots in integer piastres, so it is correct under backgrounding/offline and auditable to the agora.

**Roles touched:** `owner` (configures rate rules on web; may operate the floor on mobile), `manager`/`staff` (run sessions on mobile: start in a mode, switch modes, see live cost, close). `super_admin` is out of scope (Phase 7).

---

## 2. In scope / out of scope

### In scope

**`@ps/core` — the pricing engine (primary deliverable; pure, >90% line coverage)**
- **Rate-rule resolution:** a `ruleMatches(rule, ctx)` predicate and a `resolveRule(rules, ctx): RateRule | null` that filters to active rules matching `billing_mode`, `device_type` (`'any'` wildcard), `play_mode` (`'any'` wildcard), `day_type` (`weekday|weekend|any`, computed in Cairo from `at_iso`), and time window (`isWithinWindow`, end-exclusive, midnight-wrap), then picks **highest `priority`**; ties broken **deterministically by `id`**. `ctx` carries `{ device_type, play_mode, billing_mode, at_iso }` and never reads the clock internally.
- **Open-meter:** reuse `openMeterCostPiastres` per segment; provide a session-level aggregator that sums per-segment integer costs and applies the **min-charge once at the session level** (never per segment, never re-rounded over the sum).
- **Prepaid:** `prepaid_total` is the price **locked at purchase**; the engine charges it **exactly** and **never reconstructs it from current rules**. `prepaid_total = 0` is a valid locked price, not "missing". A legacy/derivation fallback (`block_price × blocks`) exists only when `prepaid_total` is null.
- **Fixed-match:** `cost = match_count × fixed_match_price` (integer piastres; `match_count` floored at 0).
- **Segment boundaries:** a helper that, given a session's current open segment context and a target `(play_mode, at_iso)`, decides whether a **new segment is required** — required iff (a) `play_mode` changes, or (b) the **resolved rate rule** for the new instant differs from the open segment's snapshot (i.e. a peak/off-peak or weekday/weekend boundary was crossed such that resolution changes). Peak/weekend boundaries are **derived from the rate rules themselves** (their `day_type` + `time_start`/`time_end`), not from a separate `peak_windows` setting.
- **Grand total:** `grand_total = Σ segment time costs + orders_total − discount`, clamped `>= 0`, integer piastres, single source of truth in core.
- **Bill reconstruction:** a pure function that, given a stored `session` + its `session_segments` (each with `price_per_hour_snapshot`, `play_mode`, `started_at`, `ended_at`) + `at_iso`, returns the time cost **without consulting current `rate_rules`** — proving the bill is reconstructible from snapshots alone.

**`apps/web` — owner rate-rule editor**
- List the active tenant's `rate_rules` (read for owner/manager; **write owner-only**), grouped/sortable by `billing_mode`, `device_type`, `priority`.
- Create / edit / deactivate (soft `is_active=false`) / re-activate a rate rule with field-level validation (see ACs).
- A **resolved-rate preview**: the owner enters a sample `(device_type, play_mode, billing_mode, instant)` and the editor calls the **same `@ps/core resolveRule`** to show which rule wins (or "no matching rule → fallback") and the resolved price — so the owner sees exactly what the counter will charge.

**`apps/mobile` — deeper session lifecycle + segments**
- **Start** a session in a chosen `billing_mode` (open / prepaid / fixed-match) on a free device; the first `session_segments` row snapshots the resolved rate (open/prepaid) or the mode is recorded (fixed-match). Prepaid captures the **locked `prepaid_total`** at start. Fixed-match captures/increments `match_count`.
- **Switch play mode** (single↔multi) mid-session for open-meter sessions: closes the current segment (`ended_at = nowIso()`, snapshot frozen) and opens a new segment with the newly resolved rate snapshot — both writes idempotent (client UUIDs, upsert).
- **Live cost:** the device/session card shows live **per-segment** and **total** cost, derived at render from timestamps via `@ps/core` (no `setInterval` accumulation for money). A segment-boundary **crossing while the session is live** (e.g. clock passes 18:00 into peak) must be reflected on the next render/refresh by opening a new segment OR by the live preview accounting for the crossing (see Open Q3 for which).
- **Close:** compute final `time_total`/`grand_total` via `@ps/core` from stored segments, set `ended_at`/`status='closed'`, free the device, write an `audit_log` row (`action='session.close'`, amount=`grand_total`). Closing also writes `audit_log` for prepaid/fixed-match the same way.

**Devices**
- A **device-type field** is already on `devices`. Owners need device types referenced by rate rules; this phase assumes device types are free-text strings already present from Phase 3 seed/CRUD. Full device CRUD UI is **not** required here (only what Phase 3 already shipped).

**Design**
- Fresh RTL/Arabic-first UX for the rate-rule editor (web) and the deeper session card + mode-switch + close summary (mobile) via `ui-ux-pro-max` + magic MCP. Arabic-Indic numerals where the trial displayed them.

### Out of scope (deferred — and why)
- **Products / orders catalog / order builder / inventory ledger** → **Phase 5**. `orders_total` enters `grand_total` as an input the engine already accepts, but **no order-building UI** ships this phase; sessions close with `orders_total = 0` unless Phase-5 lands. (The engine's grand-total signature must accept `orders_total` so Phase 5 needs no core churn.)
- **Shifts / cash drawer / reconciliation** → **Phase 5**. Sessions may run with `shift_id = null`.
- **Prepaid top-up / multi-block purchase UI** → **minimal this phase**: a prepaid session captures one locked `prepaid_total` at start; rich top-up/extend flows are deferred. The **lock invariant** is fully in scope and tested.
- **Discounts UI/permissioning** → the engine subtracts `discount` and clamps `>=0`; a full discount-entry UI with the `discount` permission gate is **Phase 5**. A minimal close-time discount field MAY be shown but is not required.
- **Device CRUD / maintenance toggle UI** → later. Device types are consumed as existing strings.
- **Owner reports / KPIs / revenue analytics** → **Phase 6**.
- **Offline outbox hardening / dead-letter / realtime sync** → **Phase 8**. Idempotent client-UUID upserts are required now (start, mode-switch, close); full queue resilience is not.
- **Super-admin portal / impersonation** → **Phase 7**.
- **Multi-currency / multi-timezone generalization** → deferred (Cairo/EGP behind named constants per roadmap).

---

## 3. User stories

- **As an `owner`**, I want to define rate rules per device type, play mode, day type, and time window with a priority, so that my floor is priced exactly the way I run it (peak/weekend surcharges, VIP rates, single vs. multi).
- **As an `owner`**, I want to preview which rule wins and what price it resolves to for a sample device/mode/instant, so that I can verify my rules before the counter charges a real customer.
- **As an `owner`**, I want to deactivate an old rule without deleting it, so that historical bills stay reconstructible and I keep an audit trail of pricing changes.
- **As a `manager`/`staff` operator**, I want to start a session in open, prepaid, or fixed-match mode, so that I can bill customers the way they chose to pay.
- **As a `manager`/`staff` operator**, I want to switch a customer between single and multi mid-session, so that the bill reflects what they actually played, each segment at its correct rate.
- **As a `manager`/`staff` operator**, I want the session card to show live per-segment and total cost derived from the clock, so that I can quote a customer at any moment and trust the number even if my phone slept or dropped network.
- **As a `manager`/`staff` operator**, I want a prepaid customer's price to stay locked even if the owner changes rates mid-session, so that I never over- or under-charge a prepaid block.
- **As an `owner`/`security-reviewer`**, I want every session close (all three modes) to write an audit row with actor, tenant, branch, timestamp, and amount, and every bill to be reconstructible from stored snapshots, so that the money is trustworthy and provable.

---

## 4. Data model touchpoints

No new tables. The phase exercises columns already in `supabase/migrations/0002_operational_tables.sql`:

- **`rate_rules`** (tenant-scoped, shared across branches): `device_type`, `play_mode` (`play_mode_rule`: single|multi|any), `billing_mode`, `day_type` (weekday|weekend|any), `time_start`/`time_end` (`'HH:mm'`|null), `price_per_hour`, `block_minutes`, `block_price`, `fixed_match_price`, `rounding_minutes` (default 5), `min_charge_minutes` (default 0), `priority` (default 0), `is_active`. Resolution index `rate_rules_resolution_idx (tenant_id, device_type, play_mode, billing_mode, day_type, priority)` already exists. **CRUD writes (owner-only) are new this phase.**
- **`sessions`**: `billing_mode`, `status`, `started_at`/`ended_at`, `prepaid_minutes`, `prepaid_total` (LOCKED), `match_count`, `time_total`, `orders_total`, `grand_total`, `discount`, `payment_method`. **Mode-aware start/close updates are extended this phase** (Phase 3 only wrote `open`).
- **`session_segments`** (tenant_id for RLS; branch via parent): `play_mode`, `rate_rule_id` (FK to the resolved rule), `price_per_hour_snapshot` (locked at segment open), `started_at`/`ended_at`. **Multi-segment writes (mode-switch / boundary close+open) are new this phase.**
- **`orders` / `order_items`**: read-only as an input to `grand_total` (`orders_total`); no writes this phase (Phase 5).
- **`audit_log`**: `action='session.close'` (extend to all three modes), `amount = grand_total`, `actor_id`, `tenant_id`, `branch_id`. **Rate-rule changes** SHOULD also audit (`action='rate_rule.create'|'rate_rule.update'|'rate_rule.deactivate'`) — see Open Q5.

RLS pattern (from `schema-and-rls.md`): `rate_rules` = staff/owner read + **owner write**; `sessions`/`session_segments` = own-scope (`manager_id = auth.uid()` OR owner) AND tenant predicate, `WITH CHECK` on writes. No RLS policy changes expected beyond what Phase 2/3 shipped; `security-reviewer` confirms rate-rule writes are owner-gated and tenant-scoped.

---

## 5. Acceptance criteria (numbered, testable — Given/When/Then)

> Money is **integer piastres** (100 = 1 EGP) in every money AC; never floats. Time is **UTC ISO stored**, day-type/window **computed in Africa/Cairo**; weekend = Friday(5)+Saturday(6). Cost math takes instants as arguments — **no `Date.now()` inside `@ps/core`**.

### A. Rate-rule resolution (`@ps/core`, pure)
1. **Given** a set of `rate_rules` and a `ctx = { device_type, play_mode, billing_mode, at_iso }`, **when** `resolveRule` runs, **then** it returns only a rule that is `is_active`, has matching `billing_mode`, has `device_type` equal to `ctx.device_type` **or** `'any'`, has `play_mode` equal to `ctx.play_mode` **or** `'any'`, has `day_type` equal to `dayTypeAt(at_iso)` (Cairo) **or** `'any'`, and whose `[time_start, time_end)` window contains `localHm(at_iso)` (end-exclusive, midnight-wrap) — otherwise it is excluded.
2. **Given** multiple matching rules with different `priority`, **when** `resolveRule` runs, **then** the **highest `priority`** rule is chosen.
3. **Given** two matching rules with the **same `priority`**, **when** `resolveRule` runs, **then** the tie is broken **deterministically by `id`** (stable ordering), and the result does not depend on input array order.
4. **Given** no rule matches `ctx`, **when** `resolveRule` runs, **then** it returns `null` (the documented no-match fallback), and callers treat a null resolution as **rate 0 / "no rule"** without throwing or inventing a rate.
5. **Given** an `at_iso` on a **Friday** or **Saturday** in Cairo, **when** day-type is computed, **then** it resolves `weekend`; any other Cairo weekday resolves `weekday` — verified at a UTC instant that is a different calendar day in UTC vs. Cairo (timezone-boundary case).
6. **Given** a rule window `time_start='18:00'`, `time_end='02:00'` (wraps midnight), **when** resolving at Cairo `01:30` and at `18:00` (inclusive start) and at `02:00` (exclusive end), **then** `01:30` and `18:00` match the window and `02:00` does **not** (end-exclusive).
7. **Given** a rule with `time_start=null` or `time_end=null`, **when** resolving at any instant, **then** the window matches all-day (null bound = always in-window).
8. **Given** identical inputs, **when** `resolveRule` is called repeatedly, **then** it is **pure** — same output every time, no clock read, no React/RN/Expo/Next/Supabase import (enforced by `purity.test.ts` / `pricing-engine-guard`).

### B. Open-meter billing (`@ps/core`)
9. **Given** one open segment from `started_at` to `at_iso` at `price_per_hour` piastres with `rounding_minutes`, **when** cost is computed, **then** it equals `openMeterCostPiastres(...)`: billable minutes = `roundUpMinutes(elapsed, rounding)`, cost = `round(billable × rate / 60)`, **rounded exactly once**, integer piastres, `>= 0`.
10. **Given** a session with **multiple** open segments at different snapshot rates, **when** the open-meter total is computed, **then** it is the **sum of per-segment integer costs** (each rounded once at its own rate) — the sum is **never re-rounded**, so segment costs reconstruct the total to the piastre.
11. **Given** a session whose total billable minutes are below `min_charge_minutes`, **when** the total is computed, **then** the min-charge is applied **once at the session level** (using the first segment's rate per the trial's sound algorithm), not per segment, and never accumulates rounding.
12. **Given** `elapsed <= 0` (clock skew / not-yet-started) and `min_charge_minutes = 0`, **when** cost is computed, **then** it is `0` (a bill never goes negative; partial minutes are rounded up, never given away when elapsed > 0).
13. **Given** the same `started_at` and the same `at_iso`, **when** open-meter cost is recomputed on any device, **then** the result is identical (deterministic; no float drift across platforms).

### C. Prepaid billing (`@ps/core`) — the lock invariant
14. **Given** a prepaid session with a non-null `prepaid_total`, **when** the time cost is computed, **then** it returns `prepaid_total` **exactly** and **does not** consult current `rate_rules` (price locked at purchase).
15. **Given** a prepaid session with `prepaid_total = 0`, **when** the time cost is computed, **then** it returns `0` — `0` is a valid locked price, **not** treated as missing.
16. **Given** the owner **changes the relevant rate rule** after a prepaid session was started, **when** the prepaid session's cost is recomputed (live or at close), **then** the charged amount is **unchanged** (still the locked `prepaid_total`).
17. **Given** a legacy prepaid session with `prepaid_total = null`, **when** cost is computed, **then** the documented fallback `block_price × max(1, blocks)` is used — exercised only for the null case, never overriding a non-null lock.

### D. Fixed-match billing (`@ps/core`)
18. **Given** a fixed-match session with `match_count = n` and a resolved `fixed_match_price = p` piastres, **when** cost is computed, **then** it equals `p × max(0, n)`, integer piastres.
19. **Given** `match_count = 0` (or null), **when** cost is computed, **then** it returns `0`.
20. **Given** `match_count` is incremented during a session, **when** cost is recomputed, **then** it scales linearly (`p × n`) with no rounding drift.

### E. Segments & grand total (`@ps/core` + write path)
21. **Given** an open segment for `play_mode='single'` and a request to switch to `play_mode='multi'` at `at_iso`, **when** the segment-boundary helper runs, **then** it reports a **new segment is required** (play_mode changed).
22. **Given** an open segment whose snapshot rule no longer resolves at `at_iso` because a **peak/off-peak or weekday/weekend boundary** was crossed (resolution now returns a different rule/rate), **when** the boundary helper runs, **then** it reports a **new segment is required** — and boundaries are derived from the **rate rules themselves**, not a separate `peak_windows` setting.
23. **Given** a play-mode switch (or boundary) at `at_iso`, **when** the write path applies it, **then** the current segment is closed (`ended_at = at_iso`, its `price_per_hour_snapshot` unchanged/frozen) and a new `session_segments` row is opened (`started_at = at_iso`, `play_mode` = new mode, `rate_rule_id` + `price_per_hour_snapshot` = the newly resolved rule) — both writes use **client-generated UUIDs and upsert** (idempotent; a retry/double-tap creates no extra segment).
24. **Given** a session with N closed/open segments, **when** the grand total is computed, **then** `grand_total = Σ segment time costs + orders_total − discount`, clamped to `>= 0`, integer piastres — computed in `@ps/core`, no float, single rounding per segment.
25. **Given** a **closed** session and its stored `session_segments` only (snapshots), **when** the time cost is reconstructed via the core reconstruction helper **without** reading current `rate_rules`, **then** it equals the `time_total` that was stored at close (every bill is reconstructible from snapshots — CLAUDE.md §3).
26. **Given** a session with **only open-meter** segments, **when** play-mode is switched twice (single→multi→single), **then** there are exactly **3 segments**, each with its own frozen rate snapshot, and the total equals the sum of the 3 per-segment costs.

### F. Owner rate-rule editor (`apps/web`, owner-only write)
27. **Given** a signed-in **owner**, **when** they open the rate-rules screen, **then** they see only the **active tenant's** `rate_rules` (RLS-scoped; no other tenant's rules ever appear) and can create/edit/deactivate; a signed-in **manager** sees the list **read-only** (no write controls).
28. **Given** the rule form, **when** the owner saves, **then** validation enforces: `billing_mode` required; for `open` → `price_per_hour` required and `> 0`; for `prepaid` → `block_minutes > 0` and `block_price >= 0`; for `fixed_match` → `fixed_match_price >= 0`; `rounding_minutes >= 0`; `min_charge_minutes >= 0`; `priority` integer; `time_start`/`time_end` either **both null** or **both valid `'HH:mm'`**; invalid input blocks save with a field-level error and **no** row is written.
29. **Given** money fields in the editor, **when** the owner enters EGP, **then** the value is converted to integer **piastres** via `@ps/core egpToPiastres` for storage and rendered back via `formatEgp` — the stored column is integer piastres, never a float.
30. **Given** a saved rule, **when** the owner deactivates it, **then** `is_active` becomes `false` (soft delete — the rule is **not** hard-deleted, so historical segment snapshots referencing it stay reconstructible) and it no longer participates in `resolveRule`.
31. **Given** the **resolved-rate preview**, **when** the owner enters a sample `(device_type, play_mode, billing_mode, instant)`, **then** the editor calls the **same `@ps/core resolveRule`** the counter uses and shows the winning rule (id + price) — or an explicit **"no matching rule (fallback: 0)"** — so the preview can never disagree with what the counter charges.
32. **Given** an owner of **tenant A**, **when** they attempt (via tampered request) to create/update a rate rule with `tenant_id` = tenant B, **then** RLS `WITH CHECK` rejects the write (no cross-tenant rule), and a non-owner attempting any rate-rule write is rejected by the owner-only policy.

### G. Mobile session lifecycle (`apps/mobile`)
33. **Given** a free device, **when** the operator starts a session and picks a `billing_mode`, **then** exactly one `sessions` row is created with that `billing_mode`, `status='active'`, `started_at = nowIso()` (UTC ISO), correct `tenant_id`/`branch_id`/`manager_id`, and (for open) one first `session_segments` row snapshotting the **resolved** rule's rate (`resolveRule` for the start instant), and the device flips to `busy` — all idempotent via client UUIDs.
34. **Given** a **prepaid** start, **when** the session is created, **then** `prepaid_total` is captured as the **locked** price at start and is never recomputed from rules thereafter (AC 14–16 hold on this row); a **fixed-match** start records `match_count` (default 0) and the resolved `fixed_match_price` context.
35. **Given** an **active open-meter** session, **when** the operator switches play mode (single↔multi), **then** the current segment closes and a new one opens per AC 23, the session card reflects the new segment immediately, and the action is idempotent (double-tap = one switch).
36. **Given** an active session, **when** the session card is viewed, **then** it shows **live per-segment cost and live total cost** derived at render from `started_at`/segment timestamps via `@ps/core` (`elapsedSeconds`/`formatClock` for the timer, cost via the pricing engine) — **not** from a `setInterval`-accumulated money counter; backgrounding/sleeping the app and returning must not change the computed cost for the same elapsed time (CLAUDE.md §2.2).
37. **Given** a session that has not crossed any boundary and not switched mode, **when** it is closed at `at_iso`, **then** `time_total` equals the single-segment open-meter cost for `elapsed(started_at → at_iso)` at the snapshot rate with rounding/min-charge, `grand_total = time_total + 0 − discount` (`orders_total = 0` this phase), `status='closed'`, `ended_at` set, device freed.
38. **Given** a multi-segment session (mode switches and/or boundary crossings), **when** it is closed, **then** the stored `time_total`/`grand_total` equal the `@ps/core` sum over all segments at their frozen snapshots, and the close summary lists each segment (mode, snapshot rate, minutes, cost) so the customer-facing bill is itemized and reconstructible.
39. **Given** a busy device, **when** an operator attempts to start a second session on it, **then** it is blocked (UI + the `(tenant_id, device_id) where status='active'` partial unique index), and no second active session is created.

### H. Audit & idempotency
40. **Given** any session close (open / prepaid / fixed-match), **when** the close completes, **then** exactly **one** `audit_log` row exists for it with `action='session.close'`, `actor_id = auth.uid()`, the session's `tenant_id` (and `branch_id`), a timestamp, and `amount = grand_total` (CLAUDE.md §2.7).
41. **Given** a close is retried (network retry / double-tap) with the **same** client-generated identifiers, **when** both reach the server, **then** the session is closed **once**, totals are written **once**, and **no duplicate** `audit_log` row is produced (idempotent upsert — CLAUDE.md §2.8).
42. **Given** a prepaid session whose `prepaid_total` was locked at start, **when** its close audit row is written, **then** `amount` equals that locked `prepaid_total` (+ orders − discount), proving the lock survived to the ledger.
43. **Given** (if Open Q5 is accepted) a rate-rule create/update/deactivate by an owner, **when** it completes, **then** an `audit_log` row records the actor, tenant, `action='rate_rule.*'`, and the rule id, so pricing changes are traceable.

### I. RTL / i18n & verification
44. **Given** every user-facing string on the new web (rate-rule editor) and mobile (mode switch, live cost, close summary) screens, **when** inspected, **then** it comes from **i18n resources** (Arabic-first), with RTL layout, and **no hardcoded** user-facing copy (CLAUDE.md §2.6).
45. **Given** every money and numeric display on the new screens, **when** rendered, **then** currency uses `@ps/core formatEgp` and displayed digits use Arabic-Indic numerals via `toArabicDigits` where the trial did — **no** inline currency math or hardcoded digits (CLAUDE.md §2.1, §4).
46. **Given** the completed work, **when** `ps-verify` runs, **then** `tsc --noEmit` passes with **0 errors** across `@ps/core` / `apps/mobile` / `apps/web`; `jest` passes including the new pricing-engine suite at **>90% line coverage** on `packages/core/src/pricing`; `expo export` builds the mobile bundle; `next build` produces a successful web production build; and the `pricing-engine-guard` (no `Date.now()` in cost math, no floats, round once per segment, no framework imports) passes (CLAUDE.md §4, §7).

---

## 6. Open questions

1. **Live boundary crossing while a session runs (architect + product-manager).** When an active open-meter session crosses a peak/weekend boundary **between renders** (e.g. clock passes 18:00), do we (a) auto-close the current segment and open a new one at the boundary instant on the next interaction/refresh (segment is created by the client write path when the operator next acts, with the boundary instant as the split point), or (b) keep one open segment but have the **live preview** mathematically split the open period at the boundary, materializing the extra segment(s) only at close? Both keep the bill correct/reconstructible; (b) reduces writes but needs the close path to split deterministically. **Recommend (b)** — preview splits open periods at boundaries; close materializes segments — with the boundary instants derived purely from the resolved rules. Needs an architect call on the write contract and whether a background tick is acceptable on mobile.
2. **Boundary detection granularity (architect).** AC 22 defines a boundary as "resolution returns a different rule/rate." Confirm we compare on **resolved `rate_rule_id`** (so two windows pointing at the same price still split — clean audit) vs. on **resolved price** (fewer segments). **Recommend compare on resolved rule id** (snapshot fidelity), but confirm.
3. **Open-meter segment boundaries when crossing multiple windows (architect).** If an open period spans more than one boundary (e.g. a 5-hour session crossing off-peak→peak→after-midnight), the split must produce a segment per window. Confirm the core helper returns the **ordered list of boundary instants** in `[started_at, at_iso)` so the close path can materialize N segments deterministically.
4. **Min-charge with multi-segment + mixed rates (product-manager).** The trial applies min-charge once using the **first** segment's rate. Confirm this is the intended business rule for PS-Managment (vs. e.g. the highest-rate segment), since min-charge now interacts with peak boundaries. **Recommend keep "first segment's rate"** (matches the proven trial behavior) unless the owner expects otherwise.
5. **Auditing rate-rule changes (architect + security-reviewer).** Should rate-rule create/update/deactivate write `audit_log` rows (AC 43)? Pricing changes affect money indirectly and owners may want a change history. **Recommend yes**, low cost, high trust value; confirm the `action` taxonomy (`rate_rule.create|update|deactivate`).
6. **Prepaid `prepaid_minutes` semantics & expiry (product-manager).** `sessions.prepaid_minutes` exists. Does a prepaid block **end automatically** when minutes elapse, or does it just inform the operator (advisory) while the locked price stands regardless? This phase keeps the **price lock** as the invariant and treats `prepaid_minutes` as **advisory display only** (no auto-close). Confirm; auto-expiry/extend is deferred.
7. **Fixed-match rate resolution timing (architect).** For fixed-match, is `fixed_match_price` resolved/locked **at start** (snapshot on the session/segment) like prepaid, or resolved **at close** from current rules? **Recommend lock at start** for consistency with the prepaid lock and reconstructibility; confirm whether to store the snapshot on the session row or a segment.
8. **Discount entry this phase (product-manager).** The engine subtracts `discount`. Do we expose a minimal close-time discount field now (gated by the `discount` permission), or defer all discount UI to Phase 5? **Recommend defer the UI to Phase 5**; keep `discount` as an engine input defaulting to 0.

---

## 7. Hand-off

### architect must decide
- **Live boundary-crossing contract** (Open Q1): preview-splits-at-boundary vs. write-segment-on-crossing; whether a mobile background tick is acceptable. Blocks the mobile live-cost + close design.
- **Boundary detection key** (Open Q2): split on resolved `rate_rule_id` vs. resolved price.
- **Multi-boundary segment materialization** (Open Q3): core helper returns the ordered boundary-instant list for the close path.
- **Rate-rule change auditing** (Open Q5) with security-reviewer: action taxonomy + whether owner-only RLS already covers it.
- **Fixed-match price lock timing & storage** (Open Q7): at-start snapshot location.
- Confirm no RLS policy changes are needed beyond owner-gated `rate_rules` writes already implied by Phase 2/3; if any are, `security-reviewer` signs off (AC 32, 40, 43).

### ux-designer must design (fresh, via `ui-ux-pro-max` + magic MCP — not the trial's look; Arabic-first/RTL)
- **Web (rate-rule editor):** rule list (grouped by billing_mode/device_type/priority; owner write vs. manager read-only states); create/edit form with the mode-conditional fields + field-level validation; deactivate/reactivate affordance; the **resolved-rate preview** panel (sample inputs → winning rule + price or "no matching rule"); empty/loading/error states.
- **Mobile (deeper session):** start sheet with billing-mode picker (open/prepaid/fixed-match) incl. prepaid locked-price capture and fixed-match match counter; live session card showing **per-segment** breakdown + live total (timestamp-derived); play-mode switch control (single↔multi) with confirm; itemized close summary (segments: mode, rate, minutes, cost → `time_total`/`grand_total`, all `formatEgp` + Arabic-Indic digits); empty/loading/error states per `mobile-patterns.md`.
- All strings via i18n resources; no hardcoded copy.

### engineers build
- **core (primary):** `packages/core/src/pricing` — `ruleMatches` / `resolveRule` (priority + id tie-break + Cairo day-type + window), the multi-segment open-meter aggregator (reusing `openMeterCostPiastres`, min-charge once at session level), `computePrepaidCost` (lock-honoring, 0-valid, null-fallback), `computeFixedMatchCost`, the segment-boundary helper (returns ordered boundary instants / "new segment required"), `computeGrandTotal` (+ orders − discount, clamp `>=0`), and the snapshot-only **reconstruction** helper. Re-derived fresh from the trial's algorithms; **no import from the trial**; **no `Date.now()` in cost math**; **no floats**; **>90%** coverage; `pricing-engine-guard` green.
- **web engineer:** `apps/web` rate-rule editor (owner CRUD + validation + soft-delete), the `resolveRule`-backed preview, EGP↔piastres via `@ps/core`, RTL/i18n; owner-only write enforced client-side and verified against RLS.
- **mobile engineer:** mode-aware start (open/prepaid/fixed-match), play-mode switch (close+open segment, idempotent), live per-segment + total cost (timestamp-derived), mode-aware close (totals via core → free device → audit row), itemized close summary, RTL/i18n; all mutations idempotent client-UUID upserts.
- **backend / supabase-migrate:** confirm/seed ≥1 realistic rule set per seeded tenant (open weekday/weekend/peak, a prepaid block, a fixed-match rule) for testing; confirm owner-only `rate_rules` write policy + `WITH CHECK`; (if Open Q5 accepted) wire `rate_rule.*` audit writes.

### QA gates on (the testable success checks)
- **Rate resolution correctness:** AC 1–8 (priority, id tie-break, Cairo weekend incl. UTC↔Cairo boundary, end-exclusive + midnight-wrap windows, null-bound all-day, no-match→null fallback, purity).
- **Billing modes:** open-meter AC 9–13; prepaid lock AC 14–17 (esp. AC 16 rate-change-after-start); fixed-match AC 18–20.
- **Segments & grand total:** AC 21–26 (mode-switch + boundary split, sum-not-re-rounded, snapshot reconstruction == stored time_total).
- **Web editor:** AC 27–32 (owner-only, validation, piastres storage, soft-delete, preview parity with counter, cross-tenant write rejected).
- **Mobile lifecycle:** AC 33–39 (mode-aware start, prepaid/fixed-match capture, mode switch, timestamp-derived live cost survives backgrounding, single- and multi-segment close, busy-device guard).
- **Audit & idempotency:** AC 40–43 (one audit row per close for all modes, amount = grand_total, idempotent retry, prepaid lock to ledger, rate-rule audit if accepted) — `security-reviewer` signs off on AC 32, 40, 43.
- **RTL/i18n + full `ps-verify`** (tsc 0 errors, jest incl. >90% pricing coverage, `expo export`, `next build`, `pricing-engine-guard`): AC 44–46.
- Residual-risk note for the human gate: orders/shifts/discount UI deferred to Phase 5 (engine accepts them as inputs now); prepaid top-up/expiry advisory-only this phase; offline resilience thin (Phase 8); live boundary-crossing approach pending Open Q1.
