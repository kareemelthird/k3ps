/**
 * Outbox — the pure, crash-safe write-queue state machine (ADR-0009 §Q2).
 *
 * This module owns every *decision* in the offline write queue: idempotent
 * enqueue, error classification, retry/backoff, drain selection (dependency
 * gating + FIFO), and the success / transient-failure / permanent-failure
 * transitions (including the dead-parent cascade). It owns **no I/O**: SQLite
 * persistence, the Supabase `applyEntry` dispatch, the network watcher, the
 * realtime subscription, and the Zustand store all live in the mobile adapter
 * (ADR-0009 §Q2). The adapter catches the Supabase/Postgres error, normalizes
 * it to `{ code?, status?, message? }`, and lets the pure `classifyError` decide.
 *
 * PURITY (CLAUDE.md §2.4):
 *   - No imports from React/RN/Expo/Next/Supabase/storage.
 *   - No system-clock read inside any decision — the clock (`nowIso`) is always
 *     an argument. `Date.parse` / `new Date(ms).toISOString()` only parse/format
 *     a value that was *passed in*; they never read the wall clock. Same input →
 *     same output. Jitter is injected (`rng`) so backoff is deterministic in tests.
 *
 * NO-DOUBLE-COUNT (CLAUDE.md §2.8):
 *   The queue changes nothing about row identity. Each `OutboxEntry` keeps its
 *   client-generated `uuidv4` / deterministic `uuidv5` id in the payload, and
 *   the adapter applies it with the per-entity `conflict` strategy:
 *     - 'merge'  → upsert ON CONFLICT DO UPDATE (mutable rows, last-write-wins)
 *     - 'ignore' → upsert ON CONFLICT DO NOTHING (append-only ledger rows:
 *                  stock_movements, audit_log)
 *   A replay of any entry — after a lost ack, a crash mid-flush, or a duplicate
 *   enqueue — is therefore the *same* upsert on the *same* id: exactly-once
 *   *effect*, never a second money/stock movement. `enqueueEntry` further
 *   collapses a duplicate enqueue of the same `localId` to a single entry
 *   (exactly-once *intent*), so the queue never even tries to send it twice.
 */

// ── Entry & state ────────────────────────────────────────────────────────────

/** Supabase write verb the adapter dispatches for an entry. */
export type OutboxOp = 'insert' | 'update' | 'upsert' | 'delete' | 'rpc';

/**
 * Conflict strategy carried per entry so the adapter knows how to upsert.
 *  - 'merge'  = ON CONFLICT DO UPDATE (mutable rows, last-write-wins).
 *  - 'ignore' = ON CONFLICT DO NOTHING (append-only ledger rows — a replay is a
 *               true no-op, so a replayed sale never decrements stock twice).
 */
export type ConflictStrategy = 'merge' | 'ignore';

/** Error taxonomy the retry engine acts on (ADR-0009 §Q4). */
export type ErrorClass = 'transient' | 'permanent' | 'auth';

/** Why an entry was moved to the dead-letter list. */
export type DeadReason = 'max-attempts' | 'permanent' | 'blocked-by-dead-parent';

/** A normalized, framework-free error the adapter hands the pure core. */
export interface OutboxError {
  message: string;
  code?: string;
  status?: number;
  class: ErrorClass;
}

/**
 * A single durable, idempotent mutation awaiting delivery.
 *
 * Status is **not** a field: a `pending` entry lives in `OutboxState.queue`, a
 * `dead` entry lives in `OutboxState.dead` (with `deadReason`). "in-flight" is a
 * transient adapter concern (the single-flight `flushing` guard), never part of
 * the durable state, so a crash mid-send rehydrates the entry as plain pending
 * and re-sends it idempotently. (ADR-0009 §Q2.)
 */
