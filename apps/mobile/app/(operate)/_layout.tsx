/**
 * Operate group layout — guards auth; redirects to login if unauthenticated.
 * Phase 5: adds bottom-tab navigation for Devices / Orders / Stock / Shift.
 */
import { Redirect, Tabs } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../../src/stores/useAuth';
import { colors, fontSize } from '../../src/design/tokens';
import { AppText } from '../../src/components/AppText';

function TabLabel({ label, focused }: { label: string; focused: boolean }) {
  return (
    <AppText
      role="micro"
      color={focused ? colors.primary : colors.textFaint}
    >
      {label}
    </AppText>
  );
}

export default function OperateLayout() {
  const { session } = useAuth();
  const { t } = useTranslation();

  if (!session) {
    return <Redirect href="/(auth)/login" />;
  }

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          borderTopWidth: 1,
        },
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textFaint,
        tabBarLabelStyle: { fontSize: fontSize.micro },
        tabBarShowLabel: true,
      }}
    >
      <Tabs.Screen
        name="devices"
        options={{
          tabBarLabel: ({ focused }) => (
            <TabLabel label={t('nav.devices')} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="orders"
        options={{
          tabBarLabel: ({ focused }) => (
            <TabLabel label={t('nav.orders')} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="stock"
        options={{
          tabBarLabel: ({ focused }) => (
            <TabLabel label={t('nav.stock')} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="shift"
        options={{
          tabBarLabel: ({ focused }) => (
            <TabLabel label={t('nav.shift')} focused={focused} />
          ),
        }}
      />
      {/* Session detail stays as a full-screen modal pushed from devices */}
      <Tabs.Screen
        name="session/[id]"
        options={{
          href: null, // hidden from tab bar
        }}
      />
      {/* Branch selector is also accessed from devices, not a tab */}
      <Tabs.Screen
        name="select-branch"
        options={{
          href: null,
        }}
      />
    </Tabs>
  );
}
