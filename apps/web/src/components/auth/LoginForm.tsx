'use client';

/**
 * LoginForm — W1 (design spec §W1)
 * Email/password sign-in via Supabase. Four states: empty · loading · error · offline.
 * On success the middleware redirects to /dashboard.
 */
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth/AuthContext';
import { TextField } from '@/components/ui/TextField';
import { Button } from '@/components/ui/Button';

export function LoginForm() {
  const t = useTranslations('auth');
  const tAction = useTranslations('action');
  const { signIn } = useAuth();
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const emailRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const { error: signInError } = await signIn(email, password);

    setLoading(false);

    if (signInError) {
      // Map error to user-friendly i18n key
      const msg = signInError.toLowerCase();
      if (msg.includes('invalid') || msg.includes('credentials') || msg.includes('password')) {
        setError(t('error.invalidCredentials'));
      } else if (msg.includes('tenant') || msg.includes('app_metadata')) {
        setError(t('error.noTenant'));
      } else {
        setError(t('error.generic'));
      }
      // Re-focus the email field (focus-management)
      emailRef.current?.focus();
      return;
    }

    // Success: middleware handles the redirect, but we push just in case
    router.push('/dashboard');
  }

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      className="flex flex-col gap-md"
      aria-label={t('signIn.title')}
    >
      <TextField
        ref={emailRef}
        label={t('email')}
        type="email"
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        disabled={loading}
      />

      <TextField
        label={t('password')}
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
        disabled={loading}
      />

      {/* Inline error — below the form, role=alert for screen readers */}
      {error && (
        <div
          role="alert"
          aria-live="assertive"
          className="rounded-xs px-md py-sm bg-[#EF44441A] border border-danger text-caption text-danger text-start"
        >
          {error}
        </div>
      )}

      <Button
        type="submit"
        variant="primary"
        size="lg"
        fullWidth
        loading={loading}
        disabled={loading}
      >
        {t('signIn.cta')}
      </Button>

      <button
        type="button"
        className="text-label text-text-muted hover:text-text transition-colors mt-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-xs px-2"
        onClick={() => {/* Forgot password — Phase 6+ */}}
      >
        {t('forgotPassword')}
      </button>
    </form>
  );
}
