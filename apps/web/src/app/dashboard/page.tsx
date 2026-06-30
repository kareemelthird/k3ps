import { DashboardPageShell } from '@/components/shell/DashboardPageShell';
import { OwnerHomeView } from '@/components/home/OwnerHomeView';

/**
 * Owner dashboard home — rebuilt with DashboardPageShell (Bug 3 fix).
 *
 * Uses the same shell as products / devices / staff / reports pages so the
 * nav bar appears. The old DashboardShell (nav-less TopBar) is replaced.
 *
 * Dynamic: KPIs + device grid fetched client-side, RLS-scoped via JWT claim.
 * The OwnerHomeView component manages its own branch selection, KPI fetching,
 * and the OwnerDevicesView (live device grid, auto-refreshes every 20 s).
 */
export const dynamic = 'force-dynamic';

export default function DashboardPage() {
  return (
    <DashboardPageShell>
      <OwnerHomeView />
    </DashboardPageShell>
  );
}
