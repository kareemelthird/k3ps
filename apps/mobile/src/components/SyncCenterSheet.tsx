/**
 * SyncCenterSheet — detailed sync status panel (design spec §3.4 / §9.14.5).
 *
 * Displays:
 *   SyncSummaryHeader  — state icon + last-synced time + pending/failed counts
 *   Pending list       — queue entries waiting to flush (informational, no actions)
 *   Failed list        — dead-letter entries with Retry / Discard per row
 *
 * Uses a Modal (full-screen on mobile) so it works without an installed Sheet
 * component. RTL: all rows use flexDirection 'row' which mirrors in RTL.
 * All strings from i18n — no hardcoded Arabic.
 *
 * Performance (ADR-0011 §Q4, AC 16): SectionList replaces ScrollView+map so
 * large queues (>20 entries) are fully virtualized.
 *
 * Actions:
 *   Retry single: retryDeadEntries(localId)
 *   Retry all: retryDeadEntries('all')
 *   Discard single: discardDeadEntries(localId)
 */
import React, { useCallback, useMemo } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  SectionList,
  StyleSheet,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import { toArabicDigits, type OutboxEntry } from '@ps/core';

import { colors, radius, spacing } from '../design/tokens';
import { AppText } from './AppText';
import { Icon } from './Icon';
import { useSync, selectSyncState } from '../stores/useSync';
import { getOutboxState, retryDeadEntries, discardDeadEntries } from '../lib/outbox';

// Tables that carry financial data — discard confirmation gets a danger-level message.
const MONEY_TABLES = new Set([
  'close_session_tx',
  'orders',
  'stock_movements',
  'audit_log',
  'shifts',
]);

interface SyncCenterSheetProps {
  visible: boolean;
  onClose: () => void;
}

// SectionList section type — discriminates failed vs pending.
type SyncSection = {
  key: 'failed' | 'pending';
  data: OutboxEntry[];
};

export function SyncCenterSheet({ visible, onClose }: SyncCenterSheetProps) {
  const { t } = useTranslation();
  const store = useSync();
  const syncState = selectSyncState(store);
  const { pending, failed } = getOutboxState();

  const handleRetry = useCallback(async (localId: string) => {
    await retryDeadEntries(localId);
  }, []);

  const handleRetryAll = useCallback(async () => {
    await retryDeadEntries('all');
  }, []);

  // SHOULD-FIX 4: require explicit confirmation before discarding a dead-letter
  // entry; money-bearing tables (those that write financial rows) get a danger
  // message naming the operation type. Spec AC23 requires this gate.
  const handleDiscard = useCallback((localId: string) => {
    const entry = failed.find((e) => e.localId === localId);
    const isMoney = entry ? MONEY_TABLES.has(entry.table) : false;
    const entryLabel = entry ? tableLabel(entry.table, t) : '';
    const message = isMoney
      ? t('sync.discard.confirmMoney', { table: entryLabel })
      : t('sync.discard.confirm', { table: entryLabel });

    Alert.alert(
      t('sync.discard.title'),
      message,
      [
        { text: t('action.cancel'), style: 'cancel' },
        {
          text: t('sync.discard.confirmBtn'),
          style: 'destructive',
          onPress: () => { void discardDeadEntries(localId); },
        },
      ],
    );
  }, [failed, t]);

  const { iconName, iconColor, stateLabel } = headerConfig(syncState, t);

  // Build sections — omit empty sections so SectionList renders correctly.
  const sections = useMemo<SyncSection[]>(() => {
    const result: SyncSection[] = [];
    if (failed.length > 0) result.push({ key: 'failed', data: failed });
    if (pending.length > 0) result.push({ key: 'pending', data: pending });
    return result;
  }, [failed, pending]);

  // Rendered once above all sections.
  const ListHeader = (
    <View>
      {store.lastSyncedAt && (
        <View style={styles.lastSynced}>
          <AppText role="caption" color={colors.textFaint}>
            {t('sync.center.lastSynced', {
              time: toArabicDigits(
                new Date(store.lastSyncedAt).toLocaleTimeString('ar-EG', {
                  hour: '2-digit',
                  minute: '2-digit',
                }),
              ),
            })}
          </AppText>
        </View>
      )}
    </View>
  );

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
      accessible
    >
      <View style={styles.container}>
        {/* Non-scrolling app header */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Icon name={iconName} size={22} color={iconColor} />
            <View>
              <AppText role="h3">{t('sync.center.title')}</AppText>
              <AppText role="caption" color={colors.textMuted}>
                {stateLabel}
              </AppText>
            </View>
          </View>
          <Pressable
            onPress={onClose}
            accessible
            accessibilityRole="button"
            accessibilityLabel={t('action.close')}
            style={styles.closeBtn}
          >
            <Icon name="close-outline" size={24} color={colors.textMuted} />
          </Pressable>
        </View>

        {/* Virtualized queue list (AC 16) */}
        <SectionList<OutboxEntry, SyncSection>
          sections={sections}
          keyExtractor={(item) => item.localId}
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          ListHeaderComponent={ListHeader}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Icon name="checkmark-circle-outline" size={40} color={colors.primary} />
              <AppText role="body" color={colors.textMuted} align="center">
                {t('sync.center.allSynced')}
              </AppText>
            </View>
          }
          renderSectionHeader={({ section }) => {
            if (section.key === 'failed') {
              return (
                <View style={styles.sectionHeader}>
                  <AppText role="label" color={colors.danger}>
                    {t('sync.center.failedTitle', {
                      count: section.data.length,
                      countDisplay: toArabicDigits(String(section.data.length)),
                    })}
                  </AppText>
                  <Pressable
                    onPress={() => void handleRetryAll()}
                    accessible
                    accessibilityRole="button"
                    accessibilityLabel={t('sync.center.retryAll')}
                  >
                    <AppText role="caption" color={colors.primary}>
                      {t('sync.center.retryAll')}
                    </AppText>
                  </Pressable>
                </View>
              );
            }
            return (
              <View style={styles.sectionHeader}>
                <AppText role="label" color={colors.textMuted}>
                  {t('sync.center.pendingTitle', {
                    count: section.data.length,
                    countDisplay: toArabicDigits(String(section.data.length)),
                  })}
                </AppText>
              </View>
            );
          }}
          renderItem={({ item, section }) => (
            <QueueEntryRow
              entry={item}
              variant={section.key}
              onRetry={section.key === 'failed' ? () => void handleRetry(item.localId) : undefined}
              onDiscard={section.key === 'failed' ? () => handleDiscard(item.localId) : undefined}
              t={t}
            />
          )}
          SectionSeparatorComponent={() => <View style={styles.sectionGap} />}
          ItemSeparatorComponent={() => <View style={styles.itemSeparator} />}
        />
      </View>
    </Modal>
  );
}

