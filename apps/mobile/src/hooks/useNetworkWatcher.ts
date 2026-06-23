/**
 * useNetworkWatcher — monitors online state WITHOUT cross-origin probes.
 * Uses AppState (foreground/background) + Platform.OS checks.
 * Triggers outbox flush on reconnect.
 * (mobile-patterns.md — never use cross-origin reachability check)
 */
import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';

import { useSync } from '../stores/useSync';

export function useNetworkWatcher(): void {
  const { setOnline } = useSync();

  useEffect(() => {
    let mounted = true;

    // Web: listen to online/offline events
    const handleOnline = () => mounted && setOnline(true);
    const handleOffline = () => mounted && setOnline(false);

    if (Platform.OS === 'web') {
      window.addEventListener('online', handleOnline);
      window.addEventListener('offline', handleOffline);
    }

    // AppState: when app comes to foreground, assume connectivity (optimistic)
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && mounted) {
        setOnline(true);
      }
    });

    return () => {
      mounted = false;
      if (Platform.OS === 'web') {
        window.removeEventListener('online', handleOnline);
        window.removeEventListener('offline', handleOffline);
      }
      subscription.remove();
    };
  }, [setOnline]);
}