export interface OutboxEntry {
  /** Dedupe identity: the client UUID (`uuidv4`) or a deterministic key (`uuidv5`). */
  localId: string;
  tenantId: string;
  branchId: string | null;
  /** Table name, or the RPC function name when `op === 'rpc'`. */
  table: string;
  op: OutboxOp;
  /** FROZEN, pre-computed payload (integer-piastres; cost math already ran). */
  payload: Record<string, unknown> | Record<string, unknown>[];
  /** Primary-key column (default 'id'). */
  pk: string;
  /** Append-only entities use 'ignore'; mutable rows use 'merge'. */
  conflict: ConflictStrategy;
  /** localIds that must SUCCEED before this entry is eligible to send. */
  dependsOn: string[];
  /** Count of failed send attempts so far. */
  attempts: number;
  lastError?: OutboxError;
  /** ISO: earliest eligible retry time (backoff). Absent ⇒ eligible now. */
  nextAttemptAt?: string;
  deadReason?: DeadReason;
  /** ISO (passed in). */
  createdAt: string;
  /** ISO (passed in) — stamped for last-write-wins meaning. */
  updatedAt: string;
}

/** The whole durable queue state: pending entries + the dead-letter list. */
export interface OutboxState {
  queue: OutboxEntry[];
  dead: OutboxEntry[];
}

/**
 * The caller-supplied shape for {@link enqueueEntry}. Delivery bookkeeping
 * (attempts, errors, backoff, timestamps) is managed by the core.
 */
export interface NewEntry {
  localId: string;
  tenantId: string;
  branchId: string | null;
  table: string;
  op: OutboxOp;
  payload: Record<string, unknown> | Record<string, unknown>[];
  /** Defaults to 'id'. */
  pk?: string;
  /** Defaults to 'merge'. */
  conflict?: ConflictStrategy;
  /** Defaults to []. */
  dependsOn?: string[];
}

/** Retry/backoff configuration (ADR-0009 §Q4). */
export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  factor: number;
  capMs: number;
}

/** Default: 5 attempts, exponential 1s/2s/4s/8s/16s, capped at 30s. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 1000,
  factor: 2,
  capMs: 30000,
};

/** A pure jitter source in `[0, 1)`. Inject a constant in tests. */
export type Rng = () => number;

// ── Small pure helpers (no clock read) ───────────────────────────────────────

/** ISO of `iso` shifted by `ms`. Parses/formats a passed-in value only. */
function isoPlusMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

/** True when `aIso <= bIso`. Treats an unparseable `aIso` as "eligible now". */
function lte(aIso: string | undefined, bIso: string): boolean {
  if (aIso == null) return true;
  return Date.parse(aIso) <= Date.parse(bIso);
}

// ── Enqueue (idempotent) ─────────────────────────────────────────────────────

/**
 * Idempotent enqueue. If an entry with the same `localId` already exists in the
 * queue, its payload / op / conflict / dependsOn / `updatedAt` are refreshed
 * **in place** (preserving queue position, attempts, and backoff) — a
 * re-enqueue of the same logical mutation collapses to ONE entry (exactly-once
 * intent). A `localId` already in the dead-letter list is left there untouched
 * (the operator must explicitly `requeueDead` it); the new enqueue is ignored so
 * a background re-enqueue cannot silently resurrect a quarantined money write.
 *
 * Pure: returns a new state; never mutates `state` or its entries.
 */
