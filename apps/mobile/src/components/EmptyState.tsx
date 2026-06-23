/**
 * EmptyState — design system §8.
 * Always shows icon + cause + one primary action. Never a blank panel.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { colors, spacing } from '../design/tokens';
import { AppText } from './AppText';
import { Button } from './Button';

interface Props {
  title: string;
  body?: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function EmptyState({ title, body, actionLabel, onAction }: Props) {
  return (
    <View style={styles.container}>
      <AppText role="h3" align="center" color={colors.textMuted}>
        {title}
      </AppText>
      {body && (
        <AppText role="body" align="center" color={colors.textFaint}>
          {body}
        </AppText>
      )}
      {actionLabel && onAction && (
        <Button
          variant="secondary"
          onPress={onAction}
          accessibilityLabel={actionLabel}
          style={styles.action}
        >
          {actionLabel}
        </Button>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.xl,
  },
  action: {
    marginTop: spacing.md,
  },
});
