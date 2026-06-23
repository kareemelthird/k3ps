/**
 * LiveTimer — design system §9.10.
 *
 * INVARIANT: the displayed value is ALWAYS derived from `startedAt`
 * (or frozen at `endedAt`). The useTick hook only forces re-renders —
 * it is NEVER the source of elapsed time. (CLAUDE.md §2.2)
 *
 * On background/foreground or network loss the value stays correct
 * because it always computes `elapsedSeconds(startedAt, now)`.
 * Clocks are NOT mirrored in RTL (design-system §6).
 */
import React from 'react';
import { StyleProp, StyleSheet, TextStyle, View } from 'react-native';

import { elapsedSeconds, formatClock, toArabicDigits } from '@ps/core';

import { useTick } from '../hooks/useTick';
import { colors, fontSize, fontWeight } from '../design/tokens';
import { AppText } from './AppText';

type Format = 'clock' | 'compact';
type Size = 'sm' | 'md' | 'lg';

interface Props {
  startedAt: string;
  endedAt?: string;
  format?: Format;
  tickMs?: number;
  size?: Size;
  style?: StyleProp<TextStyle>;
  accessibilityLabel?: string;
}

const sizeFontSize: Record<Size, number> = {
  sm: 16,
  md: 22,
  lg: 34,
};

export function LiveTimer({
  startedAt,
  endedAt,
  format: _format = 'clock',
  tickMs = 1000,
  size = 'md',
  style,
  accessibilityLabel,
}: Props) {
  // Only tick when live (endedAt not set)
  useTick(endedAt ? null : tickMs);

  // Compute elapsed from timestamps — never from a counter
  const seconds = elapsedSeconds(startedAt, endedAt);
  const clockStr = formatClock(seconds);
  // Convert to Arabic-Indic digits for display
  const display = toArabicDigits(clockStr);

  return (
    <View accessibilityLabel={accessibilityLabel ?? clockStr} accessible>
      <AppText
        style={[
          styles.timer,
          { fontSize: sizeFontSize[size], lineHeight: sizeFontSize[size] + 8 },
          style,
        ]}
        role="timer"
      >
        {display}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  timer: {
    fontWeight: fontWeight.timer,
    color: colors.text,
    fontVariant: ['tabular-nums'],
    letterSpacing: 1,
  },
});
