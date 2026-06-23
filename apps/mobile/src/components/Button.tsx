/**
 * Button — "Calm Operations" design system §9.1.
 * Variants: primary · secondary · ghost · danger.
 * Min height 52 (TAP_TARGET), `lg` = 56.
 * Inline spinner when loading; disabled during async.
 * No hardcoded user strings — caller passes accessible labels.
 */
import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleProp,
  StyleSheet,
  View,
  ViewStyle,
} from 'react-native';

import { colors, radius, TAP_TARGET } from '../design/tokens';
import { AppText } from './AppText';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'md' | 'lg';

interface Props {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  onPress?: () => void;
  accessibilityLabel: string;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}

const variantStyles: Record<
  Variant,
  { bg: string; text: string; border?: string }
> = {
  primary: { bg: colors.primary, text: colors.onPrimary },
  secondary: { bg: 'transparent', text: colors.primary, border: colors.primary },
  ghost: { bg: 'transparent', text: colors.textMuted },
  danger: { bg: colors.danger, text: '#FFFFFF' },
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  fullWidth = false,
  onPress,
  accessibilityLabel,
  style,
  children,
}: Props) {
  const v = variantStyles[variant];
  const height = size === 'lg' ? 56 : TAP_TARGET;
  const isDisabled = disabled || loading;

  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled }}
      style={({ pressed }) => [
        styles.base,
        {
          height,
          backgroundColor: v.bg,
          borderColor: v.border ?? 'transparent',
          borderWidth: v.border ? 1.5 : 0,
          borderRadius: radius.sm,
          opacity: isDisabled ? 0.45 : pressed ? 0.92 : 1,
          transform: [{ scale: pressed && !isDisabled ? 0.97 : 1 }],
          ...(fullWidth ? { width: '100%' } : {}),
        },
        style,
      ]}
    >
      <View style={styles.content}>
        {loading ? (
          <ActivityIndicator
            size="small"
            color={v.text}
            accessibilityLabel={accessibilityLabel}
          />
        ) : (
          <AppText role="label" color={v.text} style={styles.label}>
            {children}
          </AppText>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  label: {
    fontWeight: '600',
  },
});
