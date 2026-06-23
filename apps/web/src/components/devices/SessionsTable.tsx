'use client';

/**
 * SessionsTable — DataTable for current/recent sessions (design-system §9.7)
 * Read-only in Phase 3. All four states built in.
 * Columns: Device · Status · Started · Elapsed · Total
 * Numeric columns are end-aligned + tabular (design-system §6).
 */
import { useTranslations } from 'next-intl';
import { formatEgp, toArabicDigits } from '@ps/core';
import type { Session } from '@ps/core';
import { StatusPill } from '@/components/ui/StatusPill';
import { LiveTimer } from '@/components/ui/LiveTimer';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { TableRowSkeleton } from '@/components/ui/Skeleton';

interface SessionRow extends Session {
  device_name?: string;
}

interface SessionsTableProps {
  sessions: SessionRow[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}

function formatStartedAt(iso: string): string {
  // Format as HH:MM in Cairo timezone using Arabic-Indic digits
  const date = new Date(iso);
  const hours = date.getUTCHours().toString().padStart(2, '0');
  const minutes = date.getUTCMinutes().toString().padStart(2, '0');
  return toArabicDigits(`${hours}:${minutes}`);
}

export function SessionsTable({
  sessions,
  loading = false,
  error,
  onRetry,
}: SessionsTableProps) {
  const t = useTranslations();

  return (
    <section aria-label={t('sessions.title')}>
      <h2 className="text-h2 text-text mb-md">{t('sessions.title')}</h2>
      <div className="rounded-md border border-border bg-surface overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-label text-text" aria-label={t('sessions.title')}>
            <thead>
              <tr className="border-b border-border bg-surface-2">
                <th
                  scope="col"
                  className="px-md py-sm text-start font-medium text-text-muted"
                >
                  {t('sessions.columns.device')}
                </th>
                <th
                  scope="col"
                  className="px-md py-sm text-start font-medium text-text-muted"
                >
                  {t('sessions.columns.status')}
                </th>
                <th
                  scope="col"
                  className="px-md py-sm text-start font-medium text-text-muted"
                >
                  {t('sessions.columns.started')}
                </th>
                {/* Numeric columns: end-aligned in logical terms (RTL-aware) */}
                <th
                  scope="col"
                  className="px-md py-sm text-end font-medium text-text-muted"
                  aria-sort="none"
                >
                  {t('sessions.columns.elapsed')}
                </th>
                <th
                  scope="col"
                  className="px-md py-sm text-end font-medium text-text-muted"
                >
                  {t('sessions.columns.total')}
                </th>
              </tr>
            </thead>
            <tbody>
              {loading &&
                Array.from({ length: 4 }).map((_, i) => (
                  <TableRowSkeleton key={i} cols={5} />
                ))}
              {!loading && error && (
                <tr>
                  <td colSpan={5}>
                    <ErrorState message={error} onRetry={onRetry} />
                  </td>
                </tr>
              )}
              {!loading && !error && sessions.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <EmptyState
                      title={t('sessions.empty.title')}
                      body={t('sessions.empty.body')}
                    />
                  </td>
                </tr>
              )}
              {!loading &&
                !error &&
                sessions.map((session) => (
                  <tr
                    key={session.id}
                    className="border-b border-border last:border-0 hover:bg-surface-2 transition-colors"
                  >
                    <td className="px-md py-sm">
                      <span className="font-medium">
                        {session.device_name ?? session.device_id}
                      </span>
                    </td>
                    <td className="px-md py-sm">
                      <StatusPill
                        status={
                          session.status === 'active'
                            ? 'busy'
                            : session.status === 'closed'
                              ? 'free'
                              : 'maintenance'
                        }
                      />
                    </td>
                    <td className="px-md py-sm text-text-muted" dir="ltr">
                      {formatStartedAt(session.started_at)}
                    </td>
                    <td className="px-md py-sm text-end tabular-nums" dir="ltr">
                      <LiveTimer
                        startedAt={session.started_at}
                        endedAt={session.ended_at}
                        tickMs={session.status === 'active' ? 15000 : undefined}
                        size="sm"
                      />
                    </td>
                    <td className="px-md py-sm text-end tabular-nums text-primary font-medium">
                      {formatEgp(session.grand_total)}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
