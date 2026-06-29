'use client';

/**
 * global-error.tsx — top-level React error boundary for the App Router.
 *
 * Captures unhandled render errors via Sentry (no-op when not initialised).
 * Renders a minimal Arabic/RTL recovery UI. Strings are hardcoded here because
 * the i18n / auth providers are unavailable at this error-boundary level
 * (this component is the fallback when those providers themselves fail).
 *
 * ADR-0011 §Q1 — `captureException` is a no-op if no DSN was configured.
 */

import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';

interface GlobalErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  useEffect(() => {
    // No-op when Sentry was not initialised (no DSN present).
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="ar" dir="rtl">
      <body
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100dvh',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          background: '#0F111A',
          color: '#E2E8F0',
          gap: '1rem',
          textAlign: 'center',
          padding: '2rem',
          margin: 0,
        }}
      >
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, margin: 0 }}>
          حدث خطأ غير متوقع
        </h1>
        <p style={{ color: '#94A3B8', margin: 0 }}>
          يُرجى المحاولة مرة أخرى.
        </p>
        <button
          onClick={reset}
          style={{
            padding: '0.5rem 1.5rem',
            background: '#7C3AED',
            color: '#fff',
            border: 'none',
            borderRadius: '0.375rem',
            cursor: 'pointer',
            fontSize: '1rem',
            fontFamily: 'inherit',
          }}
        >
          إعادة المحاولة
        </button>
      </body>
    </html>
  );
}
