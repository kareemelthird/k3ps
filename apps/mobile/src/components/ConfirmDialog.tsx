/**
 * ConfirmDialog — design system §9.8.
 * Required before destructive actions. Cancel (start/ghost) + Confirm (end).
 * Destructive confirm uses danger color; always shows consequence sentence.
 *
 * A11y (ADR-0011 §Q5): accessibilityViewIsModal traps focus; cancelLabel resolved
 * from i18n by the caller (no hardcoded Arabic defaults here). (AC 22–23)
 */
import React from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import { colors, radius, spacing } from '../design/tokens';
import { AppText } from './AppText';
import { Button } from './Button';

interface Props {
  visible: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  /** Defaults to t('action.cancel') when omitted. */
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
  cancelLabel,
  onConfirm,
  onCancel,
  loading = false,
  destructive = false,
}: Props) {
  const { t } = useTranslation();
  const resolvedCancelLabel = cancelLabel ?? t('action.cancel');

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
      accessibilityViewIsModal
    >
      <Pressable
        style={styles.scrim}
        onPress={onCancel}
        accessibilityLabel={resolvedCancelLabel}
        accessibilityRole="button"
      />
      <View style={styles.dialogWrapper} pointerEvents="box-none">
        <View
          style={styles.dialog}
          accessible
          accessibilityRole="alert"
        >
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
              accessibilityLabel={resolvedCancelLabel}
              style={styles.cancelBtn}
            >
              {resolvedCancelLabel}
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
