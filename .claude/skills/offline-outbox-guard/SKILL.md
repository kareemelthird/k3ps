---
name: offline-outbox-guard
description: Verify the offline write queue is crash-safe and never double-counts money. Use when changing apps/mobile sync code (outbox, mutations, network watcher, realtime) or any write path. Checks idempotency, dead-letter handling, and queue-drain safety.
allowed-tools: Read, Grep, Glob, Bash
---

# offline-outbox-guard

A cash business cannot tolerate lost or duplicated writes. The trial's outbox (`docs/reference/mobile-patterns.md`) is the model. These invariants must hold in `apps/mobile`.

## Invariants
1. **Client-generated id + upsert.** Every queued write carries a client `uuidv4()` and is sent as an **upsert** (not insert), so a replay after a crash mid-flush is idempotent (no duplicate-key error, no double row).
2. **Stamp before queueing.** `updated_at: nowIso()` is set when enqueued so last-write-wins is meaningful before the server trigger fires.
3. **Dead-letter, don't block.** After `MAX_ATTEMPTS` (5) failures an entry moves to a dead list and the drain **continues** — one poison write must never stall the queue. `attempts`/`lastError` are retained for the Sync screen (retry/discard).
4. **Durable persistence.** Queue + dead list persist to versioned AsyncStorage keys; the in-memory cache and storage stay consistent; pending count rehydrates on app start.
5. **No double money.** Closing a session / recording a sale / collecting a debt enqueues exactly once; optimistic cache updates reconcile with `onSettled` invalidation; replays don't re-add stock movements or re-charge.
6. **Connectivity is local.** Online detection uses `navigator.onLine` / AppState / web online-offline events — **never** a cross-origin reachability probe (CORS would wedge the app offline). Flush on reconnect + interval + foreground.
7. **Tenancy.** Every queued row carries `tenant_id`/`branch_id`; a flush never writes into the wrong tenant.

## How to run
- Read the changed sync files; check each invariant.
- Confirm tests exist for: replay-after-crash idempotency, poison entry → dead-letter after 5 attempts while the queue keeps draining, and that a voided sale reverses exactly one stock movement.
```
npm --workspace apps/mobile test
```

## Output
A checklist (each invariant → PASS/FAIL with evidence) and any missing test. Idempotency or double-count failures are blockers.
