/**
 * Sync store — tracks online state, pending outbox count, and failed writes.
 * Connectivity detection uses AppState + NetInfo events, never a cross-origin
 * reachability probe (CORS would break the app when offline).
 */
import { create } from 'zustand';

export interface SyncState {
  online: boolean;
  syncing: boolean;
  pendingCount: number;
  failedCount: number;

  setOnline: (online: boolean) => void;
  setSyncing: (syncing: boolean) => void;
  setPendingCount: (count: number) => void;
  setFailedCount: (count: number) => void;
}

export const useSync = create<SyncState>((set) => ({
  online: true,
  syncing: false,
  pendingCount: 0,
  failedCount: 0,

  setOnline: (online) => set({ online }),
  setSyncing: (syncing) => set({ syncing }),
  setPendingCount: (pendingCount) => set({ pendingCount }),
  setFailedCount: (failedCount) => set({ failedCount }),
}));
