/**
 * Default root page — redirects to the admin/tenants area.
 * The super-admin portal is the primary surface for this app.
 */
import { redirect } from 'next/navigation';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export default async function RootPage({ params }: PageProps) {
  const { locale } = await params;
  redirect(`/${locale}/admin/tenants`);
}
