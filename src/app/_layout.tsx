import { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import * as Sentry from "@sentry/react-native";

import AuthScreen from "@/components/auth-screen";
import AppTabs from "@/components/app-tabs";
import { AuthProvider, useAuth } from "@/context/auth";
import { CollectionProvider } from "@/context/collection";
import { FollowsProvider } from "@/context/follows";
import { ThemeProvider } from "@/context/theme";
import { setTokenRefreshedHandler, setUnauthorizedHandler } from "@/db/sync";
import { useTheme } from "@/hooks/use-theme";

// Crash/error reporting only (no performance tracing - no tracesSampleRate
// set, which leaves it disabled). EXPO_PUBLIC_* so it's readable here in the
// client bundle - a DSN is a public identifier, not a secret, same as any
// other analytics write key.
Sentry.init({
  dsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
});

function Root() {
  const { user, token, loading, sessionExpired, refreshToken } = useAuth();

  // The very first push/pull after opening the app (see CollectionProvider's
  // own mount effect) is also the first place a token that's expired since
  // the last session would actually get noticed - the server rejects it,
  // db/sync.ts's own sendPush (the sync POST, not push notifications) sees
  // the 401 and calls this, and sessionExpired drops back to AuthScreen
  // below on the next render. Registered here (not inside
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

function RootLayout() {
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

// Sentry.wrap adds a top-level error boundary (so a render-time crash still
// reports before the app goes blank) plus its own root-level tracing span -
// harmless with tracing disabled above, just an unused span.
export default Sentry.wrap(RootLayout);
