/**
 * outboxAdapter — the mobile adapter for the offline write-outbox (ADR-0009).
 *
 * Owns all I/O: expo-sqlite durable persistence, Supabase applyEntry dispatch,
 * auth-refresh-once, Zustand useSync updates, and the single-flight drain loop.
 *
 * The pure @ps/core/outbox module owns all DECISIONS (retry, dead-letter, drain
 * selection, dependency ordering). This adapter only calls those pure functions,
 * persists the returned state, and applies the Supabase side-effect.
 *
 * DURABILITY CONTRACT (ADR-0009 §Q1):
 *   persistRow AWAITS the SQLite commit before returning. The UI is only allowed
 *   to treat an action as "accepted" after persistRow resolves. The Supabase
 *   write happens later (fire-and-forget triggerDrain). A crash between the
 *   commit and the Supabase write leaves the entry as pending — the drain
 *   re-sends it idempotently on next launch/reconnect (AC 7, 8).
 *
 * NO-DOUBLE-COUNT:
 *   applyEntry uses the per-entry conflict strategy:
 *     'merge'  → upsert ON CONFLICT DO UPDATE (mutable rows, LWW)
 *     'ignore' → upsert ON CONFLICT DO NOTHING (stock_movements, audit_log)
 *   A replayed entry (after a lost ack, crash mid-flush, or duplicate enqueue)
 *   produces exactly the same row — never a second money/stock movement (AC 14).
 *
 * TENANT ISOLATION:
 *   Every entry carries tenantId/branchId and flushes under the user's JWT.
 *   RLS WITH CHECK still rejects a mismatched tenant on every Supabase write,
 *   so the queue cannot bypass tenant isolation (AC 16).
 */
import {
  classifyError,
  deadCount,
  DEFAULT_RETRY_POLICY,
  discardDead,
  enqueueEntry,
  nowIso,
  onPermanentFailure,
  onSuccess,
  onTransientFailure,
  pendingCount,
  requeueDead,
  selectDrainable,
  type ConflictStrategy,
  type NewEntry,
  type OutboxEntry,
  type OutboxError,
  type OutboxOp,
  type OutboxState,
} from '@ps/core';

import { supabase } from './supabase';
import { useSync } from '../stores/useSync';
import {
  commitDiscard,
  commitEnqueue,
  commitLastSynced,
  commitPermanentFailure,
  commitRequeue,
  commitSuccess,
  commitTransientFailure,
  loadAllEntries,
} from './outboxDb';

// ─── Module-level state ───────────────────────────────────────────────────────
// The in-memory cache of the queue state mirrors SQLite exactly after each
// committed transition. A crash resets the cache; initOutbox rehydrates it.

let _state: OutboxState = { queue: [], dead: [] };
let _flushing = false;
let _initialized = false;

// ─── Internal helpers ─────────────────────────────────────────────────────────

function syncToStore(): void {
  const store = useSync.getState();
  store.setPendingCount(pendingCount(_state));
  store.setFailedCount(deadCount(_state));
}

function normalizeError(err: unknown): OutboxError {
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    const message = String(e.message ?? e.msg ?? err);
    const code = typeof e.code === 'string' ? e.code : undefined;
    const status = typeof e.status === 'number' ? e.status : undefined;
    const cls = classifyError({ code, status, message });
    return { message, code, status, class: cls };
  }
  const message = String(err);
  return { message, class: 'transient' };
}

// ─── applyEntry — thin Supabase dispatch (ALL I/O lives here) ─────────────────

