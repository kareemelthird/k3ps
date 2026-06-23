import { redirect } from 'next/navigation';

/**
 * Root page: redirect to /login.
 * The middleware handles auth-aware redirects; this is a static fallback.
 */
export default function RootPage() {
  redirect('/login');
}
