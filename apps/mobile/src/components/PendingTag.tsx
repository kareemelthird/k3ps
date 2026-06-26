/**
 * PendingTag — small "awaiting sync" marker attached to optimistic items.
 * Shown on orders/sessions that are in the outbox but not yet flushed.
 * Design spec §9.14.4: 'label' micro text, warning colour, no icon.
 * Disappears once the realtime subscription delivers the confirmed write.
 *
 * RTL: uses start/end margins so it mirrors correctly in Arabic layouts.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { colors, radius, spacing } from '../design/tokens';
import { AppText } from './AppText';

export function PendingTag() {
  const { t } = useTranslation();
  return (
    <View style={styles.tag} accessibilityRole="text" accessible>
      <AppText role="micro" color={colors.warning}>
        {t('sync.pendingTag')}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  tag: {
    alignSelf: 'flex-start',
    backgroundColor: `${colors.warning}20`, // 12 % opacity tint
    borderRadius: radius.xs,
    paddingHorizontal: spacing['2xs'],
    paddingVertical: 2,
    marginStart: spacing.xs,
  },
});
