/**
 * Sheet — design system §9.3.
 * Bottom sheet: top corners lg radius, drag handle, scrim, safe-area padding.
 * Slides up from trigger; focus trapped; Esc closes.
 */
import React from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  View,
} from 'react-native';

import { colors, radius, spacing } from '../design/tokens';
import { AppText } from './AppText';

interface Props {
  visible: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  dismissible?: boolean;
}

export function Sheet({
  visible,
  onClose,
  title,
  children,
  dismissible = true,
}: Props) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={dismissible ? onClose : undefined}
      statusBarTranslucent
    >
      {/* Scrim */}
      <Pressable
        style={styles.scrim}
        onPress={dismissible ? onClose : undefined}
        accessibilityLabel="إغلاق"
        accessibilityRole="button"
      />

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.sheetWrapper}
      >
        <SafeAreaView style={styles.sheet}>
          {/* Drag handle */}
          <View style={styles.handle} />

          {/* Title row */}
          <View style={styles.titleRow}>
            <AppText role="h2" style={styles.title}>
              {title}
            </AppText>
            {dismissible && (
              <Pressable
                onPress={onClose}
                accessibilityLabel="إغلاق"
                accessibilityRole="button"
                hitSlop={8}
              >
                <AppText role="label" color={colors.textMuted}>
                  ✕
                </AppText>
              </Pressable>
            )}
          </View>

          {/* Content */}
          <View style={styles.content}>{children}</View>
        </SafeAreaView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.scrim,
  },
  sheetWrapper: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopStartRadius: radius.lg,
    borderTopEndRadius: radius.lg,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xl,
    maxHeight: '92%',
  },
  handle: {
    width: 40,
    height: 4,
    backgroundColor: colors.border,
    borderRadius: radius.pill,
    alignSelf: 'center',
    marginTop: spacing.sm,
    marginBottom: spacing.md,
  },
  titleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xl,
  },
  title: {
    flex: 1,
  },
  content: {
    gap: spacing.md,
  },
});
