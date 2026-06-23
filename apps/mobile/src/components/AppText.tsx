/**
 * AppText — typed text component with the "Calm Operations" type system.
 * Arabic-first; all text is LTR-safe for Latin (device IDs, emails, etc.
 * are wrapped with explicit direction). No hardcoded user strings.
 */
import React from 'react';
import { StyleProp, Text, TextStyle } from 'react-native';

import { colors, fontSize, fontWeight, lineHeight } from '../design/tokens';

export type TextRole =
  | 'display'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'body'
  | 'label'
  | 'caption'
  | 'micro'
  | 'timer'
  | 'money';

interface Props {
  role?: TextRole;
  color?: string;
  align?: 'auto' | 'left' | 'right' | 'center' | 'justify';
  numberOfLines?: number;
  style?: StyleProp<TextStyle>;
  children: React.ReactNode;
  accessibilityLabel?: string;
  accessibilityRole?: 'text' | 'header' | 'none' | 'link';
}

export function AppText({
  role = 'body',
  color,
  align,
  numberOfLines,
  style,
  children,
  accessibilityLabel,
  accessibilityRole,
}: Props) {
  return (
    <Text
      style={[
        {
          fontSize: fontSize[role],
          fontWeight: fontWeight[role],
          lineHeight: lineHeight[role],
          color: color ?? colors.text,
          ...(align ? { textAlign: align } : {}),
        },
        style,
      ]}
      numberOfLines={numberOfLines}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={accessibilityRole}
    >
      {children}
    </Text>
  );
}
