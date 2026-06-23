/**
 * ErrorState — design system §8.
 * Human cause + recovery path (Retry / Edit / contact).
 * Inline near the failed region. role="alert" / aria-live.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { colors, spacing } from '../design/tokens';
import { AppText } from './AppText';
import { Button } from './Button';

interface Props {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
}

export function ErrorState({ message, onRetry, retryLabel = 'إعادة المحاولة' }: Props) {
  return (
    <View style={styles.container} accessibilityRole="alert" accessible>
      <AppText role="body" align="center" color={colors.danger}>
        {message}
      </AppText>
      {onRetry && (
        <Button
          variant="secondary"
          onPress={onRetry}
          accessibilityLabel={retryLabel}
          style={styles.retry}
        >
          {retryLabel}
        </Button>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.xl,
  },
  retry: {
    marginTop: spacing.sm,
  },
});
