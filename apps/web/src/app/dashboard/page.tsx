import { DashboardShell } from '@/components/shell/DashboardShell';

/**
 * Owner dashboard — W2 devices + sessions (read-only).
 * Dynamic: data fetched client-side using the browser Supabase client
 * (RLS-scoped via the signed JWT claim).
 */
export const dynamic = 'force-dynamic';

export default function DashboardPage() {
  return <DashboardShell />;
}