async function applyEntry(entry: OutboxEntry): Promise<void> {
  const { table, op, payload, pk, conflict } = entry;
  const ignoreDuplicates = conflict === 'ignore';

  if (op === 'rpc') {
    // table = function name; payload = parameter object
    const { error } = await supabase.rpc(
      table,
      payload as Record<string, unknown>,
    );
    if (error) throw error;
    return;
  }

  if (op === 'insert') {
    const { error } = await supabase.from(table).insert(payload);
    if (error) throw error;
    return;
  }

  if (op === 'delete') {
    const payloadObj = payload as Record<string, unknown>;
    const id = payloadObj[pk];
    const { error } = await supabase.from(table).delete().eq(pk, id);
    if (error) throw error;
    return;
  }

  if (op === 'update') {
    const payloadObj = payload as Record<string, unknown>;
    const id = payloadObj[pk];
    const { error } = await supabase
      .from(table)
      .update(payloadObj)
      .eq(pk, id)
      .eq('tenant_id', entry.tenantId);
    if (error) throw error;
    return;
  }

  // op === 'upsert' (default)
  const { error } = await supabase
    .from(table)
    .upsert(payload as Record<string, unknown> | Record<string, unknown>[], {
      onConflict: pk,
      ignoreDuplicates,
    });
  if (error) throw error;
}

// ─── Drain loop ───────────────────────────────────────────────────────────────

// Set of localIds for which we have already attempted one auth refresh this drain
// cycle; prevents infinite refresh loops.
const _authRefreshed = new Set<string>();

async function drainOne(entry: OutboxEntry): Promise<void> {
  const localId = entry.localId;
  try {
    await applyEntry(entry);
    // SUCCESS
    _state = onSuccess(_state, localId);
    await commitSuccess(localId);
    const store = useSync.getState();
    const now = nowIso();
    store.setLastSyncedAt(now);
    void commitLastSynced(now);
  } catch (rawErr) {
    const outboxErr = normalizeError(rawErr);
    const cls = outboxErr.class;

    if (cls === 'auth' && !_authRefreshed.has(localId)) {
      // Attempt one session refresh then retry
      _authRefreshed.add(localId);
      try {
        const { error: refreshErr } = await supabase.auth.refreshSession();
        if (!refreshErr) {
          // Retry immediately with fresh token
          await applyEntry(entry);
          _state = onSuccess(_state, localId);
          await commitSuccess(localId);
          const store = useSync.getState();
          const now = nowIso();
          store.setLastSyncedAt(now);
          void commitLastSynced(now);
          return;
        }
      } catch {
        // Refresh itself threw — fall through to permanent failure
      }
      // Refresh failed or still getting auth error → dead-letter
      const permErr: OutboxError = { ...outboxErr, class: 'permanent' };
      _state = onPermanentFailure(_state, localId, permErr);
      // Persist all dead entries (may be cascaded dependents)
      const deadEntries = _state.dead;
      for (const d of deadEntries) {
        if (d.localId === localId || d.deadReason === 'blocked-by-dead-parent') {
          await commitPermanentFailure(d);
        }
      }
      return;
    }

    if (cls === 'permanent' || (cls === 'auth' && _authRefreshed.has(localId))) {
      const permErr: OutboxError = { ...outboxErr, class: 'permanent' };
      _state = onPermanentFailure(_state, localId, permErr);
      const deadEntries = _state.dead;
      for (const d of deadEntries) {
        if (d.deadReason === 'blocked-by-dead-parent' || d.localId === localId) {
          await commitPermanentFailure(d);
        }
      }
      return;
    }

    // transient — capture dead set before the transition so we can persist
    // ONLY the newly-dead entries (parent + cascaded dependents), never the
    // entire existing dead list (which is already persisted).
    const deadBefore = new Set(_state.dead.map((e) => e.localId));
    _state = onTransientFailure(_state, localId, outboxErr, DEFAULT_RETRY_POLICY, nowIso());
    const updated = _state.queue.find((e) => e.localId === localId);
    if (updated) {
      // Still in queue — just increment attempt count and next-attempt timestamp.
      await commitTransientFailure(updated);
    } else {
      // Reached maxAttempts: entry dead-lettered. cascadeDeadLetter in @ps/core
      // may also have moved transitive dependents to dead. Persist every entry
      // that is newly in the dead list so they surface in the UI and rehydrate
      // correctly after a crash (not just the direct parent — AC 20 cascade).
      for (const dead of _state.dead) {
        if (!deadBefore.has(dead.localId)) {
          await commitPermanentFailure(dead);
        }
      }
    }
  }
}

