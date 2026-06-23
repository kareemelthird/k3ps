/**
 * Branch picker screen — M2 (design spec §M2).
 * Shown only when the tenant has >1 branch. Single-branch members skip directly
 * to the device grid (handled in index.tsx via redirect on activeBranchId).
 * Four states: loading / empty / error / normal list.
 */
import React, { useEffect } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';

import type { Branch } from '@ps/core';

import { useBranches } from '../../src/features/auth/api';
import { useAuth } from '../../src/stores/useAuth';
import { colors, spacing, radius, TAP_TARGET } from '../../src/design/tokens';
import { AppText } from '../../src/components/AppText';
import { EmptyState } from '../../src/components/EmptyState';
import { ErrorState } from '../../src/components/ErrorState';
import { OfflineBanner } from '../../src/components/OfflineBanner';
import { Skeleton } from '../../src/components/Skeleton';

export default function SelectBranchScreen() {
  const { t } = useTranslation();
  const { claim, setActiveBranch } = useAuth();
  const tenantId = claim?.tenant_id ?? null;

  const { data: branches, isLoading, error, refetch } = useBranches(tenantId);

  // Auto-select if only one branch
  useEffect(() => {
    if (branches && branches.length === 1 && branches[0]) {
      void setActiveBranch(branches[0].id).then(() => {
        router.replace('/(operate)/devices');
      });
    }
  }, [branches, setActiveBranch]);

  const handleSelect = async (branch: Branch) => {
    await setActiveBranch(branch.id);
    router.replace('/(operate)/devices');
  };

  return (
    <View style={styles.screen}>
      <OfflineBanner />

      <View style={styles.header}>
        <AppText role="h1">{t('branch.choose.title')}</AppText>
      </View>

      {isLoading && (
        <View style={styles.list}>
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} height={TAP_TARGET} borderRadius={radius.md} />
          ))}
        </View>
      )}

      {error && !isLoading && (
        <ErrorState
          message={t('state.error.generic')}
          onRetry={() => void refetch()}
          retryLabel={t('action.retry')}
        />
      )}

      {!isLoading && !error && branches?.length === 0 && (
        <EmptyState
          title={t('branch.empty.title')}
          body={t('branch.empty.body')}
        />
      )}

      {!isLoading && !error && (branches?.length ?? 0) > 1 && (
        <FlatList
          data={branches}
          keyExtractor={(b) => b.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <BranchRow branch={item} onSelect={() => void handleSelect(item)} />
          )}
        />
      )}
    </View>
  );
}

function BranchRow({
  branch,
  onSelect,
}: {
  branch: Branch;
  onSelect: () => void;
}) {
  const { activeBranchId } = useAuth();
  const isActive = activeBranchId === branch.id;

  return (
    <Pressable
      onPress={onSelect}
      style={[styles.row, isActive && styles.rowActive]}
      accessible
      accessibilityRole="button"
      accessibilityState={{ selected: isActive }}
      accessibilityLabel={branch.name}
    >
      <AppText role="h3" style={styles.rowText}>
        {branch.name}
      </AppText>
      {isActive && (
        <AppText role="caption" color={colors.primary}>
          ✓
        </AppText>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    padding: spacing.xl,
    paddingBottom: spacing.md,
  },
  list: {
    padding: spacing.xl,
    gap: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    minHeight: 56,
  },
  rowActive: {
    borderColor: colors.primary,
    backgroundColor: colors.surface2,
  },
  rowText: {
    flex: 1,
    paddingVertical: spacing.md,
  },
});
