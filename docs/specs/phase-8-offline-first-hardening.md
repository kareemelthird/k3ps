# Phase 8 — Offline-first hardening (the durable write queue)

> Surfaces: **mobile + core** primarily (`apps/mobile`, `packages/core`); **backend** only if §7 elects a dead-letter audit action or a realtime-publication/RLS adjustment. No web feature work; no new owner/super-admin surface.
> Anchors: [CLAUDE.md §2.8](../../CLAUDE.md) (idempotent writes — client UUIDs + upsert, queue survives crashes without double-counting), [§2.1](../../CLAUDE.md) (money = integer piastres), [§2.2](../../CLAUDE.md) (timers from timestamps), [§2.4](../../CLAUDE.md) (`@ps/core` is pure), [§5](../../CLAUDE.md) (RLS / tenant isolation), [§2.6](../../CLAUDE.md) (Arabic-first RTL). Reference: [`docs/reference/mobile-patterns.md`](../reference/mobile-patterns.md) (offline-outbox section) and the `offline-outbox-guard` skill. New decisions land as **ADR-0009 (offline outbox + realtime sync for multi-tenant)**.
> Status: 🟡 needs spec → architect (ADR-0009) → build. The Phase-3 review **deliberately deferred** the outbox to Phase 8; Phases 3–7 mobile does **direct idempotent writes** (deterministic client UUIDs + upsert). Phase 8 makes those writes **durable and crash-safe** without changing the money math or the proven idempotency keys.

---

## 1. Problem & goal

The mobile counter app is the cash register of a gaming café. It runs on phones and tablets on flaky café Wi-Fi; it gets backgrounded, force-killed, and loses signal mid-transaction. Today (Phases 3–7) every mutation is a **direct** Supabase call: idempotent (client-generated UUIDs + `upsert`, with `uuidv5` deterministic keys for retry-stable rows like `close:{sessionId}` and boundary sub-segments), but **not durable**. If the network drops or the app is killed between the user tapping "close session" and the write reaching Postgres, the write is simply lost — the device may stay marked busy, the bill may never be recorded, or a multi-step sequence (segments → session update → stock movements → device free → audit row) may land **partially**. The session `api.ts` close path alone performs five sequential writes with no atomicity and no retry; an interruption after step 3 leaves inconsistent state. The Phase-5 gate explicitly recorded "offline resilience thin (Phase 8)" and the close sequence as a "not atomic (durability)" residual.

Phase 8 ports and hardens the trial's proven **offline write queue (outbox)** for multi-tenant: a durable, crash-safe queue that captures every mutation (online and offline), drains it in dependency order with idempotent exactly-once effect, quarantines poison writes to a **dead-letter** instead of silently dropping money, automatically drains on reconnect, syncs other devices/owner via **realtime**, and surfaces a clear **sync-status UI** (pending / syncing / failed / last-synced, with manual retry). The win: a counter operator can keep taking sessions, orders, and payments through a total network outage and an app kill, and when connectivity returns **every** write lands **exactly once** — no lost bills, no double charges, no double-decremented stock, no cross-tenant leak.

**Roles touched:** `manager` and `staff` (the counter operators who run the mobile app through outages) directly; `owner` benefits indirectly (realtime keeps their dashboard and any second device current; no corrupted figures reach reports). `super_admin` is untouched except that the per-tenant realtime scoping must not become a cross-tenant leak (security angle, §5).

---

## 2. Prior art (reuse — do not reinvent)

