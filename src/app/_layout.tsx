import { useRouter } from "expo-router";
import { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import AuthScreen from "@/components/auth-screen";
import AppTabs from "@/components/app-tabs";
import { AuthProvider, useAuth } from "@/context/auth";
import { CollectionProvider } from "@/context/collection";
import { FollowsProvider } from "@/context/follows";
import { ThemeProvider } from "@/context/theme";
import { setTokenRefreshedHandler, setUnauthorizedHandler } from "@/db/sync";
import { useTheme } from "@/hooks/use-theme";
import {
  attachNotificationTapListener,
  registerForPushNotifications,
} from "@/lib/push-notifications";

function Root() {
  const { user, token, loading, sessionExpired, refreshToken } = useAuth();
  const router = useRouter();

  // Covers login, signup, and a restored session on launch uniformly -
  // user/token all become truthy the same way in every case, same trigger
  // the two effects below already use. Re-registers on every token refresh
  // too (harmless - push-tokens+api.ts's ON CONFLICT just bumps
  // created_at), simpler than trying to fire this only once per login.
  useEffect(() => {
    if (user && token) registerForPushNotifications(token);
  }, [user, token]);

  // Tapping a delivered push - the OS already opens/foregrounds the app on
  // its own for any tap, this just lands it on the explore tab specifically
  // rather than wherever it happened to be. Guarded on user/token since
  // AppTabs (and so the "explore" route itself) is only mounted below once
  // logged in - a stale token left registered from before a logout could
  // otherwise still receive a push and try to navigate to a route that
  // doesn't exist yet.
  useEffect(() => {
    return attachNotificationTapListener(() => {
      if (user && token) router.push("/explore");
    });
  }, [router, user, token]);

  // The very first push/pull after opening the app (see CollectionProvider's
  // own mount effect) is also the first place a token that's expired since
  // the last session would actually get noticed - the server rejects it,
  // sendPush sees the 401 and calls this, and sessionExpired drops back to
  // AuthScreen below on the next render. Registered here (not inside
  // CollectionProvider itself) since this is the one place with direct
  // access to both a stable auth action and the fact that a 401 can only
  // ever mean "this session," never "this specific screen."
  useEffect(() => {
    setUnauthorizedHandler(() => sessionExpired());
    return () => setUnauthorizedHandler(null);
  }, [sessionExpired]);

  // Same wiring, other direction - a sync call that comes back with a
  // renewed token (see sync+api.ts's sliding-refresh threshold) updates the
  // stored session here, which flows straight back down through the `token`
  // prop below on the next render.
  useEffect(() => {
    setTokenRefreshedHandler((newToken) => refreshToken(newToken));
    return () => setTokenRefreshedHandler(null);
  }, [refreshToken]);

  if (loading) return null;
  if (!user || !token) return <AuthScreen />;
  return (
    <CollectionProvider email={user.email} token={token}>
      <FollowsProvider token={token}>
        <AppTabs />
      </FollowsProvider>
    </CollectionProvider>
  );
}

// Themed background applied here (not inline in RootLayout's own return)
// since useTheme() requires a ThemeProvider ancestor, and RootLayout is the
// component that renders ThemeProvider, not a descendant of it.
function ThemedGestureRoot() {
  const theme = useTheme();
  return (
    <GestureHandlerRootView
      style={{ flex: 1, backgroundColor: theme.background }}
    >
      <Root />
    </GestureHandlerRootView>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <AuthProvider>
          <ThemedGestureRoot />
        </AuthProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
