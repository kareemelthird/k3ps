/**
 * TextField — design system §9.6.
 * Visible label (never placeholder-only), error below field, validate on blur.
 * RTL-safe: label + error align start.
 */
import React, { useState } from 'react';
import {
  Pressable,
  StyleSheet,
  TextInput,
  TextInputProps,
  View,
} from 'react-native';

import { colors, radius, spacing, TAP_TARGET } from '../design/tokens';
import { AppText } from './AppText';

interface Props extends Omit<TextInputProps, 'style'> {
  label: string;
  error?: string;
  helper?: string;
  required?: boolean;
  showPasswordToggle?: boolean;
}

export function TextField({
  label,
  error,
  helper,
  required,
  showPasswordToggle,
  secureTextEntry,
  ...rest
}: Props) {
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(secureTextEntry ?? false);

  const borderColor = error
    ? colors.danger
    : focused
      ? colors.borderStrong
      : colors.border;

  return (
    <View style={styles.container}>
      <AppText role="label" color={colors.textMuted} style={styles.label}>
        {label}
        {required && (
          <AppText role="label" color={colors.danger}>
            {' '}*
          </AppText>
        )}
      </AppText>

      <View style={[styles.inputRow, { borderColor }]}>
        <TextInput
          {...rest}
          secureTextEntry={hidden}
          onFocus={(e) => {
            setFocused(true);
            rest.onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            rest.onBlur?.(e);
          }}
          style={styles.input}
          placeholderTextColor={colors.textFaint}
          cursorColor={colors.primary}
          selectionColor={colors.primary}
          accessibilityLabel={label}
        />
        {showPasswordToggle && (
          <Pressable
            onPress={() => setHidden((h) => !h)}
            accessibilityLabel={hidden ? 'إظهار كلمة المرور' : 'إخفاء كلمة المرور'}
            hitSlop={8}
            style={styles.toggle}
          >
            <AppText role="caption" color={colors.textMuted}>
              {hidden ? 'إظهار' : 'إخفاء'}
            </AppText>
          </Pressable>
        )}
      </View>

      {error ? (
        <AppText role="caption" color={colors.danger} style={styles.helper} accessibilityRole="text">
          {error}
        </AppText>
      ) : helper ? (
        <AppText role="caption" color={colors.textFaint} style={styles.helper}>
          {helper}
        </AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.xs,
  },
  label: {
    marginBottom: 4,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface3,
    borderRadius: radius.sm,
    borderWidth: 1.5,
    minHeight: TAP_TARGET,
    paddingHorizontal: spacing.md,
  },
  input: {
    flex: 1,
    color: colors.text,
    fontSize: 16,
    lineHeight: 24,
    textAlign: 'right', // RTL default for Arabic
  },
  toggle: {
    paddingStart: spacing.sm,
  },
  helper: {
    marginTop: 2,
  },
});
