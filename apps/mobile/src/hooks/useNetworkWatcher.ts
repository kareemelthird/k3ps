/**
 * useNetworkWatcher — monitors online state WITHOUT cross-origin probes.
 * Uses expo-network (native), AppState (foreground/background), and web events.
 *
 * Triggers outbox drain on reconnect and on app-foreground (AC 18).
 * Interval drain every 30s while online to catch any stale pending entries.
 *
 * HARD RULE (CLAUDE.md §2 / AC 19): connectivity detection NEVER makes a
 * cross-origin reachability probe (CORS would falsely wedge the app offline).
 * Detection is purely local:
 *   native — expo-network Network.addNetworkStateListener /
 *             Network.getNetworkStateAsync (isConnected && isInternetReachable)
 *   web    — navigator.onLine + window online/offline events (fallback)
 *   both   — AppState foreground trigger + 30s interval
 */
import { useEffect, useRef } from 'react';
import { AppState, AppStateStatus, Platform } from 'react-native';
import * as Network from 'expo-network';

import { useSync } from '../stores/useSync';
import { triggerDrain } from '../lib/outboxAdapter';

const DRAIN_INTERVAL_MS = 30_000;

/** Convert expo-network NetworkState to a boolean (true = appears online). */
function networkStateToOnline(state: Network.NetworkState): boolean {
  // isInternetReachable may be null (undetermined); treat null as online to
  // avoid falsely wedging the queue. A real offline will fail quickly.
  return Boolean(state.isConnected && state.isInternetReachable !== false);
}

export function useNetworkWatcher(): void {
  const { setOnline, online } = useSync();
  // Keep a ref to the current online value so the interval callback is fresh
  const onlineRef = useRef(online);
  onlineRef.current = online;

  useEffect(() => {
    let mounted = true;

    // ── Web: listen to browser online/offline events ──
    const handleOnline = () => {
      if (!mounted) return;
      setOnline(true);
      triggerDrain(); // auto-drain on reconnect (AC 18)
    };
    const handleOffline = () => {
      if (!mounted) return;
      setOnline(false);
    };

    // ── Native: expo-network real connectivity detection (SHOULD-FIX 5) ──
    // Replaces the "optimistic setOnline(true) on foreground" approach which
    // missed real offline states on device. expo-network requires no extra
    // native config — bundled with expo SDK 53 (no CORS risk).
    let networkSubscription: { remove: () => void } | null = null;

    if (Platform.OS !== 'web') {
      // Seed initial state asynchronously (non-blocking).
      void Network.getNetworkStateAsync().then((state) => {
        if (mounted) {
          const isOnline = networkStateToOnline(state);
          setOnline(isOnline);
          if (isOnline) triggerDrain();
        }
      });

      // Real-time updates — fires whenever connectivity changes on device.
      networkSubscription = Network.addNetworkStateListener((state) => {
        if (!mounted) return;
        const isOnline = networkStateToOnline(state);
        setOnline(isOnline);
        if (isOnline) triggerDrain();
      });
    } else {
      // Web: initial state from browser
      setOnline(typeof window !== 'undefined' ? window.navigator.onLine : true);
      if (typeof window !== 'undefined') {
        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);
      }
    }

    // ── AppState: flush on foreground (AC 18 — foreground trigger) ──
    const appStateHandler = (state: AppStateStatus) => {
      if (!mounted) return;
      if (state === 'active') {
        // On native, expo-network provides the real connectivity state so we
        // don't optimistically force-online here. On web, assume reachable on
        // foreground (same as before — no native Network available).
        if (Platform.OS === 'web') {
          setOnline(true);
        }
        triggerDrain();
      }
    };
    const subscription = AppState.addEventListener('change', appStateHandler);

    // ── Interval: background drain every 30s while online ──
    const interval = setInterval(() => {
      if (onlineRef.current) triggerDrain();
    }, DRAIN_INTERVAL_MS);

    return () => {
      mounted = false;
      networkSubscription?.remove();
      subscription.remove();
      clearInterval(interval);
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.removeEventListener('online', handleOnline);
        window.removeEventListener('offline', handleOffline);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setOnline]);
}
