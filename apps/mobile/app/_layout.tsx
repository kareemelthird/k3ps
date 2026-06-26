/**
 * Root layout — boot sequence:
 * 1. Force RTL (Arabic-first — mobile-patterns.md)
 * 2. Init i18n
 * 3. Restore Supabase session + active branch
 * 4. Listen to auth state changes (onAuthStateChange)
 * Route by auth state and role.
 */
import '../src/i18n'; // side-effect: initialises i18next
import React, { useEffect } from 'react';
import { I18nManager, View } from 'react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';

import { supabase } from '../src/lib/supabase';
import { queryClient } from '../src/lib/queryClient';
import { useAuth } from '../src/stores/useAuth';
import { useNetworkWatcher } from '../src/hooks/useNetworkWatcher';
import { initOutbox } from '../src/lib/outbox';
import { colors } from '../src/design/tokens';

// Force RTL at the earliest possible moment (CLAUDE.md §6, mobile-patterns.md)
I18nManager.allowRTL(true);
I18nManager.forceRTL(true);

// Keep the splash screen visible while we initialize
SplashScreen.preventAutoHideAsync().catch(() => {});

function RootLayoutInner() {
  const { setSession, restoreActiveBranch, isReady } = useAuth();

  useNetworkWatcher();

  useEffect(() => {
    // Boot the outbox (rehydrate from SQLite, sync Zustand counts).
    // Must run before any mutation can be enqueued (AC 7).
    void initOutbox();

    // Restore persisted branch selection
    void restoreActiveBranch();

    // Get current session (restore persisted session)
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
    }).catch(() => {
      setSession(null);
    });

    // Listen to future auth state changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setSession(session);
      },
    );

    return () => subscription.unsubscribe();
  }, [setSession, restoreActiveBranch]);

  useEffect(() => {
    if (isReady) {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [isReady]);

  if (!isReady) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }} />
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(operate)" />
      <Stack.Screen name="index" />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <RootLayoutInner />
    </QueryClientProvider>
  );
}
