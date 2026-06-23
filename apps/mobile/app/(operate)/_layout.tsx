/**
 * Operate group layout — guards auth; redirects to login if unauthenticated.
 */
import { Redirect, Stack } from 'expo-router';

import { useAuth } from '../../src/stores/useAuth';
import { colors } from '../../src/design/tokens';

export default function OperateLayout() {
  const { session } = useAuth();

  if (!session) {
    return <Redirect href="/(auth)/login" />;
  }

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.bg },
        animation: 'slide_from_right',
      }}
    />
  );
}
