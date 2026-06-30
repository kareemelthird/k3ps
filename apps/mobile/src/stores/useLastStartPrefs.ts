/**
 * useLastStartPrefs — persists the manager's last-used billing+play mode
 * across app restarts so the "Quick Start" button can fire without a sheet.
 *
 * Uses @react-native-async-storage/async-storage (already in deps).
 * All I/O is best-effort; failures degrade gracefully to "no saved pref".
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { BillingMode, PlayMode } from '@ps/core';

const KEY = '@ps.lastStartPrefs.v1';

export interface StartPrefs {
  billingMode: BillingMode;
  playMode: PlayMode;
}

export async function loadStartPrefs(): Promise<StartPrefs | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    return JSON.parse(raw) as StartPrefs;
  } catch {
    return null;
  }
}

export async function saveStartPrefs(prefs: StartPrefs): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // best-effort — if storage fails the fallback is "no saved pref"
  }
}
