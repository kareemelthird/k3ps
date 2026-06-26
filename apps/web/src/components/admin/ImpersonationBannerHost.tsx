'use client';

/**
 * ImpersonationBannerHost — mounts in root layout.
 *
 * Reads impersonation state from AuthContext and conditionally renders
 * ImpersonationBanner + ImpersonationEndDialog + ImpersonationExpiredInterstitial.
 * The host itself is the single point of impersonation UX state management.
 *
 * SAFETY: Never hidden while impersonation is active (CLAUDE.md §2.2 / AC 24).
 * On session expiry (remainingSecs === 0) shows the non-dismissible expired interstitial.
 *
 * FIX (expiry ordering): `showExpired` is set BEFORE `refreshSession()` and the
 * expired interstitial is rendered BEFORE the `!isImpersonating` early-return.
 * This ensures the safety screen appears even after the JWT claims are cleared.
 *
 * The edge function `end-impersonation` is called server-side; client calls anon function
 * URL — NEVER puts the service-role key in the browser (CLAUDE.md §5).
 */

import { useState, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth/AuthContext';
import { ImpersonationBanner } from './ImpersonationBanner';
import { ImpersonationEndDialog } from './ImpersonationEndDialog';
import { ImpersonationExpiredInterstitial } from './ImpersonationExpiredInterstitial';
import { getBrowserClient } from '@/lib/supabase/client';

export function ImpersonationBannerHost() {
  const { claim, refreshSession } = useAuth();
  const t = useTranslations('admin');
  const router = useRouter();

  const [showEndDialog, setShowEndDialog] = useState(false);
  const [showExpired, setShowExpired] = useState(false);
  /**
   * Captures the tenant name at the moment expiry fires, so the interstitial
   * can display it even after the JWT claims are cleared by refreshSession().
   */
  const [expiredTenantName, setExpiredTenantName] = useState('');
  const [endSubmitting, setEndSubmitting] = useState(false);
  const [endError, setEndError] = useState<string | null>(null);

  const isImpersonating =
    claim?.impersonator_id != null && claim?.impersonation_exp != null;

  // Detect expiry: re-check whenever claim updates
  useEffect(() => {
    if (!isImpersonating) return;

    // Capture the display name while we still have it in the claim
    const currentTenantName =
      (claim?.tenant_name ?? (claim?.tenant_id ? claim.tenant_id.slice(0, 8) : '')) ||
      t('impersonate.banner.tenantFallback');

    const expMs = new Date(claim!.impersonation_exp!).getTime();
    const remaining = expMs - Date.now();

    if (remaining <= 0) {
      // Already expired on mount — show interstitial immediately
      setExpiredTenantName(currentTenantName);
      setShowExpired(true);
    } else {
      // Schedule expiry interstitial
      const timer = setTimeout(async () => {
        // CRITICAL ORDER: set showExpired BEFORE refreshSession.
        // refreshSession() clears the impersonation claims → isImpersonating becomes
        // false → the `if (!isImpersonating) return null` guard would hide the
        // interstitial if showExpired were set after. By setting it first, the
        // `if (showExpired)` early-return (below) takes precedence.
        setExpiredTenantName(currentTenantName);
        setShowExpired(true);
        try {
          await refreshSession();
        } catch {
          // ignore — show interstitial regardless
        }
      }, remaining);
      return () => clearTimeout(timer);
    }
  }, [isImpersonating, claim, refreshSession, t]);

  const handleEndNow = useCallback(() => {
    setEndError(null);
    setShowEndDialog(true);
  }, []);

  const handleEndConfirm = useCallback(async () => {
    setEndSubmitting(true);
    setEndError(null);
    try {
      const supabase = getBrowserClient();
      const { error } = await supabase.functions.invoke('end-impersonation', {
        body: {},
      });
      if (error) throw error;
      await refreshSession();
      setShowEndDialog(false);
      router.push('/admin');
    } catch (err) {
      setEndError(
        err instanceof Error ? err.message : t('error.endSession'),
      );
    } finally {
      setEndSubmitting(false);
    }
  }, [refreshSession, router, t]);

  const handleReturnFromExpired = useCallback(async () => {
    setShowExpired(false);
    try {
      await refreshSession();
    } catch {
      // ignore
    }
    router.push('/admin');
  }, [refreshSession, router]);

  // Non-dismissible expiry interstitial rendered OUTSIDE the isImpersonating guard
  // so it appears even after the impersonation claims are cleared from the JWT.
  if (showExpired) {
    return (
      <ImpersonationExpiredInterstitial
        tenantName={expiredTenantName}
        onReturn={() => void handleReturnFromExpired()}
      />
    );
  }

  if (!isImpersonating) return null;

  const tenantName =
    (claim?.tenant_name ?? (claim?.tenant_id ? claim.tenant_id.slice(0, 8) : '')) ||
    t('impersonate.banner.tenantFallback');
  const expiresAtIso = claim!.impersonation_exp!;

  return (
    <>
      {/* Persistent banner — never dismissible while impersonation is active */}
      <ImpersonationBanner
        tenantName={tenantName}
        expiresAtIso={expiresAtIso}
        onEndNow={handleEndNow}
        endNowSubmitting={endSubmitting}
      />

      {/* End confirmation dialog */}
      <ImpersonationEndDialog
        open={showEndDialog}
        tenantName={tenantName}
        submitting={endSubmitting}
        error={endError}
        onConfirm={() => void handleEndConfirm()}
        onCancel={() => {
          setShowEndDialog(false);
          setEndError(null);
        }}
      />
    </>
  );
}
