/**
 * SyncStatusChip — 4-state header chip (design spec §3.1 / §9.14.1).
 *
 * States (precedence from selectSyncState):
 *   attention — failedCount > 0       danger bg, static exclamation
 *   offline   — !online               warning bg, static wifi-off
 *   syncing   — syncing || pending>0  primary bg, spinning refresh
 *   synced    — all clear             primary bg, static checkmark
 *
 * Tap opens SyncCenterSheet (passed as onPress prop so no circular deps).
 *
 * RTL: flexDirection row — mirrors automatically in RTL layouts.
 * All user-facing strings come from i18n (no hardcoded Arabic).
 */
import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Easing,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import { colors, radius, spacing } from '../design/tokens';
import { AppText } from './AppText';
import { Icon } from './Icon';
import { useSync, selectSyncState } from '../stores/useSync';

interface SyncStatusChipProps {
  onPress?: () => void;
}

export function SyncStatusChip({ onPress }: SyncStatusChipProps) {
  const { t } = useTranslation();
  const store = useSync();
  const state = selectSyncState(store);

  // Rotation animation for 'syncing' state
  const rotation = useRef(new Animated.Value(0)).current;
  const animRef = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    if (state === 'syncing') {
      animRef.current = Animated.loop(
        Animated.timing(rotation, {
          toValue: 1,
          duration: 1000,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
      );
      animRef.current.start();
    } else {
      animRef.current?.stop();
      rotation.setValue(0);
    }
    return () => {
      animRef.current?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const spin = rotation.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  const { bg, iconColor, iconName, label } = chipConfig(state, t);

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.75}
      accessible
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={t('sync.chip.hint')}
      style={[styles.chip, { backgroundColor: bg }]}
    >
      {state === 'syncing' ? (
        <Animated.View style={{ transform: [{ rotate: spin }] }}>
          <Icon name={iconName} size={14} color={iconColor} />
        </Animated.View>
      ) : (
        <Icon name={iconName} size={14} color={iconColor} />
      )}
      <View style={styles.textWrap}>
        <AppText role="micro" color={iconColor} numberOfLines={1}>
          {label}
        </AppText>
      </View>
    </TouchableOpacity>
  );
}

type ChipSyncState = 'synced' | 'syncing' | 'offline' | 'attention';

function chipConfig(
  state: ChipSyncState,
  t: (key: string, opts?: Record<string, unknown>) => string,
): { bg: string; iconColor: string; iconName: React.ComponentProps<typeof Icon>['name']; label: string } {
  switch (state) {
    case 'attention':
      return {
        bg: `${colors.danger}30`,
        iconColor: colors.danger,
        iconName: 'alert-circle-outline',
        label: t('sync.chip.attention'),
      };
    case 'offline':
      return {
        bg: `${colors.warning}30`,
        iconColor: colors.warning,
        iconName: 'cloud-offline-outline',
        label: t('sync.chip.offline'),
      };
    case 'syncing':
      return {
        bg: `${colors.primary}30`,
        iconColor: colors.primary,
        iconName: 'refresh-outline',
        label: t('sync.chip.syncing'),
      };
    case 'synced':
    default:
      return {
        bg: `${colors.primary}20`,
        iconColor: colors.primary,
        iconName: 'checkmark-circle-outline',
        label: t('sync.chip.synced'),
      };
  }
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing['2xs'],
    gap: 4,
  },
  textWrap: {
    maxWidth: 80,
  },
});
