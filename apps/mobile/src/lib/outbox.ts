/**
 * Offline outbox — idempotent client-UUID + upsert writes that survive app
 * crashes and network loss. (mobile-patterns.md, offline-outbox-guard)
 *
 * Invariants:
 * 1. Client-generated id + upsert — replays are idempotent.
 * 2. stamp updated_at before queueing (last-write-wins).
 * 3. Dead-letter after MAX_ATTEMPTS — queue keeps draining.
 * 4. Queue + dead list persisted to versioned AsyncStorage keys.
 * 5. No double money — one enqueue per action; idempotent on retry.
 * 6. Every row carries tenant_id / branch_id.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { nowIso, uuidv4 } from '@ps/core';

const QUEUE_KEY = 'ps.outbox.v1';
const DEAD_KEY = 'ps.outbox.dead.v1';
const MAX_ATTEMPTS = 5;

export type OutboxOp = 'upsert' | 'update' | 'delete';

export interface OutboxEntry {
  localId: string;
  table: string;
  op: OutboxOp;
  /** Row data — must include id (for upsert/update) and tenant_id. */
  row: Record<string, unknown>;
  attempts: number;
  lastError: string | null;
  enqueuedAt: string;
}

// In-memory cache
let _queue: OutboxEntry[] = [];
let _dead: OutboxEntry[] = [];
let _loaded = false;

async function load(): Promise<void> {
  if (_loaded) return;
  try {
    const [q, d] = await Promise.all([
      AsyncStorage.getItem(QUEUE_KEY),
      AsyncStorage.getItem(DEAD_KEY),
    ]);
    _queue = q ? (JSON.parse(q) as OutboxEntry[]) : [];
    _dead = d ? (JSON.parse(d) as OutboxEntry[]) : [];
  } catch {
    _queue = [];
    _dead = [];
  }
  _loaded = true;
}

async function persist(): Promise<void> {
  await Promise.all([
    AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(_queue)),
    AsyncStorage.setItem(DEAD_KEY, JSON.stringify(_dead)),
  ]);
}

export async function enqueue(
  table: string,
  op: OutboxOp,
  row: Record<string, unknown>,
): Promise<OutboxEntry> {
  await load();
  const entry: OutboxEntry = {
    localId: uuidv4(),
    table,
    op,
    row: { ...row, updated_at: nowIso() },
    attempts: 0,
    lastError: null,
    enqueuedAt: nowIso(),
  };
  _queue.push(entry);
  await persist();
  return entry;
}

export async function pendingCount(): Promise<number> {
  await load();
  return _queue.length;
}

export async function getPending(): Promise<OutboxEntry[]> {
  await load();
  return [..._queue];
}

export async function getDeadLetter(): Promise<OutboxEntry[]> {
  await load();
  return [..._dead];
}

/**
 * Flush the queue against the provided executor.
 * Entries that fail MAX_ATTEMPTS times move to dead-letter; the drain continues.
 */
export async function flushOutbox(
  executor: (entry: OutboxEntry) => Promise<void>,
): Promise<{ flushed: number; remaining: number; dead: number }> {
  await load();
  let flushed = 0;
  const remaining: OutboxEntry[] = [];

  for (const entry of _queue) {
    try {
      await executor(entry);
      flushed++;
      // success — do not push back
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      entry.attempts++;
      entry.lastError = errorMsg;
      if (entry.attempts >= MAX_ATTEMPTS) {
        _dead.push(entry);
        // Intentionally NOT pushing to remaining — drain continues
      } else {
        remaining.push(entry);
      }
    }
  }

  _queue = remaining;
  await persist();

  return { flushed, remaining: _queue.length, dead: _dead.length };
}

export async function retryDeadLetter(localId?: string): Promise<void> {
  await load();
  if (localId) {
    const idx = _dead.findIndex((e) => e.localId === localId);
    if (idx !== -1) {
      const entry = _dead.splice(idx, 1)[0];
      if (entry) {
        entry.attempts = 0;
        entry.lastError = null;
        _queue.push(entry);
      }
    }
  } else {
    const revived = _dead.map((e) => ({ ...e, attempts: 0, lastError: null }));
    _queue.push(...revived);
    _dead = [];
  }
  await persist();
}

export async function discardDeadLetter(localId?: string): Promise<void> {
  await load();
  if (localId) {
    _dead = _dead.filter((e) => e.localId !== localId);
  } else {
    _dead = [];
  }
  await persist();
}
