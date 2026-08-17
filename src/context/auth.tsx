import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

import { API_BASE_URL } from "@/constants/api";
import { clearAllTables } from "@/db/client";

type User = { email: string; username: string };
type Session = User & { token: string };

type AuthContextValue = {
  user: User | null;
  token: string | null;
  loading: boolean;
  login: (emailOrUsername: string, password: string) => Promise<void>;
  signup: (email: string, username: string, password: string) => Promise<void>;
  logout: () => void;
  sessionExpired: () => void;
  refreshToken: (newToken: string) => void;
  deleteAccount: () => Promise<void>;
};

// Keychain/Keystore-backed, not AsyncStorage - this holds a real credential
// (the JWT) now, not just a session pointer, so it needs the OS's secure
// storage rather than plain unencrypted key-value storage.
const SESSION_KEY = "words_session";

// Plain AsyncStorage, deliberately not SecureStore - the point of this key
// is that it's guaranteed gone after an uninstall, on both platforms, unlike
// SESSION_KEY above. iOS Keychain items are intentionally NOT tied to the
// app's own install/uninstall lifecycle (that's Apple's documented,
// deliberate behavior, not a bug) - so without this check, deleting the app
// and redownloading it on iOS would silently restore the old session and
// skip the login screen, even though it's a fresh install from the user's
// perspective. Missing this marker means exactly that happened (or this is
// a genuine first-ever launch, where there's nothing to clear anyway) -
// either way, drop whatever SESSION_KEY still has and start logged out.
const FRESH_INSTALL_MARKER_KEY = "words_installed";

const AuthContext = createContext<AuthContextValue | null>(null);

async function callAuthApi(
  path: "login" | "signup",
  body: unknown,
): Promise<{ token: string; user: User }> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}/api/auth/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    // fetch() itself throwing means the request never reached the network at
    // all (no connection, DNS failure, etc.) - worth telling apart in the
    // log from the server actually responding with an error below.
    console.error(`[auth] ${path} request failed`, error);
    throw error;
  }
  const data = await res.json().catch((error) => {
    console.error(`[auth] ${path} response wasn't valid JSON`, error);
    throw error;
  });
  if (!res.ok) {
    console.error(`[auth] ${path} rejected`, res.status, data);
    throw new Error(data.error ?? "something went wrong");
  }
  return data;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const installed = await AsyncStorage.getItem(FRESH_INSTALL_MARKER_KEY);
      if (!installed) {
        // See FRESH_INSTALL_MARKER_KEY's own comment - clears out whatever
        // SESSION_KEY iOS's Keychain may have carried over from a previous
        // install of this app.
        await SecureStore.deleteItemAsync(SESSION_KEY);
        await AsyncStorage.setItem(FRESH_INSTALL_MARKER_KEY, "1");
        setLoading(false);
        return;
      }
      const raw = await SecureStore.getItemAsync(SESSION_KEY);
      if (raw) setSession(JSON.parse(raw));
      setLoading(false);
    })();
  }, []);

  const login = useCallback(
    async (emailOrUsername: string, password: string) => {
      const data = await callAuthApi("login", { emailOrUsername, password });
      const next: Session = { ...data.user, token: data.token };
      await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(next));
      setSession(next);
    },
    [],
  );

  const signup = useCallback(
    async (email: string, username: string, password: string) => {
      const data = await callAuthApi("signup", { email, username, password });
      const next: Session = { ...data.user, token: data.token };
      await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(next));
      setSession(next);
    },
    [],
  );

  const logout = useCallback(async () => {
    // Local tables carry no user_id, so an account switch has to start from a
    // clean slate rather than relying on filtering to keep accounts apart -
    // see clearAllTables in db/client.ts.
    await clearAllTables();
    await SecureStore.deleteItemAsync(SESSION_KEY);
    setSession(null);
  }, []);

  // Fires when the server rejects our token outright (see
  // setUnauthorizedHandler in db/sync.ts, wired up in _layout.tsx) - this is
  // involuntary, not the user choosing to switch accounts, so unlike logout
  // above it deliberately does NOT call clearAllTables(). The overwhelmingly
  // likely next step is logging back into this exact same account, and
  // wiping local tables here would permanently lose anything that hadn't
  // made it to the server yet, for no real benefit - logout()'s
  // account-isolation guarantee only actually matters if a *different*
  // account logs in next.
  const sessionExpired = useCallback(async () => {
    await SecureStore.deleteItemAsync(SESSION_KEY);
    setSession(null);
  }, []);

  // Fires when sync+api.ts's sliding-refresh check decides the current
  // token is close enough to its 30-day expiry to reissue one (see
  // setTokenRefreshedHandler in db/sync.ts, wired up in _layout.tsx) -
  // swaps just the token in place, keeping the same user/email, so this
  // never touches the UI or interrupts whatever the user's doing.
  const refreshToken = useCallback((newToken: string) => {
    setSession((prev) => {
      if (!prev) return prev;
      const next = { ...prev, token: newToken };
      SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(next)).catch(
        (error) => console.error('[auth] failed to persist refreshed token', error),
      );
      return next;
    });
  }, []);

  // Server-side delete cascades to every other table (see api/account+api.ts),
  // so the local cleanup afterward is identical to a normal logout. Throws on
  // failure instead of clearing local state regardless - if the server call
  // didn't actually succeed, wiping the device's copy would be the one place
  // this data still exists.
  const deleteAccount = useCallback(async () => {
    if (!session) return;
    const res = await fetch(`${API_BASE_URL}/api/account`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${session.token}` },
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? "something went wrong");
    }
    await clearAllTables();
    await SecureStore.deleteItemAsync(SESSION_KEY);
    setSession(null);
  }, [session]);

  const user = session
    ? { email: session.email, username: session.username }
    : null;

  return (
    <AuthContext
      value={{
        user,
        token: session?.token ?? null,
        loading,
        login,
        signup,
        logout,
        sessionExpired,
        refreshToken,
        deleteAccount,
      }}
    >
      {children}
    </AuthContext>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
