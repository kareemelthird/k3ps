/**
 * Admin route layout — wraps all /admin/* pages.
 *
 * Intentionally thin: the AdminShell client component owns the actual
 * sidebar + role-gate rendering. This file exists only so Next.js App Router
 * can apply the layout segment for the /admin subtree.
 */

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
