/**
 * outboxDb — expo-sqlite durable persistence for the write-outbox (ADR-0009 §Q1).
 *
 * Persistence guarantee (the durability contract):
 *   - One SQLite transaction per state transition (enqueue / success / failure /
 *     dead-letter / requeue / discard / last-synced).
 *   - A committed transaction survives a force-kill and device restart (SQLite
 *     WAL journal, ACID). A crash DURING a write rolls back to the last consistent
 *     state — no torn queue, no partially-written entry (AC 9 of spec).
 *   - On web (where expo-sqlite is unavailable): falls back to an in-memory store
 *     so the codebase compiles and expo export succeeds; writes are not durable
 *     across tab-close on web (web stays online-only per spec §3 out-of-scope).
 *
 * Schema v1 — 'outbox.db':
 *   entries(local_id TEXT PK, status TEXT, tenant_id, branch_id, tbl, op, payload,
 *           pk_col, conflict_strategy, depends_on, attempts, last_error,
 *           next_attempt_at, dead_reason, created_at, updated_at)
 *   meta(key TEXT PK, value TEXT)   — e.g. key='last_synced_at'
 *
 * PURITY: this file owns I/O only. All outbox decisions (retry, dead-letter,
 * dependency ordering) live in @ps/core/outbox (pure, testable, no I/O).
 */
import { Platform } from 'react-native';
import type {
  OutboxEntry,
  OutboxError,
  OutboxState,
} from '@ps/core';

// ─── Web/native split ─────────────────────────────────────────────────────────
// expo-sqlite is a native module; it is not available in the browser.
// On web we expose the same interface backed by an in-memory map so the rest of
// the adapter code needs no branching.

let _impl: DbImpl;

interface DbImpl {
  init(): Promise<void>;
  loadAll(): Promise<{ state: OutboxState; lastSyncedAt: string | null }>;
  commitEnqueue(entry: OutboxEntry): Promise<void>;
  commitSuccess(localId: string): Promise<void>;
  commitTransientFailure(entry: OutboxEntry): Promise<void>;
  commitPermanentFailure(entry: OutboxEntry): Promise<void>;
  commitRequeue(entries: OutboxEntry[]): Promise<void>;
  commitDiscard(localIds: string[]): Promise<void>;
  commitLastSynced(isoStr: string): Promise<void>;
}

// ─── Serialization helpers ────────────────────────────────────────────────────