export function enqueueEntry(state: OutboxState, input: NewEntry, nowIso: string): OutboxState {
  // A dead entry with this id is quarantined — do not re-add or duplicate it.
  if (state.dead.some((e) => e.localId === input.localId)) {
    return { queue: state.queue.slice(), dead: state.dead.slice() };
  }

  const existingIdx = state.queue.findIndex((e) => e.localId === input.localId);
  if (existingIdx >= 0) {
    const existing = state.queue[existingIdx]!;
    const refreshed: OutboxEntry = {
      ...existing,
      table: input.table,
      op: input.op,
      payload: input.payload,
      pk: input.pk ?? existing.pk,
      conflict: input.conflict ?? existing.conflict,
      dependsOn: input.dependsOn ?? existing.dependsOn,
      tenantId: input.tenantId,
      branchId: input.branchId,
      updatedAt: nowIso,
    };
    const queue = state.queue.slice();
    queue[existingIdx] = refreshed;
    return { queue, dead: state.dead.slice() };
  }

  const entry: OutboxEntry = {
    localId: input.localId,
    tenantId: input.tenantId,
    branchId: input.branchId,
    table: input.table,
    op: input.op,
    payload: input.payload,
    pk: input.pk ?? 'id',
    conflict: input.conflict ?? 'merge',
    dependsOn: input.dependsOn ?? [],
    attempts: 0,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  return { queue: [...state.queue, entry], dead: state.dead.slice() };
}

// ── Error taxonomy ───────────────────────────────────────────────────────────

/**
 * Pure error taxonomy (ADR-0009 §Q4).
 *  - 'auth'      → 401 / JWT-expired (adapter refreshes the session once, then
 *                 retries; a still-auth error after refresh is dead-lettered).
 *  - 'permanent' → 4xx (except 408/429); Postgres 42501 (RLS), 23xxx (constraint);
 *                 PGRST schema/validation errors. Dead-letter immediately — a
 *                 genuine RLS/constraint rejection must surface, never burn 5
 *                 attempts.
 *  - 'transient' → network/timeout/unknown, 408, 429, 5xx, Postgres 40001
 *                 (serialization), 40P01 (deadlock), 53x00 (out-of-resources).
 */
export function classifyError(err: { code?: string; status?: number; message?: string }): ErrorClass {
  const code = err.code;
  const status = err.status;
  const message = err.message ?? '';

  // ── auth first (a token expiry must not be mistaken for a permanent 4xx) ──
  if (status === 401 || code === 'PGRST301' || /jwt (expired|invalid)/i.test(message)) {
    return 'auth';
  }

  // ── Postgres SQLSTATE codes (most specific) ──
  if (code) {
    if (code === '42501') return 'permanent'; // RLS / insufficient privilege
    if (code.startsWith('23')) return 'permanent'; // 23505/23503/23502/23514 constraints
    if (code === '40001' || code === '40P01') return 'transient'; // serialization / deadlock
    if (/^53\d{3}$/.test(code)) return 'transient'; // 53x00 out-of-resources
    if (code.startsWith('PGRST')) return 'permanent'; // schema / validation
  }

  // ── HTTP status ──
  if (typeof status === 'number') {
    if (status === 408 || status === 429) return 'transient';
    if (status >= 500) return 'transient';
    if (status >= 400) return 'permanent';
  }

  // ── No status / network failure / timeout / unknown → transient ──
  return 'transient';
}

// ── Retry decision ───────────────────────────────────────────────────────────

export type RetryDecision =
  | { action: 'retry'; nextAttemptAt: string }
  | { action: 'dead-letter'; reason: 'max-attempts' | 'permanent' };

/**
 * Pure retry decision for one entry given the classified error.
 *
 * - 'permanent' / 'auth' → dead-letter immediately (reason 'permanent'). The
 *   adapter handles the auth refresh-once *before* calling this; an 'auth' that
 *   reaches here means refresh already failed, so it dead-letters.
 * - 'transient' → if this failure reaches `maxAttempts`, dead-letter
 *   ('max-attempts'); else retry after a full-jitter exponential backoff:
 *     ceiling = min(capMs, baseDelayMs * factor^attempts)
 *     delay   = floor(rng() * ceiling)          // random(0, ceiling)
 *   With the default policy and `rng → 1` the schedule is 1s/2s/4s/8s, then the
 *   5th failure dead-letters. `nextAttemptAt` is `nowIso + delay`, so a relaunch
 *   honors the backoff. `rng` is injectable for deterministic tests.
 */
export function decideRetry(
  entry: OutboxEntry,
  errClass: ErrorClass,
  policy: RetryPolicy,
  nowIso: string,
  rng: Rng = Math.random,
): RetryDecision {
  if (errClass !== 'transient') {
    return { action: 'dead-letter', reason: 'permanent' };
  }
  const attemptsAfter = entry.attempts + 1;
  if (attemptsAfter >= policy.maxAttempts) {
    return { action: 'dead-letter', reason: 'max-attempts' };
  }
  const ceiling = Math.min(policy.capMs, policy.baseDelayMs * Math.pow(policy.factor, entry.attempts));
  const delay = Math.floor(rng() * ceiling);
  return { action: 'retry', nextAttemptAt: isoPlusMs(nowIso, delay) };
}

// ── Drain selection ──────────────────────────────────────────────────────────

/**
 * Entries eligible to send NOW, in FIFO order:
 *  - backoff elapsed (`nextAttemptAt <= now`, or unset);
 *  - every `dependsOn` localId has SUCCEEDED — i.e. it is neither still in the
 *    queue nor in the dead-letter list. A dependency that is still pending, or
 *    that has dead-lettered, blocks the child so it never orphan-applies.
 */
export function selectDrainable(state: OutboxState, nowIso: string): OutboxEntry[] {
  const queuedIds = new Set(state.queue.map((e) => e.localId));
  const deadIds = new Set(state.dead.map((e) => e.localId));
  return state.queue.filter((e) => {
    if (!lte(e.nextAttemptAt, nowIso)) return false;
    for (const dep of e.dependsOn) {
      if (queuedIds.has(dep) || deadIds.has(dep)) return false;
    }
    return true;
  });
}

// ── Transitions ──────────────────────────────────────────────────────────────

/** Collect the transitive set of queued dependents of `rootIds`. */
function transitiveDependents(queue: OutboxEntry[], rootIds: Set<string>): Set<string> {
  const blocked = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of queue) {
      if (blocked.has(e.localId)) continue;
      if (e.dependsOn.some((d) => rootIds.has(d) || blocked.has(d))) {
        blocked.add(e.localId);
        changed = true;
      }
    }
  }
  return blocked;
}

