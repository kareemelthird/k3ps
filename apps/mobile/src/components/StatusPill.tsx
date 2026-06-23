/**
 * StatusPill — design system §9.2.
 * Colored dot + label on a tinted background.
 * Status is conveyed by dot + label, never color alone.
 * Pulse animates the dot opacity only (disabled under reduced-motion).
 */
import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { colors, radius, spacing } from '../design/tokens';
import { AppText } from './AppText';

type Status = 'free' | 'busy' | 'maintenance' | 'warning' | 'danger';

interface Props {
  status: Status;
  label: string;
  dot?: boolean;
  pulse?: boolean;
}

const statusColor: Record<Status, string> = {
  free: colors.statusFree,
  busy: colors.statusBusy,
  maintenance: colors.statusMaint,
  warning: colors.warning,
  danger: colors.danger,
};

function useReducedMotionSafe(): boolean {
  return false; // Conservative: no reduced-motion API in this RN version
}

export function StatusPill({ status, label, dot = true, pulse = false }: Props) {
  const color = statusColor[status];
  const reducedMotion = useReducedMotionSafe();
  const dotOpacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!pulse || reducedMotion) {
      dotOpacity.setValue(1);
      return;
    }
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(dotOpacity, {
          toValue: 0.6,
          duration: 600,
          useNativeDriver: true,
        }),
        Animated.timing(dotOpacity, {
          toValue: 1,
          duration: 600,
          useNativeDriver: true,
        }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [pulse, reducedMotion, dotOpacity]);

  return (
    <View
      style={[styles.pill, { backgroundColor: `${color}1A` }]}
      accessibilityValue={{ text: label }}
    >
      {dot && (
        <Animated.View
          style={[
            styles.dot,
            { backgroundColor: color, opacity: pulse ? dotOpacity : 1 },
          ]}
        />
      )}
      <AppText role="caption" color={color}>
        {label}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.xs,
    alignSelf: 'flex-start',
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
});
