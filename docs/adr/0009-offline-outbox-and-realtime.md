# ADR-0009: Offline-first hardening — the durable, crash-safe write outbox (pure-core/mobile-adapter split), the idempotent transactional close RPC, and tenant-scoped Realtime

- **Status:** Accepted (Phase-8 design gate. **`security-reviewer` sign-off REQUIRED — release blocker** on: (a) the tenant-scoping of Realtime so a client can NEVER receive another tenant's change events — spec AC 26 / §6 Q5; and (b) the new `close_session_tx` write RPC + the realtime publication / `REPLICA IDENTITY` changes in migration `0009`, which expose row events through RLS and add a write path — spec AC 16, AC 35. The human project owner approves at the Phase-8 gate: the persistence mechanism (Q1), the transactional close RPC (Q3b), and the realtime-authorization posture / live-vs-deferred verification (Q5).)
- **Date:** 2026-06-26
- **Deciders:** architect (deciding — tenant-isolation authority) · `security-reviewer` (realtime scoping / RPC / publication-RLS sign-off — **required**) · core-engineer (builds `@ps/core/outbox` from the API surface below) · mobile-engineer (durable adapter, `persistRow` bridge, network watcher, realtime, sync UI, write reroute) · backend / supabase-migrate (authors `0009` from the normative SQL) · ux-designer (sync indicator + detail screen) · human project owner (Phase-8 gate)
- **Builds on:** [ADR-0002 — isolation model](0002-tenant-isolation-model-ratified.md) (shared-DB + `tenant_id` + RLS; `current_tenant_id()` is the only tenant resolver — Realtime reuses **the same** isolation surface) · [ADR-0003 — auth claim model](0003-auth-claim-and-impersonation-model.md) (the signed `app_metadata.tenant_id` claim the realtime socket carries) · [ADR-0005 — pricing segments & boundaries](0005-pricing-engine-segments-and-boundaries.md) (the close materializes segments; the outbox transports the **already-computed** integer-piastres payload, never re-runs the math) · [ADR-0006 — orders/inventory/shifts](0006-orders-inventory-shifts.md) (stock decrement-at-close; deterministic `stock-sale:{itemId}` ledger keys) · [ADR-0007 — reporting RLS read path](0007-reporting-aggregation-and-rls.md) (the `SECURITY INVOKER` / no-`SECURITY DEFINER`-on-data-paths discipline the close RPC must honor).
- **Reference:** `docs/specs/phase-8-offline-first-hardening.md` §6 (AC) / §7 (Q1–Q7) · `docs/reference/mobile-patterns.md` (offline-outbox section) · `packages/core/src/id/id.ts` (`uuidv4`/`uuidv5`/`PS_UUID_NS`) · `apps/mobile/src/features/{session,orders,stock,shifts,devices}/api.ts` (the direct-write paths being rerouted) · `supabase/migrations/0003_claim_helpers.sql` (`current_tenant_id()`) / `0004_rls_policies.sql` (operational RLS incl. `audit_log` insert-only, `stock_movements`) · Pochinki trial `src/features/sync/` (learning reference only — `learn-from-trial`) · `CLAUDE.md` §2.1/§2.2/§2.4/§2.8, §5.

## Context

The mobile counter app is the café's cash register on flaky Wi-Fi; it is backgrounded, force-killed, and loses signal mid-transaction. Today (Phases 3–7) every mutation is a **direct** Supabase call — idempotent (client UUIDs + `upsert`, deterministic `uuidv5` keys for retry-stable rows) but **not durable**: a kill or drop between tap and commit loses the write, and the close path performs **five sequential, non-atomic writes** (segments → session update → stock movements → device free → audit) so an interruption after step 3 leaves inconsistent state (the Phase-5 "close sequence not atomic" residual). Phase 8 makes these writes **durable, crash-safe, ordered, exactly-once, and tenant-isolated** without changing the money math or the proven idempotency keys.

Seven decisions (spec §7) gate the build. The two load-bearing ones are **Q1 — the local persistence mechanism** (the durability crux: a store that survives force-kill + restart with no torn/corrupt state) and **Q5 — Realtime tenant-scoping** (a cross-tenant realtime leak is a release blocker; a client-side filter alone is insufficient). They are resolved below with cited evidence, then the remaining decisions (pure/adapter boundary, ordering, retry taxonomy, conflict policy, backend changes) follow.

**Hard constraints (`CLAUDE.md`):** §2.8 idempotent writes (client UUIDs + upsert; queue survives crashes with **no double-count**); §2.1 money is integer piastres (the queue transports a **frozen, pre-computed** payload — never re-runs cost math on flush); §2.2 timers from timestamps (totals derive from stored `started_at`/`ended_at`, computed before enqueue); §2.4 `@ps/core` is pure (no React/RN/Expo/Next/Supabase/storage imports; **no `Date.now()` inside decision functions** — the clock is an argument); §5 tenancy/RLS (every queued row carries `tenant_id`/`branch_id` and flushes under the user's own JWT; `WITH CHECK` rejects cross-tenant; Realtime must not deliver another tenant's rows).

**Forces in tension:** crash-atomicity vs. simplicity (a whole-key JSON rewrite risks a torn write); pure-testable decision logic vs. unavoidable native I/O; true all-or-nothing for the close vs. keeping writes per-row and the migration count low; immediate realtime liveness vs. zero cross-tenant leakage; reusing the trial's proven shape vs. rebuilding fresh for tenancy.

---

## Decisions (Q1–Q7, locked)

### Decision Q1 — Local persistence: **`expo-sqlite` (a transactional SQLite-backed queue), NOT AsyncStorage or MMKV**

The queue and dead-letter are persisted in a single SQLite database via `expo-sqlite`, using **one transaction per state mutation** and SQLite's default WAL journal. Each outbox entry is **its own row** (not a JSON blob), so an enqueue/dequeue/dead-letter is an atomic single-row `INSERT`/`DELETE`/`UPDATE` inside a transaction that is durable on commit.

**Why (the durability argument):** SQLite is the only candidate of the three that gives **ACID** guarantees — a committed transaction survives a force-kill and device restart, and a crash *during* a write rolls back to the last consistent state rather than corrupting the store (AC 9). expo-sqlite exposes synchronous and async transaction APIs with automatic rollback on failure. The alternatives fail the crux:
- **AsyncStorage** (what the trial used) stores the **entire** queue under one key as a single JSON string, so every enqueue rewrites the whole blob — a kill mid-write can leave a **torn / truncated JSON** that fails to parse on next launch, losing *all* previously-committed entries. It also has a documented init race ("database is locked") under concurrent access and degrades at scale. Rejected for a money-bearing queue.
- **react-native-mmkv** is very fast (memory-mapped, ~30x AsyncStorage) and thread-safe, but for our shape we would still serialize the queue as one value (whole-list rewrite, same torn-write class of risk as AsyncStorage), it has no relational/transactional query for dependency selection, and its mmap durability story is weaker than SQLite's WAL+fsync on an abrupt kill. Good for hot UI state/preferences (a fine future choice for `useAppearance`), not for the durable money queue. Rejected as the queue store.

**Write/commit strategy (the durability contract the adapter must honor):**
- **Enqueue is durable before the UI treats the action as accepted.** `persistRow` `await`s the SQLite `INSERT` transaction **commit** before returning / before the optimistic cache flip is considered safe. The fire-and-forget `flushOutbox()` happens *after* the commit. (The optimistic cache update may render first for snappiness, but the action is only "accepted" once the row is committed; on a crash before commit the UI reconciles on next launch from the durable truth.)
- **One transaction per state transition.** Drain success = `DELETE` the entry in a txn; transient failure = `UPDATE attempts/last_error/next_attempt_at` in a txn; dead-letter = `UPDATE status='dead'` (or move to the dead table) in a txn. No multi-step state ever lands half-written.
- **Crash-tolerant load.** On launch the adapter reads all rows; a row that fails to deserialize (defensive) is skipped and logged, never aborting the whole load (AC 9). Pending/failed counts rehydrate from `COUNT(*)` (AC 7, 10).
- **Schema/key versioning.** A `schema_version` pragma/table (`v1`) namespaces the store; future shape changes are forward-only migrations of the local DB. Logical key prefixes (`outbox`, `dead`) become table/column values, not magic string keys.
- **Expo build implication:** `expo-sqlite` ships in the Expo SDK and runs in the managed/dev-client workflow (a native module — exercised by `expo export` in `ps-verify`; not Expo Go for the production path). No custom config plugin is required for the default database. The mobile-engineer pins the SDK-matching `expo-sqlite` version.

### Decision Q2 — Pure-core vs. mobile-adapter boundary: **all *decisions* in `@ps/core/outbox` (pure, >90% tested); all *I/O* in the mobile adapter**

`@ps/core/outbox` is a new pure module (re-exported from the core root) that owns the queue **state machine** and every **decision**, operating on a plain in-memory `OutboxState` value with the clock passed in. It imports nothing from React/RN/Expo/Supabase/storage and calls no `Date.now()` inside decision functions (verified by the existing `purity.test.ts` mechanism, AC 1). The mobile adapter owns **all** side-effects: SQLite I/O, the Supabase `applyEntry` dispatch, the network watcher, the realtime subscription, the Zustand `useSync` store, and the UI. `applyEntry` (the Supabase upsert/update/delete/`rpc` call) lives **entirely in the adapter**; core never sees Supabase. The adapter catches the Supabase/Postgres error and hands core a normalized `{ code?, status?, message }` so the **pure** `classifyError` decides transient-vs-permanent.

**Normative `@ps/core/outbox` API surface (core-engineer builds exactly this):**

```ts
// ── Entry & state ────────────────────────────────────────────────────────────
export type OutboxOp = 'insert' | 'update' | 'upsert' | 'delete' | 'rpc';
/** 'merge' = upsert ON CONFLICT DO UPDATE (mutable rows, LWW).
 *  'ignore' = upsert ON CONFLICT DO NOTHING (append-only ledger rows). */
export type ConflictStrategy = 'merge' | 'ignore';
export type ErrorClass = 'transient' | 'permanent' | 'auth';

export interface OutboxError { message: string; code?: string; status?: number; class: ErrorClass; }

export interface OutboxEntry {
  localId: string;                 // dedupe identity (client UUID, or a deterministic key)
  tenantId: string;
  branchId: string | null;
  table: string;                   // table name, or the RPC function name when op==='rpc'
  op: OutboxOp;
  payload: Record<string, unknown> | Record<string, unknown>[]; // FROZEN, pre-computed
  pk: string;                      // default 'id'
  conflict: ConflictStrategy;      // append-only entities => 'ignore'
  dependsOn: string[];             // localIds that must succeed before this is eligible
  attempts: number;
  lastError?: OutboxError;
  nextAttemptAt?: string;          // ISO; earliest eligible retry time (backoff)
  deadReason?: 'max-attempts' | 'permanent' | 'blocked-by-dead-parent';
  createdAt: string;               // ISO (passed in)
  updatedAt: string;               // ISO (passed in) — stamped for LWW meaning
}

export interface OutboxState { queue: OutboxEntry[]; dead: OutboxEntry[]; }

export interface RetryPolicy { maxAttempts: number; baseDelayMs: number; factor: number; capMs: number; }
export const DEFAULT_RETRY_POLICY: RetryPolicy; // { maxAttempts: 5, baseDelayMs: 1000, factor: 2, capMs: 30000 }

// ── Pure operations (clock passed in as nowIso) ─────────────────────────────
/** Idempotent enqueue: collapses a re-enqueue of the same localId to ONE entry
 *  (replaces payload/updatedAt, preserves queue position) — exactly-once intent. */
export function enqueueEntry(state: OutboxState, input: NewEntry, nowIso: string): OutboxState;

/** Pure error taxonomy (Q4). Network/timeout/5xx/429/40001/40P01 => 'transient';
 *  401/JWT-expired => 'auth'; 4xx + 42501 (RLS) + 23xxx (constraint) => 'permanent'. */
export function classifyError(err: { code?: string; status?: number; message?: string }): ErrorClass;

/** Pure retry decision for one entry. */
export type RetryDecision =
  | { action: 'retry'; nextAttemptAt: string }
  | { action: 'dead-letter'; reason: 'max-attempts' | 'permanent' };
export function decideRetry(entry: OutboxEntry, errClass: ErrorClass, policy: RetryPolicy, nowIso: string): RetryDecision;

/** Entries eligible to send NOW: dependsOn all succeeded, nextAttemptAt<=now,
 *  not dead; FIFO within a dependency level. */
export function selectDrainable(state: OutboxState, nowIso: string): OutboxEntry[];

/** Transitions — each returns the next (queue, dead) state, pure, no I/O. */
export function onSuccess(state: OutboxState, localId: string): OutboxState;
export function onTransientFailure(state: OutboxState, localId: string, err: OutboxError, policy: RetryPolicy, nowIso: string): OutboxState;
/** Moves the entry to dead AND cascades any (transitive) dependents to dead
 *  with deadReason='blocked-by-dead-parent' — children never orphan-apply. */
export function onPermanentFailure(state: OutboxState, localId: string, err: OutboxError): OutboxState;

/** Dead-letter operator actions (pure state transforms). */
export function requeueDead(state: OutboxState, localId: string | 'all', nowIso: string): OutboxState; // resets attempts, re-queues entry + its blocked dependents
export function discardDead(state: OutboxState, localId: string | 'all'): OutboxState;

// ── Selectors ───────────────────────────────────────────────────────────────
export function pendingCount(state: OutboxState): number;
export function deadCount(state: OutboxState): number;
```

The adapter's drain loop is then thin: `selectDrainable(state, now)` → for each, `applyEntry(entry)` (Supabase) → on success `onSuccess`, on caught error `classifyError` → `onTransientFailure` | `onPermanentFailure`; persist the returned state to SQLite each step; single-flight `flushing` guard; on offline, no-op (AC 17). **The no-double-count invariant is preserved** because core changes nothing about identity: every entry keeps the existing `uuidv4`/`uuidv5` ids and `applyEntry` keeps `upsert(onConflict:'id')` ('merge') or `ON CONFLICT DO NOTHING` ('ignore'); a replay of any entry is the same upsert on the same id.

### Decision Q3 — Ordering / dependency model: **`dependsOn` in the pure core for per-row actions, PLUS one idempotent transactional RPC for the close sequence**

A **hybrid**, per the spec's recommendation bias:
- **The close sequence becomes a single idempotent, server-side transactional RPC `close_session_tx(...)`** (normative SQL below), enqueued as **one** outbox entry (`op:'rpc'`, `localId = close:{sessionId}`). This delivers true **all-or-nothing** (segments + session update + stock movements + device free + audit row commit together or not at all) — eliminating the Phase-5 "close not atomic" residual and removing any intra-close dependency graph. The RPC receives the **already-computed** payload (`@ps/core` runs `planSegments`/`aggregateOpenMeter`/`computeGrandTotal` and freezes the segment rows, totals, and movement rows **before** enqueue — §2.1/§2.2 honored; the RPC does **no** money math). It is `SECURITY INVOKER` so RLS `WITH CHECK` still enforces tenant isolation on every internal write (ADR-0007 discipline; AC 16). It is idempotent by construction: deterministic ids + `ON CONFLICT DO NOTHING` for ledger rows and a terminal-guard for the session (a replay or double-send yields the identical end state — AC 13, 14).
- **All other multi-row actions use explicit `dependsOn`** gated by the pure `selectDrainable` (AC 12): e.g. start session = `session` (parent) → first `session_segment` (`dependsOn:[session.localId]`) → `device→busy`; an `order_item` `dependsOn` its `order`. A child is not eligible until its parent has **succeeded**. Switch-mode already writes its segment set as one array upsert (one entry). Single-row actions (device status, match count, order pay/void, shift open/close, stock adjust/restock) are independent FIFO entries.
- **Parent dead-letters → dependents do NOT orphan-apply.** `onPermanentFailure` **cascades** the (transitive) dependents to the dead list (`deadReason:'blocked-by-dead-parent'`); they surface together and `requeueDead('all')` re-queues parent+children atomically. A dependent never flushes without a succeeded parent (no FK failure, no orphan).

We deliberately wrap **only** the close in an RPC (the money-critical, 5-write, formerly-non-atomic path) and keep everything else per-row: it is the cleanest no-partial-state guarantee exactly where it matters, while avoiding a server function per action and keeping pricing logic in `@ps/core`.

### Decision Q4 — Retry/backoff + dead-letter thresholds + error taxonomy

- **`maxAttempts = 5`** transient attempts (matches the trial), then dead-letter.
- **Backoff:** exponential with full jitter — `delay = random(0, min(capMs, baseDelayMs * factor^attempts))` with `baseDelayMs=1000`, `factor=2`, `capMs=30000` → nominal 1s, 2s, 4s, 8s, 16s. `next_attempt_at` is stored so a relaunch honors the backoff. (`429` honors a server `Retry-After` when present, overriding the computed delay.)
- **Error taxonomy (pure `classifyError`):**
  - **permanent → dead-letter immediately (don't waste 5 attempts):** HTTP `4xx` except `408`/`429`; Postgres `42501` (RLS/insufficient-privilege — a genuine isolation rejection must surface, never silently retry); constraint violations `23505`/`23503`/`23502`/`23514`; `400` validation/`PGRST` schema errors; `403`.
  - **transient → retry with backoff:** network/fetch failures, timeouts, `408`, `429`, `5xx` (`500/502/503/504`), Postgres `40001` (serialization), `40P01` (deadlock), `53x00` (out-of-resources).
  - **auth → refresh-then-retry (bounded):** `401`/JWT-expired triggers `supabase.auth.refreshSession()` once, then retries; still `401` after refresh ⇒ dead-letter (the operator must re-authenticate). This avoids dead-lettering a money write merely because a token expired mid-outage.
- **Dead-letter never blocks the queue** (AC 21): a dead-lettered entry is removed from the active queue and the drain continues with the rest. No money-bearing entry is ever auto-discarded — only quarantined and surfaced for operator retry/discard (with confirm, AC 23).

### Decision Q5 — Realtime tenant-scoping (SECURITY — release blocker): **`postgres_changes` over RLS'd tables, on an authenticated socket, with the tables added to the `supabase_realtime` publication; the existing tenant RLS is the isolation boundary, the client `tenant_id` filter is defense-in-depth only**

**Evidence established (verified):** Supabase Realtime **enforces table RLS for `postgres_changes`** — "When using Postgres Changes on tables with RLS, database records are sent **only** to clients who are allowed to read them based on your RLS policies." Realtime takes the client's verified JWT claims, loads them into a Postgres transaction via `set_config` (`request.jwt.claims`), and evaluates policies before delivering a change event. Tables must be **added to the `supabase_realtime` publication** to stream at all (a migration). (Sources at end: Realtime Authorization; Subscribing to Database Changes; Postgres Changes; Realtime RLS announcement.)

**Mechanism (locked):**
1. **Publication (migration `0009`):** add the operational tables — `devices`, `sessions`, `session_segments`, `orders`, `order_items`, `stock_movements`, `shifts` — to `supabase_realtime`, and set `REPLICA IDENTITY FULL` on them so the **old** row image (carrying `tenant_id`) is available for RLS evaluation on `UPDATE`/`DELETE` events (without it, an old-record's `tenant_id` is absent and RLS/filtering on deletes is unreliable).
2. **The isolation boundary is the existing tenant RLS.** Every one of those tables already has `tenant_id = current_tenant_id()` SELECT policies (migration `0004`). Because `postgres_changes` runs each event through those SELECT policies under the subscriber's JWT, a tenant-A client **cannot** receive a tenant-B row event — DB-enforced, not a client filter (AC 26). This reuses ADR-0002's single isolation surface; **no new realtime-specific RLS table is required** for `postgres_changes`.
3. **Authenticated socket is mandatory.** The realtime client must carry the user's access token so `request.jwt.claims` is populated and RLS applies; the mobile adapter calls `supabase.realtime.setAuth(accessToken)` on connect **and re-calls it on every token refresh** (otherwise a refreshed/rotated token would desync and RLS could fail closed). An unauthenticated socket receives nothing.
4. **Client `filter: tenant_id=eq.<claim tenant>` is added as defense-in-depth** (and to cut noise), explicitly **not** the security boundary — the spec's "client filter alone is insufficient" is satisfied because RLS is the actual gate.
5. **Scope = tenant-level** (not tenant+branch). Tenant is the isolation unit (ADR-0002); branch is an in-tenant grouping a café operator may legitimately watch across (a manager covering two branches). Cache invalidation is cheap; branch-level realtime filtering is an unnecessary refinement and is **not** done this phase.

**Runner-up (documented for the future):** *Broadcast-from-database* on **private channels** with RLS policies on `realtime.messages` (the newer, more scalable model — decouples fan-out from the WAL and is Supabase's recommended path at high connection counts). It is **more machinery** (DB triggers to `realtime.broadcast_changes`, per-topic `realtime.messages` policies keyed by tenant). At café scale (a handful of devices per tenant) `postgres_changes`-over-RLS is sufficient and reuses the audited RLS surface; revisit Broadcast in Phase 10 if connection volume warrants. Its strength — explicit per-topic authorization — is partially captured here by requiring the authenticated socket + RLS gate.

### Decision Q6 — Conflict-resolution policy per entity

| Entity | Policy | Conflict strategy on replay | Guard |
|---|---|---|---|
| `devices.status` | **Last-write-wins** via stamped `updated_at` | `merge` (upsert DO UPDATE) | none — idempotent; latest stamp wins |
| `sessions` | **Terminal once `closed`** (server-authoritative) | close via RPC; `merge` for open edits | **DB trigger** blocks any `UPDATE` transitioning `status` out of `closed` (no un-close / re-bill) — defense in depth beyond client policy |
| `session_segments` | Append/finalize; deterministic ids; only the open segment mutates | `merge` on `id` | none — boundary sub-segments keyed by `seg:{sessionId}:{startedAt}` |
| `orders` | LWW; `void` is terminal | `merge` | trigger guards `void`→non-void (terminal) |
| `order_items` | Append; `is_void` flag LWW; immutable price snapshot | `merge` | none |
| `stock_movements` | **Append-only immutable ledger** | **`ignore`** (ON CONFLICT DO NOTHING) | deterministic ids (`stock-sale:{itemId}`); a replay is a no-op → **never a second decrement** (AC 14, 15). Owner *corrections* remain a separate, deliberate `update` mutation, not a replay |
| `audit_log` | **Append-only immutable ledger** | **`ignore`** (ON CONFLICT DO NOTHING) | deterministic ids (`close:{sessionId}`); fixes a latent issue — `audit_log` has **no UPDATE policy** (migration `0004`), so the current `upsert(onConflict:'id')` DO-UPDATE branch would be RLS-rejected on replay; `ignore` makes replay a true no-op needing no update grant (AC 13) |
| `shifts` | Close is terminal | `merge` | trigger guards re-open of a closed shift |

The per-entity `conflict` strategy is carried on the `OutboxEntry` (Q2) so the adapter picks `upsert` (`merge`) vs `upsert{ ignoreDuplicates:true }` (`ignore`). The terminal guards are **DB triggers** (migration `0009`) — client policy + idempotent keys handle the common case, but a stale offline write landing after a terminal transition must be rejected at the database, not trusted to the client.

### Decision Q7 — Backend changes: **YES — migration `0009` is required (publication + REPLICA IDENTITY + close RPC + terminal-guard triggers). It touches RLS-adjacent surfaces → `security-reviewer` sign-off + `rls-tenant-audit` re-run.**

Phase 8 is **not** mobile-only. `0009` adds: (1) the realtime publication + `REPLICA IDENTITY FULL` (Q5); (2) the idempotent `close_session_tx` RPC (Q3); (3) terminal-state guard triggers (Q6). It alters **no** existing operational write policy and adds **no** `SECURITY DEFINER` on a data path (the RPC is `SECURITY INVOKER`). A **permanently-failed money write** cannot write `audit_log` (it is the failing write), so a dead-letter telemetry trail is **local-only** this phase (surfaced in the sync UI + lightweight structured log); wiring it to Sentry is explicitly deferred to Phase 10 — flagged as a known gap, not closed here.

---

## Forward-only migration (`supabase/migrations/0009_outbox_realtime_and_close_rpc.sql`) — NORMATIVE

backend/supabase-migrate authors the file from this spec. **`security-reviewer` sign-off required (AC 16, 26, 35).** Forward-only. No existing policy is weakened.

```sql
-- =============================================================================
-- Migration 0009 — Phase 8 offline-first hardening:
--   (1) Realtime publication + REPLICA IDENTITY for tenant-scoped postgres_changes
--   (2) Idempotent transactional close RPC (SECURITY INVOKER — RLS still applies)
--   (3) Terminal-state guard triggers (no un-close / un-void / re-open)
--
-- SECURITY REVIEWER: required sign-off. Verify:
--   * Realtime exposes ONLY the listed tables; each already has tenant RLS SELECT,
--     so postgres_changes delivers a row event ONLY to a client that can SELECT it
--     (tenant A never receives tenant B — AC 26).
--   * close_session_tx is SECURITY INVOKER: every internal write is checked by the
--     caller's RLS WITH CHECK (cannot write another tenant — AC 16); it runs no
--     money math (receives frozen integer-piastres payload); it is idempotent.
--   * terminal guards cannot be bypassed by a stale offline write.
-- =============================================================================

-- ── 1. Realtime: publication membership + old-row image for RLS on update/delete
alter table public.devices          replica identity full;
alter table public.sessions         replica identity full;
alter table public.session_segments replica identity full;
alter table public.orders           replica identity full;
alter table public.order_items      replica identity full;
alter table public.stock_movements  replica identity full;
alter table public.shifts           replica identity full;

alter publication supabase_realtime add table
  public.devices, public.sessions, public.session_segments,
  public.orders, public.order_items, public.stock_movements, public.shifts;
-- (No realtime-specific RLS table is needed: postgres_changes enforces the EXISTING
--  per-table tenant SELECT policies from 0004 under the subscriber's JWT.)

-- ── 2. Terminal-state guard triggers (defense in depth for the conflict policy) ─
create or replace function public.guard_session_terminal()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if old.status = 'closed' and new.status is distinct from 'closed' then
    raise exception 'session % is closed (terminal); cannot reopen', old.id
      using errcode = 'check_violation';   -- 23514 => permanent => dead-letter
  end if;
  return new;
end; $$;
drop trigger if exists sessions_guard_terminal on public.sessions;
create trigger sessions_guard_terminal before update on public.sessions
  for each row execute function public.guard_session_terminal();

create or replace function public.guard_shift_terminal()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if old.status = 'closed' and new.status is distinct from 'closed' then
    raise exception 'shift % is closed (terminal)', old.id using errcode = 'check_violation';
  end if;
  return new;
end; $$;
drop trigger if exists shifts_guard_terminal on public.shifts;
create trigger shifts_guard_terminal before update on public.shifts
  for each row execute function public.guard_shift_terminal();

-- ── 3. Idempotent transactional close RPC (SECURITY INVOKER) ──────────────────
-- Receives FROZEN, pre-computed payloads (cost math done in @ps/core before
-- enqueue). Persists all-or-nothing. Idempotent: ledger rows DO NOTHING on
-- conflict; the session terminal-guard makes a replayed close a no-op.
--   p_session_id  uuid
--   p_tenant_id   uuid    -- pinned; RLS WITH CHECK re-verifies against the claim
--   p_branch_id   uuid
--   p_actor_id    uuid
--   p_session_patch jsonb -- {status, ended_at, time_total, grand_total, payment_method, shift_id, updated_at}
--   p_segments    jsonb   -- array of fully-formed session_segments rows
--   p_movements   jsonb   -- array of fully-formed stock_movements rows (deterministic ids)
--   p_device_id   uuid
--   p_audit       jsonb   -- the session.close audit_log row (deterministic id close:{sessionId})
create or replace function public.close_session_tx(
  p_session_id uuid, p_tenant_id uuid, p_branch_id uuid, p_actor_id uuid,
  p_session_patch jsonb, p_segments jsonb, p_movements jsonb,
  p_device_id uuid, p_audit jsonb
) returns void
language plpgsql
security invoker          -- RLS WITH CHECK enforces tenant isolation on every write
set search_path = public
as $$
begin
  -- segments: upsert (merge) — boundary sub-segments have deterministic ids
  insert into public.session_segments
    select * from jsonb_populate_recordset(null::public.session_segments, p_segments)
  on conflict (id) do update set
    play_mode = excluded.play_mode, rate_rule_id = excluded.rate_rule_id,
    price_per_hour_snapshot = excluded.price_per_hour_snapshot,
    started_at = excluded.started_at, ended_at = excluded.ended_at,
    updated_at = excluded.updated_at;

  -- session: terminal-guarded update (idempotent — re-close lands same end state)
  update public.sessions s set
    status         = p_session_patch->>'status',
    ended_at       = (p_session_patch->>'ended_at')::timestamptz,
    time_total     = (p_session_patch->>'time_total')::bigint,
    grand_total    = (p_session_patch->>'grand_total')::bigint,
    payment_method = nullif(p_session_patch->>'payment_method',''),
    shift_id       = nullif(p_session_patch->>'shift_id','')::uuid,
    updated_at     = (p_session_patch->>'updated_at')::timestamptz
  where s.id = p_session_id and s.tenant_id = p_tenant_id
    and s.status <> 'closed';     -- replay/no-op safe; guard trigger backstops

  -- stock movements: append-only ledger — DO NOTHING so a replay never re-decrements
  insert into public.stock_movements
    select * from jsonb_populate_recordset(null::public.stock_movements, p_movements)
  on conflict (id) do nothing;

  -- device free (LWW)
  update public.devices d set status = 'free', updated_at = (p_session_patch->>'updated_at')::timestamptz
  where d.id = p_device_id and d.tenant_id = p_tenant_id;

  -- audit: append-only — DO NOTHING (no UPDATE policy exists for audit_log)
  insert into public.audit_log
    select * from jsonb_populate_record(null::public.audit_log, p_audit)
  on conflict (id) do nothing;
end; $$;

grant execute on function public.close_session_tx(
  uuid,uuid,uuid,uuid,jsonb,jsonb,jsonb,uuid,jsonb) to authenticated;

-- =============================================================================
-- END OF MIGRATION 0009
-- =============================================================================
```

**RLS-safety reasoning:** Realtime adds **no** new policy — it reuses `0004`'s tenant SELECT policies, which `postgres_changes` evaluates per event under the subscriber's JWT, so cross-tenant delivery is impossible (AC 26). `close_session_tx` is `SECURITY INVOKER`, so each internal `insert`/`update` is still checked by the caller's RLS `WITH CHECK` — a queue carrying a mismatched `tenant_id` is rejected exactly as a direct write would be (AC 16); it never bypasses isolation and adds no `SECURITY DEFINER` data path. The terminal guards are `SECURITY INVOKER` triggers that only **reject** illegal transitions. **Verify in `rls-tenant-audit` (AC 16) and `security-reviewer` sign-off (AC 26, 35).**

---

## Options considered (the load-bearing choices)

### Local persistence (Decision Q1)
- **Option A — `expo-sqlite`, row-per-entry, txn-per-mutation (CHOSEN).** Pros: ACID; committed entries survive force-kill/restart; crash mid-write rolls back (no torn store); relational queries for dependency selection; per-row atomic ops (no whole-blob rewrite). Cons: heavier than KV; a tiny schema to version. Evidence: [Expo SQLite (transactions, async API, rollback)](https://docs.expo.dev/versions/latest/sdk/sqlite/); [SQLite for RN — ACID](https://oneuptime.com/blog/post/2026-01-15-react-native-sqlite/view).
- **Option B — AsyncStorage (trial default).** Pros: simplest, zero schema. Cons: whole-key JSON rewrite → torn/truncated write on kill can lose the **entire** queue; documented init race / "database is locked"; degrades at scale. Rejected for a money queue. Evidence: [AsyncStorage race condition #33754](https://github.com/expo/expo/issues/33754); [storage decision guide](https://www.pkgpulse.com/guides/react-native-mmkv-vs-async-storage-vs-expo-secure-store-2026).
- **Option C — react-native-mmkv.** Pros: very fast, thread-safe, great for hot UI state. Cons: still whole-list serialization for our shape (same torn-write class), no relational dependency query, weaker abrupt-kill durability story than SQLite WAL. Rejected as the queue store (fine for preferences). Evidence: [storage decision guide](https://www.pkgpulse.com/guides/react-native-mmkv-vs-async-storage-vs-expo-secure-store-2026).

### Realtime tenant-scoping (Decision Q5)
- **Option A — `postgres_changes` over existing RLS, authenticated socket, publication + REPLICA IDENTITY (CHOSEN).** Pros: DB-enforced tenant confinement reusing the one audited RLS surface; minimal machinery; only a publication/identity migration. Cons: WAL-coupled fan-out (fine at café scale); requires `setAuth` discipline on refresh; needs REPLICA IDENTITY FULL for delete/update old-row RLS. Evidence: [Realtime Authorization](https://supabase.com/docs/guides/realtime/authorization); [Subscribing to DB changes (publication required)](https://supabase.com/docs/guides/realtime/subscribing-to-database-changes); [Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes); [Realtime RLS announcement](https://supabase.com/blog/realtime-row-level-security-in-postgresql).
- **Option B — Broadcast-from-database, private channels, RLS on `realtime.messages`.** Pros: scalable; explicit per-topic authorization; decoupled from WAL. Cons: more machinery (broadcast triggers + `realtime.messages` policies keyed by tenant topic); over-engineered for café connection counts. Deferred to Phase 10 if volume warrants. Evidence: [Realtime Authorization (private channels / realtime.messages)](https://supabase.com/docs/guides/realtime/authorization); [Broadcast & Presence Authorization blog](https://supabase.com/blog/supabase-realtime-broadcast-and-presence-authorization).
- **Option C — client-side `tenant_id` filter only.** Rejected outright: a client filter does **not** prevent the server delivering another tenant's events; it is not an isolation boundary. Kept only as defense-in-depth atop RLS.

### Close ordering (Decision Q3)
- **Option A — one idempotent transactional RPC for close + `dependsOn` for the rest (CHOSEN).** Pros: true atomicity exactly where money lives; fixes the Phase-5 residual; collapses close to one entry; pricing stays in `@ps/core`. Cons: one new server function (must be idempotent + RLS-safe). Evidence: [PostgreSQL functions/transactions](https://www.postgresql.org/docs/current/plpgsql-structure.html).
- **Option B — pure `dependsOn` for everything (no RPC).** Pros: no backend addition; all writes per-row. Cons: close stays non-atomic (partial state still possible between row writes); does not fix the Phase-5 residual. Rejected for the close specifically.
- **Option C — strict FIFO only.** Pros: simplest. Cons: cannot express "child waits for parent" robustly; a reordered enqueue or partial flush risks FK failures. Rejected.

---

## Per-engineer hand-off

- **core-engineer:** build `packages/core/src/outbox/` to the **normative API surface** in Decision Q2 — `OutboxEntry`/`OutboxState`/`RetryPolicy` types, `enqueueEntry` (idempotent dedupe by `localId`), `classifyError` (Q4 taxonomy), `decideRetry` (exp backoff + jitter, `maxAttempts=5`), `selectDrainable` (dependency + backoff + FIFO), `onSuccess`/`onTransientFailure`/`onPermanentFailure` (with dead-parent cascade), `requeueDead`/`discardDead`, selectors. **Pure** (no React/RN/Expo/Supabase/storage; no `Date.now()` in decisions — clock passed in); re-export from the core root; **>90% line coverage**; extend `purity.test.ts` to the new path (AC 1–6).
- **mobile-engineer:** build the **`expo-sqlite` durable adapter** (row-per-entry, txn-per-mutation, crash-tolerant load, count rehydrate — Q1, AC 7–10); the `persistRow({table,op,row,pk?,dependsOn?,conflict?})` bridge (await commit before "accepted", then fire-and-forget flush); `applyEntry` dispatch (upsert `merge`/`ignore`, `update`, `delete`, **`rpc`→`close_session_tx`**) catching errors into the normalized `{code,status,message}` core consumes; the **network watcher** (`navigator.onLine` + interval + AppState foreground + web online/offline; **no** cross-origin probe — AC 19); the **tenant-scoped realtime** subscription (authenticated socket, `setAuth` on connect **and on every token refresh**, `filter:tenant_id` as defense-in-depth — Q5); `useSync` store (`online/syncing/pending/failed/lastSyncedAt`) + rehydration; the **sync-status UI** (indicator + detail screen, retry/discard with confirm-for-money, RTL/Arabic-Indic — AC 28–32). **Reroute every existing mutation** (session start/switch/close; order add/pay/void; stock restock/adjust/sale; shift open/close; device status) through the outbox, **preserving payloads + `uuidv4`/`uuidv5` keys**; the close path now builds the frozen payload and enqueues a single `op:'rpc'` entry calling `close_session_tx` (AC 11–15).
- **backend / supabase-migrate (REQUIRED this phase):** author `0009_outbox_realtime_and_close_rpc.sql` **verbatim** from the normative SQL (publication + `REPLICA IDENTITY FULL`; `close_session_tx` `SECURITY INVOKER`; terminal-guard triggers + grant). Forward-only; weaken no existing policy. **Get `security-reviewer` sign-off before merge; re-run `rls-tenant-audit`.**
- **ux-designer:** the sync indicator (online/offline + pending/failed badges + syncing spinner + last-synced) and detail screen (pending list, dead-letter list with errors, retry/discard, confirm-dialog for discarding money writes), plus the **all-clear** (everything synced, AC 30) and **dead-letter alarm** states — fresh RTL/Arabic-first via `ui-ux-pro-max` + magic MCP; extend the existing `OfflineBanner` pattern; all strings via i18n; Arabic-Indic counts/times.
- **security-reviewer (REQUIRED — release blocker):** owns **AC 26** (realtime delivers **zero** of another tenant's events — verify the publication exposes only RLS'd tables and `postgres_changes` evaluates the `0004` tenant SELECT policies under the subscriber JWT) and **AC 16** (the queue/`close_session_tx` cannot bypass RLS — `SECURITY INVOKER`, `WITH CHECK` rejects a mismatched `tenant_id`). Confirm: no operational policy weakened; no `SECURITY DEFINER` data path added; terminal guards cannot be bypassed by a stale write.
- **QA gates on:** Block C (idempotency / no-double-count) + Block E (dead-letter doesn't block) as **hard resilience gates**; Block B (crash-safety) as the durability gate; **AC 26** (tenant isolation) as the security gate; Block I (`ps-verify` + `offline-outbox-guard` all-PASS) as done. Critical set: **AC 7, 8, 13, 14, 15, 21, 26**.

## Consequences

- **Becomes easy:** durable offline writes that survive force-kill (SQLite ACID); a genuinely atomic close (RPC) that also retires the Phase-5 "close not atomic" residual; exactly-once effect preserved unchanged (same `uuidv4`/`uuidv5` keys + upsert/`ON CONFLICT DO NOTHING`); pure, >90%-tested resilience logic that runs under Jest with no device; tenant-isolated realtime that reuses the one audited RLS surface (no new realtime RLS table); a clear operator "is everything synced?" signal at drawer count.
- **Becomes hard / accepted risk:** `expo-sqlite` is a native module (dev-client/prebuild, not Expo Go for production) — pinned to the SDK; the realtime socket **must** be re-`setAuth`'d on token refresh or RLS desyncs (mobile responsibility, called out); a permanently-failed **money** write cannot self-audit (it is the failing write) — dead-letter telemetry is local-only this phase, Sentry wiring deferred to Phase 10 (known gap); a dead-lettered parent cascades its dependents to dead (correct, but the operator must retry the group). `REPLICA IDENTITY FULL` slightly increases WAL volume on update/delete (acceptable at café scale).
- **Follow-up / deferred:** Broadcast-from-database realtime (Phase 10 if connection volume warrants); OS background/headless flush (deferred — drains on launch/foreground/reconnect); web offline (web stays online-only); MMKV for hot UI state (optional, separate from the queue); dead-letter→Sentry telemetry (Phase 10).
- **Must verify (Phase-8 gates):** `offline-outbox-guard` seven invariants PASS; resilience tests — replay-after-crash is a no-op (AC 8), duplicate-send no-op (AC 14), voided sale reverses exactly one movement (AC 15), poison→dead-letter while draining (AC 21); `rls-tenant-audit` proves the queue cannot write cross-tenant (AC 16) and realtime delivers zero cross-tenant events (AC 26); `ps-verify` green (`tsc`, `jest` incl. >90% core outbox, `expo export`). **Sign-off:** `security-reviewer` on the realtime scoping + `0009` migration (release blocker); human project owner at the Phase-8 gate (Q1 persistence, Q3b close RPC, Q5 realtime posture).

## User-only / live-verification actions (cannot be done by the CLI/agents)

1. **Confirm Realtime is enabled** for the project (Dashboard → Database → Replication / Realtime) and that the `supabase_realtime` publication change from `0009` applied to the hosted project.
2. **Live cross-tenant realtime verification (AC 26)** against hosted Supabase with two tenant sessions — consistent with the Phases 2–7 posture, this gate may record **"static pass — pending live verification"** if hosted verification is out of scope; the human confirms which at the gate.
3. **Confirm the access-token refresh path re-runs `setAuth`** in a real device session (token rotation) so realtime RLS stays in force — a live smoke check, not automatable here.
4. **Pin/confirm the `expo-sqlite` version** matches the installed Expo SDK before the EAS/dev-client build (Phase 10 build pipeline).

## Sources

- Supabase — Realtime Authorization (private channels; RLS on `realtime.messages`; JWT claims via `set_config`/`request.jwt.claims`; postgres_changes respects table RLS): https://supabase.com/docs/guides/realtime/authorization
- Supabase — Subscribing to Database Changes (tables must be added to `supabase_realtime` publication): https://supabase.com/docs/guides/realtime/subscribing-to-database-changes
- Supabase — Postgres Changes (RLS-filtered delivery; private/public channels): https://supabase.com/docs/guides/realtime/postgres-changes
- Supabase — Realtime Row Level Security announcement (records sent only to clients allowed to read them): https://supabase.com/blog/realtime-row-level-security-in-postgresql
- Supabase — Broadcast & Presence Authorization (runner-up scalable model): https://supabase.com/blog/supabase-realtime-broadcast-and-presence-authorization
- Expo — SQLite (transactions, async API, automatic rollback; managed/dev-client): https://docs.expo.dev/versions/latest/sdk/sqlite/
- SQLite for React Native — ACID compliance / transactional integrity: https://oneuptime.com/blog/post/2026-01-15-react-native-sqlite/view
- Expo — AsyncStorage/kv-store race condition ("database is locked"): https://github.com/expo/expo/issues/33754
- RN storage decision guide (MMKV vs AsyncStorage vs SecureStore; durability trade-offs): https://www.pkgpulse.com/guides/react-native-mmkv-vs-async-storage-vs-expo-secure-store-2026
- PostgreSQL — PL/pgSQL functions & transactional execution (the close RPC): https://www.postgresql.org/docs/current/plpgsql-structure.html