// ─── QueueEntryRow ─────────────────────────────────────────────────────────────

interface QueueEntryRowProps {
  entry: OutboxEntry;
  variant: 'pending' | 'failed';
  onRetry?: () => void;
  onDiscard?: () => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}

function QueueEntryRow({ entry, variant, onRetry, onDiscard, t }: QueueEntryRowProps) {
  const iconColor = variant === 'failed' ? colors.danger : colors.warning;
  const iconName = variant === 'failed' ? 'close-circle-outline' : 'time-outline';

  return (
    <View style={[styles.row, variant === 'failed' && styles.rowFailed]}>
      <Icon name={iconName} size={16} color={iconColor} />
      <View style={styles.rowContent}>
        <AppText role="caption" numberOfLines={1}>
          {tableLabel(entry.table, t)}
        </AppText>
        {variant === 'failed' && entry.deadReason && (
          <AppText role="micro" color={colors.danger} numberOfLines={2}>
            {entry.deadReason === 'blocked-by-dead-parent'
              ? t('sync.entry.blockedByParent')
              : entry.deadReason}
          </AppText>
        )}
        {variant === 'pending' && (
          <AppText role="micro" color={colors.textFaint}>
            {t('sync.entry.attempts', { count: entry.attempts, countDisplay: toArabicDigits(String(entry.attempts)) })}
          </AppText>
        )}
      </View>
      {variant === 'failed' && (
        <View style={styles.rowActions}>
          {onRetry && (
            <Pressable
              onPress={onRetry}
              accessible
              accessibilityRole="button"
              accessibilityLabel={t('sync.center.retry')}
              style={styles.actionBtn}
            >
              <AppText role="micro" color={colors.primary}>
                {t('sync.center.retry')}
              </AppText>
            </Pressable>
          )}
          {onDiscard && (
            <Pressable
              onPress={onDiscard}
              accessible
              accessibilityRole="button"
              accessibilityLabel={t('sync.center.discard')}
              style={styles.actionBtn}
            >
              <AppText role="micro" color={colors.textFaint}>
                {t('sync.center.discard')}
              </AppText>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}

// ─── Table-name i18n lookup ────────────────────────────────────────────────────

const TABLE_KEY_MAP: Record<string, string> = {
  sessions: 'sync.entry.tableSession',
  session_segments: 'sync.entry.tableSegment',
  devices: 'sync.entry.tableDevice',
  orders: 'sync.entry.tableOrder',
  order_items: 'sync.entry.tableOrderItem',
  stock_movements: 'sync.entry.tableStockMovement',
  shifts: 'sync.entry.tableShift',
  audit_log: 'sync.entry.tableAudit',
  close_session_tx: 'sync.entry.tableCloseRpc',
};

function tableLabel(table: string, t: (key: string) => string): string {
  const key = TABLE_KEY_MAP[table];
  return key ? t(key) : table; // unknown tables fall back to the raw name (technical fallback)
}

// ─── Header config ─────────────────────────────────────────────────────────────

type ChipSyncState = 'synced' | 'syncing' | 'offline' | 'attention';

function headerConfig(
  state: ChipSyncState,
  t: (key: string) => string,
): { iconName: React.ComponentProps<typeof Icon>['name']; iconColor: string; stateLabel: string } {
  switch (state) {
    case 'attention':
      return { iconName: 'alert-circle-outline', iconColor: colors.danger, stateLabel: t('sync.chip.attention') };
    case 'offline':
      return { iconName: 'cloud-offline-outline', iconColor: colors.warning, stateLabel: t('sync.chip.offline') };
    case 'syncing':
      return { iconName: 'refresh-outline', iconColor: colors.primary, stateLabel: t('sync.chip.syncing') };
    default:
      return { iconName: 'checkmark-circle-outline', iconColor: colors.primary, stateLabel: t('sync.chip.synced') };
  }
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.surface,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xl,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  closeBtn: {
    padding: spacing.xs,
  },
  lastSynced: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xs,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: spacing.md,
    paddingBottom: spacing['3xl'],
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.xs,
    backgroundColor: colors.surface,
  },
  sectionGap: {
    height: spacing.md,
  },
  itemSeparator: {
    height: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.surface2,
    borderRadius: radius.xs,
    padding: spacing.sm,
  },
  rowFailed: {
    borderWidth: 1,
    borderColor: `${colors.danger}30`,
  },
  rowContent: {
    flex: 1,
    gap: 2,
  },
  rowActions: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  actionBtn: {
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing['2xs'],
  },
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing['3xl'],
    gap: spacing.md,
  },
});
