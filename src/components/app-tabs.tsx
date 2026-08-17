import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '@/hooks/use-theme';

export default function AppTabs() {
  const theme = useTheme();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.text,
        tabBarInactiveTintColor: theme.textSecondary,
        tabBarStyle: { backgroundColor: theme.backgroundElement, borderTopColor: theme.separator },
        tabBarShowLabel: false,
        tabBarIconStyle: { marginTop: 4 },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ href: null }}
      />
      <Tabs.Screen
        name="discover"
        options={{
          title: 'discover',
          tabBarIcon: ({ color }) => <Ionicons name="search" size={28} color={color} />,
        }}
      />
      <Tabs.Screen
        name="explore"
        options={{
          title: 'explore',
          tabBarIcon: ({ color }) => <Ionicons name="people-outline" size={28} color={color} />,
        }}
      />
      <Tabs.Screen
        name="learn"
        options={{
          title: 'learn',
          tabBarIcon: ({ color }) => <Ionicons name="bulb-outline" size={28} color={color} />,
        }}
      />
      <Tabs.Screen
        name="collection"
        options={{
          title: 'collection',
          tabBarIcon: ({ color }) => <Ionicons name="library-outline" size={28} color={color} />,
        }}
      />
    </Tabs>
  );
}