function entryToRow(e: OutboxEntry): Record<string, string | number | null> {
  return {
    local_id: e.localId,
    status: e.deadReason != null ? 'dead' : 'pending',
    tenant_id: e.tenantId,
    branch_id: e.branchId ?? null,
    tbl: e.table,
    op: e.op,
    payload: JSON.stringify(e.payload),
    pk_col: e.pk,
    conflict_strategy: e.conflict,
    depends_on: JSON.stringify(e.dependsOn),
    attempts: e.attempts,
    last_error: e.lastError != null ? JSON.stringify(e.lastError) : null,
    next_attempt_at: e.nextAttemptAt ?? null,
    dead_reason: e.deadReason ?? null,
    created_at: e.createdAt,
    updated_at: e.updatedAt,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToEntry(row: Record<string, any>): OutboxEntry {
  return {
    localId: row.local_id as string,
    tenantId: row.tenant_id as string,
    branchId: (row.branch_id as string | null) ?? null,
    table: row.tbl as string,
    op: row.op as OutboxEntry['op'],
    payload: JSON.parse(row.payload as string) as OutboxEntry['payload'],
    pk: row.pk_col as string,
    conflict: row.conflict_strategy as OutboxEntry['conflict'],
    dependsOn: JSON.parse(row.depends_on as string) as string[],
    attempts: row.attempts as number,
    lastError: row.last_error != null
      ? (JSON.parse(row.last_error as string) as OutboxError)
      : undefined,
    nextAttemptAt: (row.next_attempt_at as string | null) ?? undefined,
    deadReason: (row.dead_reason as OutboxEntry['deadReason']) ?? undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

// ─── Native (expo-sqlite) implementation ─────────────────────────────────────

async function buildNativeImpl(): Promise<DbImpl> {
  // Dynamic import so the web bundle never tries to evaluate expo-sqlite
  const SQLite = await import('expo-sqlite');

  let db: Awaited<ReturnType<typeof SQLite.openDatabaseAsync>>;

  const SCHEMA = `
    CREATE TABLE IF NOT EXISTS entries (
      local_id        TEXT PRIMARY KEY,
      status          TEXT NOT NULL DEFAULT 'pending',
      tenant_id       TEXT NOT NULL,
      branch_id       TEXT,
      tbl             TEXT NOT NULL,
      op              TEXT NOT NULL,
      payload         TEXT NOT NULL,
      pk_col          TEXT NOT NULL DEFAULT 'id',
      conflict_strategy TEXT NOT NULL DEFAULT 'merge',
      depends_on      TEXT NOT NULL DEFAULT '[]',
      attempts        INTEGER NOT NULL DEFAULT 0,
      last_error      TEXT,
      next_attempt_at TEXT,
      dead_reason     TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `;

  return {
    async init() {
      db = await SQLite.openDatabaseAsync('ps_outbox_v1.db');
      await db.execAsync(SCHEMA);
    },

    async loadAll() {
      const rows = await db.getAllAsync<Record<string, unknown>>(
        'SELECT * FROM entries ORDER BY created_at ASC',
      );
      const queue: OutboxEntry[] = [];
      const dead: OutboxEntry[] = [];
      for (const row of rows) {
        try {
          const entry = rowToEntry(row);
          if (row.status === 'dead') dead.push(entry);
          else queue.push(entry);
        } catch {
          // Defensive: skip corrupt rows, never abort load (AC 9)
        }
      }

      const metaRow = await db.getFirstAsync<{ value: string | null }>(
        "SELECT value FROM meta WHERE key = 'last_synced_at'",
      );
      return { state: { queue, dead }, lastSyncedAt: metaRow?.value ?? null };
    },

    async commitEnqueue(entry) {
      const r = entryToRow(entry);
      await db.withExclusiveTransactionAsync(async (tx) => {
        await tx.runAsync(
          `INSERT OR REPLACE INTO entries
             (local_id, status, tenant_id, branch_id, tbl, op, payload, pk_col,
              conflict_strategy, depends_on, attempts, last_error, next_attempt_at,
              dead_reason, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            r.local_id, r.status, r.tenant_id, r.branch_id, r.tbl, r.op,
            r.payload, r.pk_col, r.conflict_strategy, r.depends_on, r.attempts,
            r.last_error, r.next_attempt_at, r.dead_reason, r.created_at, r.updated_at,
          ],
        );
      });
    },

    async commitSuccess(localId) {
      await db.withExclusiveTransactionAsync(async (tx) => {
        await tx.runAsync('DELETE FROM entries WHERE local_id = ?', [localId]);
      });
    },

    async commitTransientFailure(entry) {
      const r = entryToRow(entry);
      await db.withExclusiveTransactionAsync(async (tx) => {
        await tx.runAsync(
          `UPDATE entries SET attempts=?, last_error=?, next_attempt_at=?, updated_at=?
           WHERE local_id=?`,
          [r.attempts, r.last_error, r.next_attempt_at, r.updated_at, r.local_id],
        );
      });
    },

    async commitPermanentFailure(entry) {
      const r = entryToRow(entry);
      // Move to dead (may be a group cascade)
      await db.withExclusiveTransactionAsync(async (tx) => {
        await tx.runAsync(
          `UPDATE entries SET status='dead', last_error=?, dead_reason=?, updated_at=?
           WHERE local_id=?`,
          [r.last_error, r.dead_reason, r.updated_at, r.local_id],
        );
      });
    },

    async commitRequeue(entries) {
      if (entries.length === 0) return;
      await db.withExclusiveTransactionAsync(async (tx) => {
        for (const entry of entries) {
          await tx.runAsync(
            `UPDATE entries SET status='pending', attempts=0, last_error=NULL,
             next_attempt_at=NULL, dead_reason=NULL, updated_at=?
             WHERE local_id=?`,
            [entry.updatedAt, entry.localId],
          );
        }
      });
    },

    async commitDiscard(localIds) {
      if (localIds.length === 0) return;
      const placeholders = localIds.map(() => '?').join(',');
      await db.withExclusiveTransactionAsync(async (tx) => {
        await tx.runAsync(
          `DELETE FROM entries WHERE local_id IN (${placeholders})`,
          localIds,
        );
      });
    },

    async commitLastSynced(isoStr) {
      await db.withExclusiveTransactionAsync(async (tx) => {
        await tx.runAsync(
          `INSERT OR REPLACE INTO meta (key, value) VALUES ('last_synced_at', ?)`,
          [isoStr],
        );
      });
    },
  };
}

// ─── Web fallback (in-memory) ─────────────────────────────────────────────────

function buildWebImpl(): DbImpl {
  const _mem: OutboxState = { queue: [], dead: [] };
  let _lastSynced: string | null = null;

  const find = (localId: string) =>
    _mem.queue.findIndex((e) => e.localId === localId);
  const findDead = (localId: string) =>
    _mem.dead.findIndex((e) => e.localId === localId);

  return {
    async init() {},
    async loadAll() {
      return { state: { queue: [..._mem.queue], dead: [..._mem.dead] }, lastSyncedAt: _lastSynced };
    },
    async commitEnqueue(entry) {
      const idx = find(entry.localId);
      if (idx >= 0) _mem.queue[idx] = entry;
      else _mem.queue.push(entry);
    },
    async commitSuccess(localId) {
      const idx = find(localId);
      if (idx >= 0) _mem.queue.splice(idx, 1);
    },
    async commitTransientFailure(entry) {
      const idx = find(entry.localId);
      if (idx >= 0) _mem.queue[idx] = entry;
    },
    async commitPermanentFailure(entry) {
      const qIdx = find(entry.localId);
      if (qIdx >= 0) _mem.queue.splice(qIdx, 1);
      const dIdx = findDead(entry.localId);
      if (dIdx >= 0) _mem.dead[dIdx] = entry;
      else _mem.dead.push(entry);
    },
    async commitRequeue(entries) {
      for (const e of entries) {
        const dIdx = findDead(e.localId);
        if (dIdx >= 0) _mem.dead.splice(dIdx, 1);
        _mem.queue.push(e);
      }
    },
    async commitDiscard(localIds) {
      const s = new Set(localIds);
      _mem.dead = _mem.dead.filter((e) => !s.has(e.localId));
    },
    async commitLastSynced(isoStr) {
      _lastSynced = isoStr;
    },
  };
}

// ─── Public facade ────────────────────────────────────────────────────────────

let _ready = false;

export async function initDb(): Promise<void> {
  if (_ready) return;
  if (Platform.OS === 'web') {
    _impl = buildWebImpl();
  } else {
    try {
      _impl = await buildNativeImpl();
    } catch {
      // Native module unavailable (e.g. Expo Go without dev-client) — fall back
      _impl = buildWebImpl();
    }
  }
  await _impl.init();
  _ready = true;
}

export async function loadAllEntries(): Promise<{
  state: OutboxState;
  lastSyncedAt: string | null;
}> {
  await initDb();
  return _impl.loadAll();
}

export async function commitEnqueue(entry: OutboxEntry): Promise<void> {
  await initDb();
  return _impl.commitEnqueue(entry);
}

export async function commitSuccess(localId: string): Promise<void> {
  await initDb();
  return _impl.commitSuccess(localId);
}

export async function commitTransientFailure(entry: OutboxEntry): Promise<void> {
  await initDb();
  return _impl.commitTransientFailure(entry);
}

export async function commitPermanentFailure(entry: OutboxEntry): Promise<void> {
  await initDb();
  return _impl.commitPermanentFailure(entry);
}

export async function commitRequeue(entries: OutboxEntry[]): Promise<void> {
  await initDb();
  return _impl.commitRequeue(entries);
}

export async function commitDiscard(localIds: string[]): Promise<void> {
  await initDb();
  return _impl.commitDiscard(localIds);
}

export async function commitLastSynced(isoStr: string): Promise<void> {
  await initDb();
  return _impl.commitLastSynced(isoStr);
}
