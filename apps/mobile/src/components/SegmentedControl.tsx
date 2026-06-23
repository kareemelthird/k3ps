/**
 * SegmentedControl — design system §9.4.
 * Selected = primary fill + on-primary text; unselected = textMuted.
 * RTL: segment order follows reading order (mirrored by I18nManager).
 * Min segment height 44, track in a 52-tall row.
 */
import React from 'react';
import {
  Pressable,
  StyleSheet,
  View,
} from 'react-native';

import { colors, radius, spacing } from '../design/tokens';
import { AppText } from './AppText';

interface Option {
  value: string;
  label: string;
  disabled?: boolean;
}

interface Props {
  options: Option[];
  value: string;
  onChange: (value: string) => void;
}

export function SegmentedControl({ options, value, onChange }: Props) {
  return (
    <View style={styles.track} accessibilityRole="radiogroup">
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            onPress={() => !opt.disabled && onChange(opt.value)}
            disabled={opt.disabled}
            accessibilityRole="radio"
            accessibilityState={{
              checked: selected,
              disabled: opt.disabled,
            }}
            accessibilityLabel={opt.label}
            style={[
              styles.segment,
              selected && styles.selected,
              opt.disabled && styles.disabledSegment,
            ]}
          >
            <AppText
              role="label"
              color={
                opt.disabled
                  ? colors.textFaint
                  : selected
                    ? colors.onPrimary
                    : colors.textMuted
              }
            >
              {opt.label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    backgroundColor: colors.surface3,
    borderRadius: radius.sm,
    padding: 3,
    minHeight: 52,
  },
  segment: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: radius.xs,
    minHeight: 44,
    paddingHorizontal: spacing.sm,
  },
  selected: {
    backgroundColor: colors.primary,
  },
  disabledSegment: {
    opacity: 0.45,
  },
});
