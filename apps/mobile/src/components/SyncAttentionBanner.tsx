/**
 * SyncAttentionBanner — dead-letter alarm (design spec §3.3 / §9.14.3).
 *
 * Shown ONLY when failedCount > 0 (entries in the dead-letter queue).
 * Danger tint background, static (no pulse), tap opens SyncCenterSheet.
 * Positioned below OfflineBanner (stacked banners).
 *
 * RTL: start/end padding; icon on start side.
 * All strings from i18n.
 */
import React from 'react';
import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { toArabicDigits } from '@ps/core';

import { colors, spacing } from '../design/tokens';
import { AppText } from './AppText';
import { Icon } from './Icon';
import { useSync } from '../stores/useSync';

interface SyncAttentionBannerProps {
  onPress?: () => void;
}

export function SyncAttentionBanner({ onPress }: SyncAttentionBannerProps) {
  const { t } = useTranslation();
  const { failedCount } = useSync();

  if (failedCount === 0) return null;

  return (
    <TouchableOpacity
      style={styles.banner}
      onPress={onPress}
      activeOpacity={0.85}
      accessible
      accessibilityRole="alert"
      accessibilityLabel={t('sync.attention.label', { count: failedCount, countDisplay: toArabicDigits(String(failedCount)) })}
    >
      <View style={styles.row}>
        <Icon name="warning-outline" size={16} color={colors.danger} />
        <View style={styles.textBlock}>
          <AppText role="label" color={colors.danger}>
            {t('sync.attention.title', { count: failedCount, countDisplay: toArabicDigits(String(failedCount)) })}
          </AppText>
          <AppText role="caption" color={`${colors.danger}CC`}>
            {t('sync.attention.tapToReview')}
          </AppText>
        </View>
        {/* RTL: app is force-RTL so "forward" (into detail) is visually ← */}
        <Icon name="chevron-back-outline" size={14} color={colors.danger} />
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: `${colors.danger}18`,
    borderBottomWidth: 1,
    borderBottomColor: `${colors.danger}40`,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  textBlock: {
    flex: 1,
  },
});
