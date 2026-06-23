/**
 * OfflineBanner — design system §9.9.
 * Persistent at top of screen when offline.
 * Never a cross-origin reachability probe (AppState / NetInfo only).
 *
 * Phase 3: outbox deferred to Phase 8. Pending-count wiring removed — nothing
 * calls enqueue so the count is always 0; show a simple offline indicator only.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { colors, spacing } from '../design/tokens';
import { AppText } from './AppText';
import { useSync } from '../stores/useSync';

export function OfflineBanner() {
  const { online } = useSync();
  const { t } = useTranslation();

  if (online) return null;

  return (
    <View style={styles.banner} accessibilityRole="alert" accessible>
      <AppText role="label" color="#FFFFFF">
        {t('sync.offline')}
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
