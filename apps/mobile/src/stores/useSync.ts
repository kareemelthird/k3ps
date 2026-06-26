/**
 * Sync store — tracks online state, pending outbox count, failed writes,
 * last-synced timestamp, and the 4-state sync chip selector.
 *
 * Connectivity detection uses AppState + NetInfo events, never a cross-origin
 * reachability probe (CORS would break the app when offline).
 *
 * Phase 8: adds lastSyncedAt + setLastSyncedAt, and the syncState selector
 * (derives the four chip states: attention > offline > syncing > synced).
 */
import { create } from 'zustand';

/** The four sync states displayed by SyncStatusChip (§3.1 of the design spec). */
export type ChipSyncState = 'synced' | 'syncing' | 'offline' | 'attention';

export interface SyncState {
  online: boolean;
  syncing: boolean;
  pendingCount: number;
  failedCount: number;
  /** ISO string of the most recent successful outbox flush, or null if never. */
  lastSyncedAt: string | null;

  setOnline: (online: boolean) => void;
  setSyncing: (syncing: boolean) => void;
  setPendingCount: (count: number) => void;
  setFailedCount: (count: number) => void;
  setLastSyncedAt: (iso: string | null) => void;
}

export const useSync = create<SyncState>((set, get) => ({
  online: true,
  syncing: false,
  pendingCount: 0,
  failedCount: 0,
  lastSyncedAt: null,

  setOnline: (online) => set({ online }),
  setSyncing: (syncing) => set({ syncing }),
  setPendingCount: (pendingCount) => set({ pendingCount }),
  setFailedCount: (failedCount) => set({ failedCount }),
  setLastSyncedAt: (lastSyncedAt) => set({ lastSyncedAt }),

  // Kept as a regular method (not in the interface above) so callers can read
  // it via the store. Added to prototype for convenience.
}));

/**
 * Pure selector: derives the 4-state chip value from the Zustand store.
 * Precedence: attention (failed>0) > offline (!online) > syncing > synced.
 * Called by SyncStatusChip; also exported for use in the shift-close gate.
 */
export function selectSyncState(s: Pick<SyncState, 'online' | 'syncing' | 'pendingCount' | 'failedCount'>): ChipSyncState {
  if (s.failedCount > 0) return 'attention';
  if (!s.online) return 'offline';
  if (s.syncing || s.pendingCount > 0) return 'syncing';
  return 'synced';
}
