/**
 * OfflineBanner — design system §9.9.
 * Persistent at top of screen when offline.
 * Shows pending write count. Never a cross-origin reachability probe.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { colors, spacing } from '../design/tokens';
import { AppText } from './AppText';
import { useSync } from '../stores/useSync';

export function OfflineBanner() {
  const { online, pendingCount } = useSync();
  const { t } = useTranslation();

  if (online) return null;

  return (
    <View style={styles.banner} accessibilityRole="alert" accessible>
      <AppText role="label" color="#FFFFFF">
        {pendingCount > 0
          ? t('offline.queued', { count: pendingCount })
          : t('sync.offline')}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: colors.warning,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    alignItems: 'center',
  },
});
