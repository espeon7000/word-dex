import * as Sentry from "@sentry/react-native";

// Drop-in replacement for console.error - logs exactly the same as before
// (so nothing about local debugging output changes), but also reports to
// Sentry, which plain console.error never did on its own. Sentry.wrap
// (see _layout.tsx) only catches errors that reach it *unhandled* - a
// try/catch that logs and moves on is, by definition, handled, so it's
// invisible to Sentry's automatic capture no matter which file it's in.
// Anything worth console.error-ing here is worth this instead.
//
// Picks the first Error-typed argument (there may be extra context args
// before or after it) for Sentry.captureException; if none of the
// arguments are an actual Error (eg. logging a rejected response's status
// code rather than a caught exception), falls back to captureMessage with
// everything joined into one string instead.
export function reportError(...args: unknown[]): void {
  console.error(...args);
  const error = args.find((a): a is Error => a instanceof Error);
  if (error) {
    Sentry.captureException(error);
  } else {
    Sentry.captureMessage(
      args
        .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
        .join(" "),
    );
  }
}
