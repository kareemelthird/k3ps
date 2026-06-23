/**
 * Login screen — M1 (design spec §M1).
 * Email/password sign-in via Supabase. All strings via t(). RTL.
 * No hardcoded user strings. Four states: empty / loading / error / offline.
 */
import React, { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../../src/stores/useAuth';
import { useSync } from '../../src/stores/useSync';
import { supabase } from '../../src/lib/supabase';
import { colors, spacing } from '../../src/design/tokens';
import { AppText } from '../../src/components/AppText';
import { Button } from '../../src/components/Button';
import { ErrorState } from '../../src/components/ErrorState';
import { OfflineBanner } from '../../src/components/OfflineBanner';
import { TextField } from '../../src/components/TextField';

export default function LoginScreen() {
  const { t } = useTranslation();
  const { online } = useSync();
  const { setSession } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!online) return;
    setError(null);
    setEmailError(null);

    if (!email.trim()) {
      setEmailError(t('auth.error.invalidCredentials'));
      return;
    }

    setLoading(true);
    try {
      const { data, error: authError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (authError) {
        setError(t('auth.error.invalidCredentials'));
        return;
      }

      if (!data.session) {
        setError(t('auth.error.generic'));
        return;
      }

      // Validate that the JWT has the tenant claim (stamped by the Custom Access Token Hook)
      const meta = data.session.user?.app_metadata as Record<string, unknown> | undefined;
      if (!meta?.tenant_id) {
        setError(t('auth.error.noTenant'));
        return;
      }

      setSession(data.session);
    } catch {
      setError(t('auth.error.generic'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.screen}>
      <OfflineBanner />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.kav}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {/* Brand mark */}
          <View style={styles.brand}>
            <AppText role="h1" align="center" color={colors.primary}>
              PS
            </AppText>
            <AppText role="h2" align="center" color={colors.textMuted}>
              Management
            </AppText>
          </View>

          {/* Title */}
          <AppText role="h1" style={styles.title}>
            {t('auth.signIn.title')}
          </AppText>

          {/* Form */}
          <View style={styles.form}>
            <TextField
              label={t('auth.email')}
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
              textContentType="username"
              error={emailError ?? undefined}
              required
              editable={!loading}
            />

            <TextField
              label={t('auth.password')}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              showPasswordToggle
              autoComplete="password"
              textContentType="password"
              editable={!loading}
            />

            {/* Auth error — inline, near the form */}
            {error && (
              <View accessibilityRole="alert" accessible>
                <AppText role="caption" color={colors.danger}>
                  {error}
                </AppText>
              </View>
            )}

            <Button
              variant="primary"
              size="lg"
              fullWidth
              loading={loading}
              disabled={!online || loading}
              onPress={handleSubmit}
              accessibilityLabel={t('auth.signIn.cta')}
            >
              {t('auth.signIn.cta')}
            </Button>

            {!online && (
              <AppText role="caption" color={colors.textFaint} align="center">
                {t('auth.offline')}
              </AppText>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  kav: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.xl,
  },
  brand: {
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.lg,
  },
  title: {
    textAlign: 'right', // RTL
    marginBottom: spacing.sm,
  },
  form: {
    gap: spacing.md,
  },
});
