/**
 * Root index — redirects based on auth state and branch selection.
 * Unauthenticated → login; authenticated with branch → device grid;
 * authenticated without branch → branch picker.
 */
import { Redirect } from 'expo-router';

import { useAuth } from '../src/stores/useAuth';

export default function Index() {
  const { session, activeBranchId, isReady } = useAuth();

  if (!isReady) return null;

  if (!session) {
    return <Redirect href="/(auth)/login" />;
  }

  if (!activeBranchId) {
    return <Redirect href="/(operate)/select-branch" />;
  }

  return <Redirect href="/(operate)/devices" />;
}
