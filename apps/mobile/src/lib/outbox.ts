/**
 * Offline outbox — Phase 8 durable write queue.
 *
 * Public re-export of the outboxAdapter. Feature mutations call persistRow
 * instead of writing directly to Supabase. The adapter:
 *   1. Enqueues the entry (pure @ps/core/outbox state machine)
 *   2. Persists it to expo-sqlite (ACID, crash-safe — ADR-0009 §Q1)
 *   3. Fire-and-forget drains the queue against Supabase when online
 *
 * Idempotency (CLAUDE.md §2.8): every entry carries a client UUID or
 * deterministic uuidv5 key; the adapter upserts with per-entity conflict
 * strategy ('merge' or 'ignore'). A replay is always a no-op.
 *
 * Tenancy (CLAUDE.md §5): every entry carries tenant_id/branch_id and flushes
 * under the user's JWT — RLS WITH CHECK still rejects cross-tenant writes.
 */
export {
  type PersistRowInput,
  discardDeadEntries,
  getOutboxState,
  initOutbox,
  persistRow,
  retryDeadEntries,
  triggerDrain,
} from './outboxAdapter';
