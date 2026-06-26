/**
 * OfflineBanner — design system §9.9.
 * Persistent at top of screen when offline.
 * Never a cross-origin reachability probe (AppState / NetInfo only).
 *
 * Phase 8: shows pending-count when > 0; tap opens SyncCenterSheet.
 * RTL: text centred; icon on start side.
 */
import React, { useState } from 'react';
import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { colors, spacing } from '../design/tokens';
import { AppText } from './AppText';
import { Icon } from './Icon';
import { useSync } from '../stores/useSync';
import { SyncCenterSheet } from './SyncCenterSheet';

export function OfflineBanner() {
  const { online, pendingCount } = useSync();
  const { t } = useTranslation();
  const [sheetOpen, setSheetOpen] = useState(false);

  if (online) return null;

  return (
    <>
      <TouchableOpacity
        style={styles.banner}
        onPress={() => setSheetOpen(true)}
        activeOpacity={0.85}
        accessibilityRole="alert"
        accessible
        accessibilityLabel={
          pendingCount > 0
            ? t('sync.offline.pendingLabel', { count: pendingCount })
            : t('sync.chip.offline')
        }
      >
        <View style={styles.row}>
          <Icon name="cloud-offline-outline" size={16} color="#FFFFFF" />
          <AppText role="label" color="#FFFFFF">
            {t('sync.chip.offline')}
          </AppText>
          {pendingCount > 0 && (
            <AppText role="micro" color="#FFFFFF">
              {t('sync.offline.pendingCount', { count: pendingCount })}
            </AppText>
          )}
        </View>
      </TouchableOpacity>
      <SyncCenterSheet visible={sheetOpen} onClose={() => setSheetOpen(false)} />
    </>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: colors.warning,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
  },
});
