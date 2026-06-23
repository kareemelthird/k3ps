import { getTranslations } from 'next-intl/server';
import { LoginForm } from '@/components/auth/LoginForm';

/**
 * W1 Login page — design spec §W1
 * Centered card on bg, e3 elevation, max-width ~400px.
 * Dynamic page (auth state not known at build time).
 */
export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const t = await getTranslations('auth');

  return (
    <div className="min-h-dvh bg-bg flex items-center justify-center px-xl py-2xl">
      {/* Login card: surface, e3 elevation, rounded-lg, max ~400px */}
      <div className="w-full max-w-[400px] bg-surface rounded-lg shadow-e3 border border-border p-2xl flex flex-col gap-xl">
        {/* Brand mark — not mirrored in RTL (design-system §6) */}
        <div className="flex flex-col items-center gap-sm" dir="ltr">
          <div
            className="w-12 h-12 rounded-md bg-primary flex items-center justify-center"
            aria-hidden="true"
          >
            <svg
              width="28"
              height="28"
              viewBox="0 0 28 28"
              fill="none"
              aria-hidden="true"
            >
              <rect x="4" y="4" width="8" height="8" rx="2" fill="currentColor" className="text-on-primary" />
              <rect x="16" y="4" width="8" height="8" rx="2" fill="currentColor" className="text-on-primary" />
              <rect x="4" y="16" width="8" height="8" rx="2" fill="currentColor" className="text-on-primary" />
              <rect x="16" y="16" width="8" height="8" rx="2" fill="currentColor" className="text-on-primary" opacity="0.5" />
            </svg>
          </div>
        </div>

        {/* Title — RTL text, start-aligned */}
        <h1 className="text-h1 text-text text-start">{t('signIn.title')}</h1>

        <LoginForm />
      </div>
    </div>
  );
}
