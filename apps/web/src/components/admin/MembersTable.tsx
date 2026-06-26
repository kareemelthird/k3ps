'use client';

/**
 * MembersTable — members list in tenant detail (design §4 item 2, AC 7).
 * Columns: name · role · active flag.
 * Email lives in auth.users (not reachable via profiles); omitted.
 * Count must equal the overview's N (AC 7).
 */

import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/Skeleton';

export interface MemberRow {
  id: string;
  name: string;
  // email: not available — lives in auth.users, not exposed via profiles RLS
  role: string;
  isActive: boolean;
}

interface MembersTableProps {
  members: MemberRow[];
  loading?: boolean;
}

export function MembersTable({ members, loading = false }: MembersTableProps) {
  const t = useTranslations('admin');

  return (
    <div className="bg-surface rounded-md border border-border p-xl flex flex-col gap-md">
      <h2 className="text-h3 text-text font-semibold">{t('detail.members.title')}</h2>

      {loading && (
        <div className="flex flex-col gap-sm">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      )}

      {!loading && members.length === 0 && (
        <p className="text-label text-text-muted">{t('detail.members.empty')}</p>
      )}

      {!loading && members.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-label">
            <thead>
              <tr className="border-b border-border text-text-muted">
                <th className="text-start pb-sm font-medium">{t('detail.member.col.name')}</th>
                <th className="text-start pb-sm font-medium">{t('detail.member.col.role')}</th>
                <th className="text-start pb-sm font-medium">{t('detail.member.col.active')}</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const roleLabel = (() => {
                  if (m.role === 'owner') return t('detail.role.owner');
                  if (m.role === 'manager') return t('detail.role.manager');
                  return t('detail.role.staff');
                })();
                return (
                  <tr key={m.id} className="border-b border-border last:border-0">
                    <td className="py-sm pe-md text-text font-medium">{m.name || '—'}</td>
                    <td className="py-sm pe-md text-text">{roleLabel}</td>
                    <td className="py-sm">
                      <span
                        className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-pill text-caption font-medium
                          ${m.isActive
                            ? 'bg-status-free/10 text-status-free'
                            : 'bg-status-maint/10 text-status-maint'
                          }`}
                      >
                        {m.isActive ? t('tenant.status.active') : t('tenant.status.suspended')}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
