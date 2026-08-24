// A module-level slot for the current session's auth token - mirrors
// db/sync.ts's own onUnauthorized/onTokenRefreshed handler-registry pattern.
// Exists so plain utility modules that sit outside any component tree (or,
// like context/theme.tsx's ThemeProvider, sit *above* AuthProvider in it and
// so can't call useAuth() themselves) can still reach the current token to
// call an authenticated API route, without being rewritten as hooks or
// having the token threaded through every call site as a parameter. Kept in
// its own file rather than sync.ts since those two modules (lib/mood.ts,
// components/book-prompt.tsx) have nothing else to do with sync.
let currentToken: string | null = null;

export function setCurrentToken(token: string | null): void {
  currentToken = token;
}

export function getCurrentToken(): string | null {
  return currentToken;
}
