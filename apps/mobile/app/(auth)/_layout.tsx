/**
 * Auth group layout — unprotected; redirect away if already authenticated.
 */
import { Redirect, Stack } from 'expo-router';

import { useAuth } from '../../src/stores/useAuth';
import { colors } from '../../src/design/tokens';

export default function AuthLayout() {
  const { session, activeBranchId } = useAuth();

  if (session) {
    if (activeBranchId) {
      return <Redirect href="/(operate)/devices" />;
    }
    return <Redirect href="/(operate)/select-branch" />;
  }

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.bg },
      }}
    />
  );
}