The Pochinki trial has a **mature, sound** offline subsystem at `D:\K3\Pochinki\src\features\sync\`. It is a **learning reference only** (`learn-from-trial` skill) — reuse the *ideas*, rebuild fresh for tenancy, never import.

| Trial asset | Location | Sound idea to reuse (rebuilt for PS-Managment) |
|---|---|---|
| `outbox.ts` — durable queue + dead-letter | `src/features/sync/outbox.ts` | Persisted FIFO queue; `enqueue`/`flushOutbox`/`pendingCount`/`getPending`/`getDeadLetter`/`retryDeadLetter`/`discardDeadLetter`; **upsert-not-insert** so a replay after crash mid-flush is a no-op; `MAX_ATTEMPTS=5` → dead-letter then **keep draining** (one poison write must not wedge the queue); single-flight `flushing` guard; invalidate caches after flush. **Delta:** rebuild the impure I/O (storage, Supabase, Zustand) as mobile adapters; lift the **pure** state-machine/idempotency/retry/dead-letter-decision logic into `@ps/core` (§3, §6 Q2); every entry carries `tenant_id`/`branch_id`. |
| `mutate.ts` — `persistRow({table, op, row})` | `src/features/sync/mutate.ts` | The single bridge feature code calls instead of touching Supabase directly: queue durably + fire-and-forget flush + stamp `updated_at: nowIso()` (last-write-wins meaningful before the server trigger). |
| `useNetworkWatcher.ts` | `src/features/sync/useNetworkWatcher.ts` | Connectivity via `navigator.onLine` + 20s interval + AppState foreground + web `online`/`offline` events; **never** a cross-origin reachability probe (CORS wedges the app offline). Flush on reconnect. |
| `useRealtime.ts` | `src/features/sync/useRealtime.ts` | `postgres_changes` subscription → invalidate the matching Query caches so a device freed / session opened / order paid on another phone shows live. **Delta:** channel/filter must be **tenant-scoped** (and ideally branch-scoped) so a tenant's client never receives another tenant's change events; rely on realtime RLS authorization, not just client filters (§5, §6 Q5). |
| `store.ts` — `useSync` | `src/features/sync/store.ts` | Zustand surface the UI reads: `online`, `syncing`, `pending`, `failed`. Reuse shape; add `lastSyncedAt`. |
| `usePending.ts` | `src/features/sync/usePending.ts` | Rehydrate the pending/failed counts from durable storage on mount (counts survive app kill). |
| **PS-Managment** id helpers `uuidv4`, `uuidv5`, `PS_UUID_NS` | `packages/core/src/id/id.ts` | Already shipped and used by the direct-write paths. The outbox reuses the **same** deterministic keys (`close:{sessionId}`, `seg:{sessionId}:{startedAt}`, `stock-sale:{itemId}`, etc.) so wrapping a write in the queue does not change its idempotency identity. |
| Existing mobile feature `api.ts` (direct writes) | `apps/mobile/src/features/{session,orders,stock,shifts,devices}/api.ts` | The mutation **payloads and idempotency keys** are correct and stay. Phase 8 reroutes them through the outbox (`persistRow`) rather than calling `supabase.from(...).upsert(...)` inline; the row-building logic is preserved. |
| RLS on all operational tables + `WITH CHECK` | `supabase/migrations/0004_rls_policies.sql` | The outbox flush authenticates as the same user; RLS still enforces tenant isolation on every queued write. No policy change for the queue itself. |

**Default stance:** match the trial's proven outbox behavior, generalized for tenancy, with the pure logic extracted into `@ps/core`. Deltas are called out in §7.

---

## 3. Scope

### In scope

- **3.1 Pure outbox logic in `@ps/core`** (new `packages/core/src/outbox/`, re-exported from root; pure, no React/RN/Supabase/storage imports; **>90% line coverage**): the queue **state machine** and the decisions that must be unit-testable in isolation —
  - the `OutboxEntry` type (`localId`, `tenant_id`, `branch_id`, `table`, `op`, `payload`, `pk`, `dependsOn?`, `attempts`, `lastError`, `createdAt`, `updatedAt`);
  - **idempotent enqueue**: dedupe by deterministic key so re-enqueuing the same logical mutation (same row id / same `localId`) collapses to one entry, never two (exactly-once *intent*);
  - **drain selection / ordering**: given a queue, return the next entry(ies) eligible to send, respecting **dependency ordering** (an entry whose `dependsOn` is still pending is not yet eligible) and FIFO within a dependency level;
  - **retry/backoff policy**: a pure function `(attempts, lastError) → 'retry-after(ms)' | 'dead-letter' | 'drop'` encoding `MAX_ATTEMPTS`, backoff schedule, and which error classes are permanent (constraint/validation/auth → dead-letter fast) vs transient (network/5xx → retry);
  - **dead-letter decision** and **transition functions** (`onSuccess`, `onTransientFailure`, `onPermanentFailure`) returning the next queue+dead-list state — **pure**, so resilience tests run under Jest with no device.
  - This boundary is the architect's call (§6 Q2); the spec's requirement is only that the *decisions* (idempotency, ordering, retry, dead-letter) are pure and tested, and the *I/O* (storage, network, Supabase, Zustand) lives in mobile adapters.
- **3.2 Durable, crash-safe persistence (mobile adapter).** The outbox queue **and** dead-letter list persist to local storage that **survives an app force-kill and device restart** (mechanism = §6 Q1). Writes to the store are consistent (no torn/partial entry leaves the queue corrupt); the in-memory cache and durable store stay in sync; pending + failed counts **rehydrate on app start** from the durable store.
- **3.3 Outbox bridge + reroute of existing writes.** A `persistRow({table, op, row, pk?, dependsOn?})` bridge (mobile) that enqueues durably and fire-and-forget flushes. **All** existing mobile mutations (session start / switch-mode / close; orders add / pay / void; stock restock / adjust / sale; shift open / close; device status) are rerouted through it. Payloads and the existing `uuidv4`/`uuidv5` idempotency keys are unchanged. Optimistic cache update on enqueue; `onSettled`/post-flush invalidation reconciles.
- **3.4 Ordered drain respecting dependencies.** A multi-row logical action (e.g. start session = session row + first segment + device→busy; close = segments + session update + stock movements + device→free + audit row) drains so that a referenced parent exists before its children (a segment/order never flushes before its session; an audit/stock row never before the session it references). Mechanism (explicit `dependsOn` per entry vs a server-side transactional RPC vs strict FIFO grouping) is §6 Q3.
- **3.5 Idempotent exactly-once effect under retry/duplicate-send.** Re-sending an entry (because an ack was lost, a crash happened mid-flush, or the same action was queued twice) produces **exactly one** row effect: client UUIDs + `upsert` (`onConflict:'id'`), deterministic `uuidv5` keys for retry-stable rows, and money/stock side-effects that are **inserts of immutable ledger rows keyed by deterministic id** (a replayed `stock-sale:{itemId}` upserts the same movement, never a second decrement; a replayed `close:{sessionId}` audit row updates-in-place).
- **3.6 Network watcher + automatic drain.** Connectivity detection via `navigator.onLine` + interval + AppState foreground + web online/offline events (no cross-origin probe). On reconnect (and on foreground, and on interval) the queue auto-drains. Flush is safe to call repeatedly (single-flight guard); offline calls no-op and leave the queue intact.
- **3.7 Dead-letter handling (surfaced, never silently dropped).** After the retry policy exhausts (default `MAX_ATTEMPTS=5`) or classifies an error as permanent, the entry moves to the dead-letter list and the drain **continues** with the rest of the queue. Dead-lettered entries retain `attempts`/`lastError`/payload and are **surfaced** in the sync-status UI with **operator actions**: retry-one, retry-all (reset attempts → re-queue → flush), and discard-one/discard-all (with confirm, since discarding can drop a money-bearing write). No money-affecting write is ever dropped without an explicit operator confirm.
- **3.8 Realtime sync (tenant-scoped).** Subscribe to `postgres_changes` for the operational tables (`devices`, `sessions`, `session_segments`, `orders`, `order_items`, `stock_movements`, `shifts`) **scoped to the active tenant** (and branch where applicable); on change, invalidate the matching Query caches so a second device / the owner dashboard reflects updates live. The subscription must **not** deliver another tenant's rows (§5, §6 Q5). Safe no-op while offline.
- **3.9 Sync-status UI (mobile, Arabic-first RTL).** A persistent, glanceable indicator + a detail screen showing: connectivity (online/offline), syncing state, **pending count**, **failed/dead-letter count**, **last-synced timestamp**, and a list of pending + dead-lettered entries (action + entity + age + last error for failed ones) with **manual retry** / discard controls. Arabic-Indic numerals for counts/times; RTL layout; all strings via i18n. Reuse the existing offline banner pattern.
- **3.10 Conflict-resolution policy (per entity).** A documented, implemented policy for what wins when two writes to the same row race (e.g. two devices closing the same session, or a stale offline edit landing after a newer one): default **last-write-wins** via stamped `updated_at`, with **server-authoritative / append-only** treatment for money-bearing and ledger entities (a `closed` session is terminal — a late re-close does not reopen or re-bill; `stock_movements`/`audit_log` are append-only and never overwritten with different amounts). Exact per-entity table is §6 Q6.
- **3.11 No-double-count proof.** Resilience tests (Jest, pure-core + mobile adapter where feasible) prove: kill-during-drain replays without duplication; duplicate-send is a no-op; offline-create-then-reconnect lands exactly once; poison message → dead-letter while the queue keeps draining; a voided sale reverses **exactly one** stock movement; closing a session enqueues and lands **exactly one** `session.close` audit row and the correct `grand_total`.

### Out of scope (later phases / deferred)

- **Stripe billing / subscription paywall / plan gating** (Phase 9). The outbox does not handle billing writes.
- **Sentry / EAS builds / performance budgets / formal a11y pass / full pen-test** (Phase 10). Phase 8 may emit lightweight structured error info for the dead-letter view, but Sentry wiring and perf tuning are Phase 10.
- **Web offline support.** The owner/super-admin web app stays online-only; only `apps/mobile` gets the outbox. (Web gains only realtime auto-refresh **iff** trivially shared; not required this phase.)
- **New operational features or money math.** No new pricing modes, no new tables of business data, no change to `@ps/core` pricing/inventory/shift math. Phase 8 changes *durability*, not *what is computed*.
- **Full offline read cache / offline-first reads of historical reports.** Phase 8 hardens *writes* and live realtime; comprehensive offline read replication (browse all history with no network) is deferred.
- **Cross-device merge UI / manual conflict resolution dialogs.** Conflict policy is automatic (§3.10); no interactive merge UX this phase.
- **Background sync while the app is fully terminated** (OS background tasks / headless flush). Phase 8 drains on next launch/foreground/reconnect, not via OS background execution.
- **Multi-currency / non-Cairo timezone generalization** (roadmap-wide deferral).

---

## 4. User stories

- **As a counter staff member, I want to start, switch, and close sessions and take orders while the Wi-Fi is down,** so that I never have to tell a customer "the system is offline" — the work queues and syncs later.
- **As a counter staff member, I want my queued work to survive the app being killed or the phone restarting,** so that a crash mid-shift never loses a recorded bill or payment.
- **As a manager, I want a clear sync indicator showing pending, syncing, failed, and last-synced,** so that at shift close I can confirm everything reached the server before I count the drawer.
- **As a manager, I want a write that keeps failing to be flagged for me — not silently dropped and not stuck blocking everything else,** so that money problems are visible and actionable while the rest of the queue keeps flowing.
- **As a manager, I want to manually retry or (with confirmation) discard a failed write,** so that I can recover after fixing the underlying cause without corrupting the books.
- **As an owner with two counter devices, I want a session opened or closed on one device to appear on the other and on my dashboard within seconds,** so that staff don't double-book a device or double-charge a customer.
- **As an owner, I want certainty that an interrupted close never double-charges, double-decrements stock, or writes two audit rows,** so that my reports and inventory stay trustworthy.
- **As a tenant, I want certainty that realtime sync never leaks another café's activity to my devices,** so that the platform stays isolated. (Negative story — enforced by realtime RLS, proven by tests.)

---

## 5. Domain notes (CLAUDE.md / ADR links)

- **§2.8 Idempotent writes (the core of this phase):** client generates UUIDs; mutations **upsert**; the offline queue must survive crashes **without double-counting**. Every queued entry replays as an upsert keyed by a client id; deterministic `uuidv5` keys (already used by the direct-write paths) make retry-stable rows (audit, boundary sub-segments, stock sales) collapse on replay. This is the non-negotiable that every resilience AC tests.
- **§2.1 Money is integer piastres:** the outbox carries already-computed integer-piastres payloads (cost math stays in `@ps/core`, run before enqueue). The queue must never re-run money math on flush and never accumulate rounding — it transports a frozen, computed row.
- **§2.2 Timers from timestamps:** the queue stamps `updated_at`/`created_at` from `nowIso()` at enqueue (intent time); billing totals are derived from stored `started_at`/`ended_at` (already computed by `@ps/core` before enqueue). A long offline gap or replay never corrupts a bill because elapsed is timestamp-derived, not interval-accumulated.
- **§2.4 `@ps/core` is pure:** the extracted outbox state-machine/idempotency/retry/dead-letter logic obeys core purity — **no** React/RN/Expo/Next/Supabase/AsyncStorage imports, **no** `Date.now()` inside decision functions (timestamps passed in). Verified by the existing `purity.test.ts` pattern.
- **§5 Tenancy & security:** every queued row carries `tenant_id`/`branch_id` and flushes under the user's own JWT — RLS `WITH CHECK` still rejects a cross-tenant write, so a queue bug can never write into another tenant. **Realtime** must be tenant-scoped: a `postgres_changes` subscription must not deliver another tenant's row events. This requires realtime authorization to respect RLS (filter + RLS on the realtime channel), not just a client-side `tenant_id` filter — a security-reviewer concern (§6 Q5).
- **§2.7 Auditable money:** money-affecting actions already write `audit_log` rows (Phases 4–5) with deterministic ids; rerouting through the outbox must preserve exactly-one audit row per action. Whether a *dead-lettered money write* itself warrants an audit/telemetry trail is §6 Q7.
- **§2.6 Arabic-first / RTL:** the sync-status indicator, detail screen, dead-letter list, and all toasts/confirms are user-facing strings via i18n; counts/timestamps render Arabic-Indic; layout is RTL. No hardcoded strings.
- **Reference + skill:** [`docs/reference/mobile-patterns.md`](../reference/mobile-patterns.md) (offline-outbox section) is the model; the `offline-outbox-guard` skill enumerates the seven invariants (client-id+upsert, stamp-before-queue, dead-letter-don't-block, durable persistence, no double money, local connectivity, tenancy) that QA gates on.

---

## 6. Acceptance criteria (numbered, testable Given/When/Then)

### Block A — Pure outbox logic in `@ps/core` (`pricing-engine-guard`-style purity + >90% coverage)

1. **Given** the new `@ps/core` outbox module, **when** the purity test runs, **then** it imports **nothing** from React/RN/Expo/Next/Supabase/AsyncStorage and references no `Date.now()` inside decision functions (timestamps are arguments) — verified by the existing `purity.test.ts` mechanism extended to the new path.
2. **Given** a queue with an entry for row id `X`, **when** the same logical mutation for row id `X` is enqueued again, **then** the pure enqueue collapses it to a single entry (dedupe by id/localId) — re-enqueuing never produces two entries for the same row-key (exactly-once intent).
3. **Given** a queue where entry B `dependsOn` entry A and A is still pending, **when** the pure drain-selection runs, **then** B is **not** returned as eligible until A has succeeded; entries with no unmet dependency return in FIFO order.
4. **Given** an entry with `attempts` below the cap and a transient error class, **when** the pure retry policy is evaluated, **then** it returns `retry` (with a backoff delay); **given** `attempts ≥ MAX_ATTEMPTS` or a permanent error class (constraint/validation/auth), **then** it returns `dead-letter`.
5. **Given** the pure transition functions, **when** `onSuccess(entry)` / `onTransientFailure(entry, err)` / `onPermanentFailure(entry, err)` are applied, **then** they return the next `(queue, deadList)` state correctly (success removes the entry and unblocks dependents; transient increments attempts and keeps it queued; permanent moves it to the dead list and **leaves the rest of the queue intact**) — all asserted as pure state transitions with no I/O.
6. **Given** the new outbox module, **when** `jest` runs, **then** line coverage on the module is **> 90%** (per CLAUDE.md §4).

### Block B — Durable persistence & crash-safety (mobile adapter)

7. **Given** N writes enqueued while offline, **when** the app process is force-killed and relaunched, **then** all N entries are still present in the durable queue and the pending count rehydrates to N on app start (nothing lost across a kill).
8. **Given** a flush is interrupted (process killed) **after** a write reached the server but **before** the entry was removed from the durable queue, **when** the app relaunches and drains, **then** re-sending that entry is a **no-op** (upsert on the same id) and the final row state is identical to a single successful send — no duplicate row, no double effect.
9. **Given** the durable store, **when** the queue or dead-list is written, **then** a crash during the write cannot leave a corrupt/unreadable store (the load path tolerates and recovers; a torn write does not lose previously-committed entries) — verified by a simulated-interrupt test.
10. **Given** dead-lettered entries exist, **when** the app is killed and relaunched, **then** the dead-letter list and its `attempts`/`lastError` survive and the failed count rehydrates (dead-letters are as durable as the queue).

### Block C — Mobile write reroute, ordered drain & idempotency

11. **Given** every existing mobile mutation (session start/switch/close; order add/pay/void; stock restock/adjust/sale; shift open/close; device status), **when** Phase-8 lands, **then** each is issued via the outbox bridge (`persistRow`/enqueue) rather than a direct inline `supabase.from(...)` write, while preserving the existing payload and `uuidv4`/`uuidv5` idempotency keys — verified by a scan that no feature `api.ts` mutation path calls Supabase write methods directly outside the outbox adapter.
12. **Given** a multi-row action (e.g. start session = session + first segment + device→busy), **when** it drains, **then** the parent (session) is confirmed before its dependents (segment referencing `session_id`, audit/stock rows) such that no flush fails on a missing foreign reference; if the parent has not yet flushed, dependents wait (per §6 Q3 mechanism).
13. **Given** a session close enqueued (segments + session update + stock movements + device free + `session.close` audit), **when** it drains successfully, **then** the server holds exactly: the materialized segments, one updated session row (`status=closed`, correct `grand_total`), the correct stock-sale movements, the device freed, and **exactly one** `audit_log` row with `action='session.close'` and `amount=grand_total`.
14. **Given** the same close action is somehow enqueued/sent twice (duplicate-send), **when** both drain, **then** the result is identical to a single send: one audit row (deterministic `close:{sessionId}` id), no second stock decrement (deterministic `stock-sale:{itemId}` ids), session remains `closed` once — no double-count.
15. **Given** a tracked-product sale and a subsequent void of that line, **when** both flush, **then** the stock ledger nets to the correct on-hand: exactly one sale movement and exactly one offsetting void movement (no duplicate of either across retries).
16. **Given** an entry queued for tenant A under a tenant-A user, **when** it flushes, **then** RLS `WITH CHECK` accepts it for tenant A; a (hypothetical) entry with a mismatched `tenant_id` is **rejected** by the server and never writes another tenant's data — proving the queue cannot bypass tenant isolation.

### Block D — Network watcher & automatic drain

17. **Given** the app is offline with a non-empty queue, **when** `flushOutbox` is invoked (interval/foreground/manual), **then** it no-ops and leaves the queue intact (no entries lost, no attempts incremented for a write never sent).
18. **Given** the app regains connectivity, **when** the network watcher detects online (via `navigator.onLine` / web `online` event / AppState foreground), **then** the queue auto-drains without manual action.
19. **Given** connectivity detection, **when** reviewed, **then** it uses `navigator.onLine` / AppState / web online-offline events and **never** a cross-origin reachability probe (CORS would falsely wedge the app offline) — verified by code review/scan.
20. **Given** repeated/concurrent `flushOutbox` calls, **when** they overlap, **then** a single-flight guard prevents two concurrent drains from sending the same entry twice.

### Block E — Dead-letter handling

21. **Given** a poison entry that fails every attempt (e.g. a permanent constraint error), **when** the queue drains, **then** after the retry policy exhausts the entry moves to the dead-letter list **and the drain continues** with the following entries (one poison write never blocks the queue).
22. **Given** a dead-lettered entry, **when** the operator taps **retry**, **then** it is re-queued with `attempts` reset and a flush is attempted; if it now succeeds it lands exactly once and leaves the dead-letter list.
23. **Given** a dead-lettered **money-bearing** entry, **when** the operator taps **discard**, **then** a confirmation is required before it is removed (money writes are never dropped without an explicit confirm); after confirm it is removed from the dead-letter list.
24. **Given** any dead-lettered entry, **when** viewed, **then** its action/entity, age, `attempts`, and `lastError` are visible to the operator (never a silent drop).

### Block F — Realtime sync (tenant-scoped)

25. **Given** two devices authenticated to the **same tenant**, **when** device 1 closes a session (and it flushes), **then** device 2's device grid / session view reflects the change within a few seconds via realtime cache invalidation (no manual refresh).
26. **Given** a client authenticated to tenant A with an active realtime subscription, **when** tenant B's rows change, **then** tenant A's client receives **zero** of tenant B's change events — realtime is tenant-scoped and does not leak across tenants (security-reviewer gate; relies on realtime RLS/authorization per §6 Q5, not just a client filter).
27. **Given** the app is offline, **when** realtime cannot connect, **then** the subscription is a safe no-op (no crash, no error spam) and reconnects when online.

### Block G — Sync-status UI

28. **Given** queued writes, **when** the operator views the sync indicator, **then** it shows the current state — online/offline, syncing, **pending count**, **failed count**, and **last-synced** time — and updates as the queue drains.
29. **Given** the sync detail screen, **when** opened, **then** it lists pending entries (action/entity/age) and dead-lettered entries (with last error) and offers manual **retry** (one/all) and **discard** (one/all, with confirm for money writes).
30. **Given** all writes have flushed, **when** the operator checks the indicator, **then** pending=0, failed=0, and last-synced reflects a recent timestamp — a manager can confirm "everything synced" before counting the drawer at shift close.

### Block H — RTL / i18n

31. **Given** the sync indicator, detail screen, dead-letter list, toasts, and confirms, **when** rendered, **then** every user-facing string comes from i18n resources (Arabic-first) — no hardcoded strings (`rtl-i18n-check`).
32. **Given** counts and timestamps in the sync UI, **when** displayed, **then** numerals render Arabic-Indic (via `toArabicDigits`) and layout is RTL (start/end spacing, not hardcoded left/right), consistent with the rest of the app.

### Block I — Verification gate (definition of done)

33. **Given** the full change, **when** `ps-verify` runs, **then** `tsc --noEmit` across touched workspaces = 0 errors, `jest` passes (incl. the new pure-core outbox suite > 90%), `expo export` builds the mobile bundle graph, and (if web touched) `next build` succeeds.
34. **Given** the changed sync/write paths, **when** the `offline-outbox-guard` skill runs, **then** all seven invariants report **PASS** with evidence (client-id+upsert; stamp-before-queue; dead-letter-don't-block; durable persistence; no double money; local connectivity; tenancy), and the required resilience tests exist: **replay-after-crash idempotency, poison→dead-letter while draining, voided-sale reverses exactly one movement**.
35. **Given** the realtime tenant-scoping and any backend change, **when** the phase closes, **then** `security-reviewer` has signed off that realtime does not leak cross-tenant (AC 26) and the queue cannot bypass RLS (AC 16); `rls-tenant-audit` is re-run/confirmed if any policy or publication changed.

---

## 7. Open questions (need ADR-0009 / design / human call)

**Architect (ADR-0009) — must decide before build:**

- **Q1 — Local persistence mechanism (the central durability call).** What store survives an Expo app force-kill **and** a device restart with crash-safe writes? Candidates: **expo-sqlite** (transactional, atomic, good for a growing queue + dead-list; heavier), **react-native-mmkv** (very fast synchronous KV, but evaluate crash-atomicity and Expo-Go/dev-client constraints), or **AsyncStorage** (what the trial used; simple, but whole-key JSON rewrite risks a torn write and has size/perf limits at scale). Decide the mechanism, the **atomic-write strategy** (so a crash mid-persist cannot corrupt the queue — AC 9), key versioning (`<app>.outbox.v1` / `.dead.v1`), and the Expo build implication (managed workflow / dev-client / config plugin). **Cite Expo docs.**
- **Q2 — Pure-core vs mobile-adapter boundary.** Confirm exactly what lands in `@ps/core/outbox` (entry type, dedupe/idempotency, drain-selection + dependency ordering, retry/backoff policy, dead-letter decision, pure transition functions — all unit-tested) vs the mobile adapter (`persistRow` bridge, storage I/O, Supabase apply, Zustand `useSync`, network watcher, realtime, UI). The bar: the *decisions* are pure and >90% tested; the *I/O* is thin and adapter-only. Settle whether `applyEntry` (the Supabase upsert/update/delete dispatch) stays entirely in the adapter (recommended) and how core signals "permanent vs transient" to the adapter (error-class taxonomy).
- **Q3 — Ordering / dependency model.** How are multi-row dependencies enforced on drain (AC 12)? Options: (a) explicit `dependsOn` localIds per entry with the pure drain-selection gating dependents; (b) collapse a multi-row logical action into a **single server-side transactional RPC** (atomic — also fixes the "close sequence is not atomic" residual — but adds a backend function and moves some logic server-side); (c) strict FIFO with carefully ordered enqueue. Decide per action; note the tradeoff: an RPC gives true atomicity but is a backend addition (and must itself be idempotent + RLS-safe); `dependsOn` keeps writes per-row but must handle a parent that dead-letters (do dependents also dead-letter, or wait forever?). **Recommendation bias:** consider a transactional RPC for the close sequence specifically (atomicity is the cleanest no-partial-state guarantee), `dependsOn`/FIFO for the simpler actions.
- **Q4 — Retry/backoff + dead-letter thresholds.** Confirm `MAX_ATTEMPTS` (trial used 5), the backoff schedule (fixed interval vs exponential with cap), and the **error-class taxonomy** that distinguishes *permanent* (4xx constraint/validation/auth/RLS-reject → dead-letter fast, don't waste 5 attempts) from *transient* (network/timeout/5xx → retry). Decide what happens to an entry whose parent dead-lettered (Q3 interaction).
- **Q5 — Realtime channel scoping & authorization (security).** How is realtime scoped per-tenant so no cross-tenant event leaks (AC 26)? Decide: `postgres_changes` with a `tenant_id` server-side **filter** + **Realtime Authorization (RLS on `realtime.messages`)** vs a per-tenant channel naming + topic authorization. A client-side filter alone is **not** sufficient (it would still receive the rows). Confirm whether the tables need to be added to the `supabase_realtime` publication and whether that is a backend migration. **Cite Supabase Realtime Authorization docs.** Branch-level scoping: tenant-only or tenant+branch?
- **Q6 — Conflict-resolution policy per entity.** Confirm the per-entity matrix (AC §3.10): which entities are plain **last-write-wins** via `updated_at` (e.g. `devices.status`) vs **terminal/append-only / server-authoritative** (a `closed` session must not be reopened or re-billed by a late stale write; `stock_movements` and `audit_log` are append-only immutable ledgers; `shifts` close is terminal). Specify how a stale offline update to a since-changed row is reconciled (LWW accept vs reject-if-terminal). Does any of this need a DB guard (e.g. a trigger/policy preventing un-closing a closed session) or is client policy sufficient given idempotent keys?
- **Q7 — Backend changes & dead-letter audit.** Confirm whether any backend change is needed at all. Likely candidates: (a) adding tables to the realtime publication + realtime RLS (Q5); (b) an idempotent transactional RPC for the close sequence (Q3b); (c) whether a **permanently-failed money write** should leave a telemetry/audit trace (it can't write `audit_log` if it's failing — so this is local/Sentry-Phase-10 territory, but flag the gap). If no backend change: state "mobile + core only" explicitly so the migration count stays at `0008`.

**UX-designer — must design:**

- The **sync-status indicator** (persistent, glanceable: online/offline + pending/failed badges + syncing spinner + last-synced) and the **sync detail screen** (pending list, dead-letter list with errors, retry/discard controls, confirm dialog for discarding money writes) — fresh RTL/Arabic-first via `ui-ux-pro-max` + magic MCP; loading/empty/error/offline states; Arabic-Indic counts/times. Reuse/extend the existing `OfflineBanner`/offline pattern rather than inventing a parallel one.
- The **operator affordances** for "is everything synced?" at shift close (the clear all-clear state, AC 30) and the **dead-letter alarm** state (something needs my attention) so a failed money write is unmissable.

**Human call:**

- Approve the persistence mechanism (Q1) and — if elected — the transactional-RPC approach for the close sequence (Q3b), since it moves a small amount of logic server-side and adds a migration.
- Approve the realtime authorization approach (Q5) at the gate (security-sensitive: a cross-tenant realtime leak is a release blocker).
- Confirm whether realtime live verification runs against hosted Supabase this gate or is recorded "static pass — pending live verification" consistent with Phases 2–7.

---

## 8. Hand-off

- **Architect:** write **ADR-0009** resolving Q1–Q7; the central calls are the **persistence mechanism + crash-atomic write strategy (Q1)**, the **pure-core/adapter boundary (Q2)**, the **ordering/dependency model incl. possible transactional close RPC (Q3)**, and **realtime tenant-scoping/authorization (Q5)**. State explicitly whether any backend migration is needed (target: none beyond an optional realtime publication / close RPC).
- **Core engineer:** build `packages/core/src/outbox/` — entry type, idempotent dedupe, drain-selection with dependency ordering, retry/backoff policy, dead-letter decision, pure transition functions; **>90% coverage**; purity preserved (AC 1–6).
- **Mobile engineer:** build the durable-storage adapter (Q1), the `persistRow`/outbox bridge, the network watcher, the realtime subscription (tenant-scoped), `useSync` store + rehydration, and the sync-status UI; **reroute every existing mutation** through the outbox preserving payloads + `uuidv4`/`uuidv5` keys (AC 7–32).
- **Backend engineer (only if Q3b/Q5/Q7 elect it):** the idempotent transactional close RPC and/or realtime publication + Realtime Authorization RLS; forward-only migration `0009_*`; no operational-policy weakening; `rls-tenant-audit` re-run.
- **UX-designer:** the sync indicator + detail screen + dead-letter/all-clear states above (RTL/Arabic-first).
- **security-reviewer (required sign-off where backend/realtime touched):** owns AC 16 (queue cannot bypass RLS) and AC 26 (realtime no cross-tenant leak). A cross-tenant realtime leak is a release blocker.
- **QA gates on:** Block C (idempotency / no-double-count) and Block E (dead-letter doesn't block) as the **hard resilience gates**; Block B (crash-safety) as the durability gate; Block F-AC26 (tenant isolation) as the security gate; Block I (`ps-verify` + `offline-outbox-guard` all-PASS) as the definition of done. The critical resilience set is **AC 7, 8, 13, 14, 15, 21, 26**.
- **Gate summary (for the human):** what was built (pure-core outbox + durable mobile queue + rerouted writes + dead-letter + tenant-scoped realtime + sync UI), test results (`ps-verify` + `offline-outbox-guard` + any `rls-tenant-audit` re-run), residual risks (background-terminated sync deferred; web stays online-only; live realtime verification status per Q5), and decisions needing approval (Q1 persistence, Q3 close-RPC, Q5 realtime auth). **Never auto-approve.**
