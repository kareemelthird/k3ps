/**
 * ConfirmDialog — design system §9.8.
 * Required before destructive actions. Cancel (start/ghost) + Confirm (end).
 * Destructive confirm uses danger color; always shows consequence sentence.
 */
import React from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';

import { colors, radius, spacing } from '../design/tokens';
import { AppText } from './AppText';
import { Button } from './Button';

interface Props {
  visible: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
  destructive?: boolean;
}

export function ConfirmDialog({
  visible,
  title,
  body,
  confirmLabel,
  cancelLabel = 'إلغاء',
  onConfirm,
  onCancel,
  loading = false,
  destructive = false,
}: Props) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
    >
      <Pressable style={styles.scrim} onPress={onCancel} />
      <View style={styles.dialogWrapper} pointerEvents="box-none">
        <View style={styles.dialog}>
          <AppText role="h2" style={styles.title}>
            {title}
          </AppText>
          <AppText role="body" color={colors.textMuted} style={styles.body}>
            {body}
          </AppText>

          <View style={styles.actions}>
            <Button
              variant="ghost"
              onPress={onCancel}
              accessibilityLabel={cancelLabel}
              style={styles.cancelBtn}
            >
              {cancelLabel}
            </Button>
            <Button
              variant={destructive ? 'danger' : 'primary'}
              onPress={onConfirm}
              loading={loading}
              accessibilityLabel={confirmLabel}
              style={styles.confirmBtn}
            >
              {confirmLabel}
            </Button>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.scrim,
  },
  dialogWrapper: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xl,
  },
  dialog: {
    backgroundColor: colors.surface2,
    borderRadius: radius.lg,
    padding: spacing.xl,
    width: '100%',
    maxWidth: 420,
    gap: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  title: {
    marginBottom: spacing.xs,
  },
  body: {
    lineHeight: 24,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  cancelBtn: {
    flex: 1,
  },
  confirmBtn: {
    flex: 1,
  },
});