/**
 * A drained entry succeeded: remove it from the queue. Its dependents become
 * eligible on the next {@link selectDrainable}. No-op if `localId` is unknown.
 */
export function onSuccess(state: OutboxState, localId: string): OutboxState {
  return {
    queue: state.queue.filter((e) => e.localId !== localId),
    dead: state.dead.slice(),
  };
}

/**
 * A transient failure on `localId`. Increments attempts and either re-schedules
 * the entry with backoff (kept in the queue) or — at `maxAttempts` — dead-letters
 * it and cascades its dependents to dead ('blocked-by-dead-parent'). The rest of
 * the queue is untouched, so one struggling write never wedges the others.
 */
export function onTransientFailure(
  state: OutboxState,
  localId: string,
  err: OutboxError,
  policy: RetryPolicy,
  nowIso: string,
  rng: Rng = Math.random,
): OutboxState {
  const idx = state.queue.findIndex((e) => e.localId === localId);
  if (idx < 0) return { queue: state.queue.slice(), dead: state.dead.slice() };
  const entry = state.queue[idx]!;
  const decision = decideRetry(entry, err.class, policy, nowIso, rng);
  const attempts = entry.attempts + 1;

  if (decision.action === 'retry') {
    const updated: OutboxEntry = {
      ...entry,
      attempts,
      lastError: err,
      nextAttemptAt: decision.nextAttemptAt,
    };
    const queue = state.queue.slice();
    queue[idx] = updated;
    return { queue, dead: state.dead.slice() };
  }

  // dead-letter + cascade dependents. The reason mirrors decideRetry: normally
  // 'max-attempts'; defensively 'permanent' if a non-transient err was routed here.
  const deadEntry: OutboxEntry = {
    ...entry,
    attempts,
    lastError: err,
    nextAttemptAt: undefined,
    deadReason: decision.reason,
  };
  return cascadeDeadLetter(state, deadEntry);
}

/**
 * A permanent failure on `localId`: move it to the dead-letter list (reason
 * 'permanent') AND cascade its (transitive) dependents to dead with reason
 * 'blocked-by-dead-parent', so a child never flushes without a succeeded parent
 * (no FK failure, no orphan apply). The rest of the queue keeps draining.
 */
export function onPermanentFailure(state: OutboxState, localId: string, err: OutboxError): OutboxState {
  const idx = state.queue.findIndex((e) => e.localId === localId);
  if (idx < 0) return { queue: state.queue.slice(), dead: state.dead.slice() };
  const entry = state.queue[idx]!;
  const deadEntry: OutboxEntry = {
    ...entry,
    lastError: err,
    nextAttemptAt: undefined,
    deadReason: 'permanent',
  };
  return cascadeDeadLetter(state, deadEntry);
}

