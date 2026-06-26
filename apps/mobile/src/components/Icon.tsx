/**
 * Icon — thin wrapper around @expo/vector-icons Ionicons.
 * Used instead of lucide-react-native to avoid requiring react-native-svg.
 * Size defaults to 20; colour defaults to design-system text colour.
 */
import React from 'react';
import { Ionicons } from '@expo/vector-icons';

import { colors } from '../design/tokens';

export type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

interface IconProps {
  name: IoniconName;
  size?: number;
  color?: string;
  style?: React.ComponentProps<typeof Ionicons>['style'];
}

export function Icon({ name, size = 20, color = colors.text, style }: IconProps) {
  return <Ionicons name={name} size={size} color={color} style={style} />;
}