export async function runDrain(): Promise<void> {
  if (_flushing) return; // single-flight guard (AC 20)
  if (!useSync.getState().online) return; // no-op offline (AC 17)

  _flushing = true;
  useSync.getState().setSyncing(true);
  _authRefreshed.clear();

  try {
    // Drain until nothing is eligible (handles newly unblocked dependents)
    for (let pass = 0; pass < 200; pass++) {
      const drainable = selectDrainable(_state, nowIso());
      if (drainable.length === 0) break;
      for (const entry of drainable) {
        await drainOne(entry);
        syncToStore();
      }
    }
  } finally {
    _flushing = false;
    useSync.getState().setSyncing(false);
  }
}

export function triggerDrain(): void {
  void runDrain();
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function initOutbox(): Promise<void> {
  if (_initialized) return;
  _initialized = true;
  const { state, lastSyncedAt } = await loadAllEntries();
  _state = state;
  const store = useSync.getState();
  store.setPendingCount(pendingCount(_state));
  store.setFailedCount(deadCount(_state));
  store.setLastSyncedAt(lastSyncedAt);
}

export interface PersistRowInput {
  /** Dedupe identity — client uuidv4 or deterministic uuidv5 key. */
  localId: string;
  tenantId: string;
  branchId: string | null;
  table: string;
  op: OutboxOp;
  payload: Record<string, unknown> | Record<string, unknown>[];
  /** Primary-key column, default 'id'. */
  pk?: string;
  /** 'merge' (default) or 'ignore' for append-only ledger rows. */
  conflict?: ConflictStrategy;
  /** localIds that must succeed before this entry is eligible. */
  dependsOn?: string[];
}

/**
 * Durably enqueue a write. AWAITS the SQLite commit before returning so the
 * caller can treat the action as accepted. Fire-and-forget drain follows.
 * (ADR-0009 Q1 / AC 7 — "enqueue must be committed before UI accepts action")
 */
export async function persistRow(input: PersistRowInput): Promise<void> {
  const now = nowIso();
  const newEntry: NewEntry = {
    localId: input.localId,
    tenantId: input.tenantId,
    branchId: input.branchId,
    table: input.table,
    op: input.op,
    payload: input.payload,
    pk: input.pk ?? 'id',
    conflict: input.conflict ?? 'merge',
    dependsOn: input.dependsOn ?? [],
  };

  // Pure idempotent enqueue (collapses a re-enqueue of same localId)
  _state = enqueueEntry(_state, newEntry, now);

  // Find the entry we just added/refreshed to persist it
  const entry = _state.queue.find((e) => e.localId === input.localId);
  if (!entry) return; // was in dead list (quarantined) — operator must retry

  // DURABILITY: commit to SQLite BEFORE returning (AC 7)
  await commitEnqueue(entry);

  syncToStore();

  // Fire-and-forget drain (does not block the caller)
  triggerDrain();
}

export function getOutboxState(): { pending: OutboxEntry[]; failed: OutboxEntry[] } {
  return { pending: [..._state.queue], failed: [..._state.dead] };
}

export async function retryDeadEntries(localId: string | 'all'): Promise<void> {
  const now = nowIso();
  const before = _state;
  _state = requeueDead(_state, localId, now);
  // Find newly requeued entries (in queue now but were in dead)
  const requeued = _state.queue.filter(
    (e) => !before.queue.some((b) => b.localId === e.localId),
  );
  if (requeued.length > 0) {
    await commitRequeue(requeued);
    syncToStore();
    triggerDrain();
  }
}

export async function discardDeadEntries(localId: string | 'all'): Promise<void> {
  const before = _state.dead.map((e) => e.localId);
  _state = discardDead(_state, localId);
  const discarded = before.filter(
    (id) => !_state.dead.some((e) => e.localId === id),
  );
  if (discarded.length > 0) {
    await commitDiscard(discarded);
    syncToStore();
  }
}