/**
 * Shared dead-letter mechanism: remove `deadEntry` and all of its transitive
 * queued dependents from the queue; append the parent (with its given
 * `deadReason`) then the cascaded children ('blocked-by-dead-parent') to the
 * dead list. Parent precedes children in the dead list so a later `requeueDead`
 * restores them in dependency order.
 */
function cascadeDeadLetter(state: OutboxState, deadEntry: OutboxEntry): OutboxState {
  const rootIds = new Set([deadEntry.localId]);
  const blocked = transitiveDependents(state.queue, rootIds);
  const cascaded = state.queue
    .filter((e) => blocked.has(e.localId) && e.localId !== deadEntry.localId)
    .map((e): OutboxEntry => ({ ...e, deadReason: 'blocked-by-dead-parent' }));

  const queue = state.queue.filter((e) => e.localId !== deadEntry.localId && !blocked.has(e.localId));
  return { queue, dead: [...state.dead, deadEntry, ...cascaded] };
}

// ── Dead-letter operator actions ─────────────────────────────────────────────

/**
 * Re-queue dead-lettered entries (operator "retry"). `'all'` requeues every dead
 * entry; a single `localId` requeues that entry **plus** its transitive
 * 'blocked-by-dead-parent' dependents, so a parent and the children it blocked
 * are restored as a group (a child never returns without its parent). Delivery
 * state is reset (attempts → 0, error/backoff/deadReason cleared); the frozen
 * payload and `updatedAt` are preserved (the data did not change — only delivery
 * is retried). Requeued entries are appended in dead-list order (parents first),
 * preserving dependency ordering for {@link selectDrainable}.
 */
export function requeueDead(state: OutboxState, localId: string | 'all', nowIso: string): OutboxState {
  void nowIso; // accepted for signature symmetry; delivery reset needs no clock
  const targets = selectDeadGroup(state.dead, localId);
  if (targets.size === 0) return { queue: state.queue.slice(), dead: state.dead.slice() };

  const requeued = state.dead
    .filter((e) => targets.has(e.localId))
    .map(
      (e): OutboxEntry => ({
        ...e,
        attempts: 0,
        lastError: undefined,
        nextAttemptAt: undefined,
        deadReason: undefined,
      }),
    );
  return {
    queue: [...state.queue, ...requeued],
    dead: state.dead.filter((e) => !targets.has(e.localId)),
  };
}

/**
 * Discard dead-lettered entries (operator "discard", confirmed in the UI for
 * money writes). `'all'` clears the dead list; a single `localId` discards that
 * entry **and** its 'blocked-by-dead-parent' dependents as a group — discarding a
 * parent without its blocked children would leave a child whose parent is now
 * absent, which a later requeue could orphan-apply.
 */
export function discardDead(state: OutboxState, localId: string | 'all'): OutboxState {
  const targets = selectDeadGroup(state.dead, localId);
  return {
    queue: state.queue.slice(),
    dead: state.dead.filter((e) => !targets.has(e.localId)),
  };
}

/**
 * Resolve the set of dead localIds an operator action targets: `'all'` ⇒ every
 * dead entry; a single id ⇒ that id plus its transitive dependents in the dead
 * list whose `deadReason` is 'blocked-by-dead-parent'.
 */
function selectDeadGroup(dead: OutboxEntry[], localId: string | 'all'): Set<string> {
  if (localId === 'all') return new Set(dead.map((e) => e.localId));
  if (!dead.some((e) => e.localId === localId)) return new Set();
  const group = new Set<string>([localId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of dead) {
      if (group.has(e.localId)) continue;
      if (e.deadReason === 'blocked-by-dead-parent' && e.dependsOn.some((d) => group.has(d))) {
        group.add(e.localId);
        changed = true;
      }
    }
  }
  return group;
}

// ── Selectors ────────────────────────────────────────────────────────────────

/** Number of pending (queued, not dead-lettered) entries. */
export function pendingCount(state: OutboxState): number {
  return state.queue.length;
}

/** Number of dead-lettered entries awaiting operator action. */
export function deadCount(state: OutboxState): number {
  return state.dead.length;
}
