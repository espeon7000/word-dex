// Minimal Sentry error reporter for the API routes - no @sentry/* SDK
// dependency here. Those assume Node-only APIs (crypto, timers,
// AsyncLocalStorage-based scoping) this Cloudflare Workers runtime doesn't
// guarantee, and even @sentry/cloudflare's own integration expects to wrap
// the raw Workers fetch handler - something EAS Hosting owns internally,
// not something an Expo Router API route gets access to. Talking straight
// to Sentry's envelope ingestion endpoint over fetch sidesteps all of
// that - same reasoning the old src/lib/push-notifications.ts server side
// had for hitting Expo's push REST API directly instead of a client
// library.
//
// Only ever called from a route's catch-all error branch (once per failed
// request, not per DB query), so this doesn't reintroduce the
// per-subrequest blowup that made sync+api.ts hit Cloudflare Workers'
// subrequest limit (see that file's own history) - it's the same shape as
// any other single outbound fetch a route already makes.

function parseDsn(
  dsn: string,
): { host: string; key: string; projectId: string } | null {
  try {
    const url = new URL(dsn);
    if (!url.username) return null;
    return {
      host: url.host,
      key: url.username,
      projectId: url.pathname.replace(/^\//, ""),
    };
  } catch {
    return null;
  }
}

// Fire-and-await, not fire-and-forget - EAS Hosting's edge runtime gives no
// guarantee a dangling promise finishes after the response is sent, so
// every call site awaits this before returning its 500. Failures are
// swallowed (logged only) - a report failing shouldn't change what the
// caller returns to the client.
export async function captureException(
  error: unknown,
  route: string,
): Promise<void> {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  const parsed = parseDsn(dsn);
  if (!parsed) return;
  try {
    const { host, key, projectId } = parsed;
    const eventId = crypto.randomUUID().replace(/-/g, "");
    const timestamp = new Date().toISOString();
    const event = {
      event_id: eventId,
      timestamp,
      platform: "node",
      server_name: "eas-hosting",
      tags: { route },
      exception: {
        values: [
          {
            type: error instanceof Error ? error.name : "Error",
            value: error instanceof Error ? error.message : String(error),
          },
        ],
      },
      extra: {
        stack: error instanceof Error ? error.stack : undefined,
      },
    };
    const envelope = [
      JSON.stringify({ event_id: eventId, sent_at: timestamp }),
      JSON.stringify({ type: "event" }),
      JSON.stringify(event),
    ].join("\n");

    await fetch(`https://${host}/api/${projectId}/envelope/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${key}, sentry_client=word-dex-server/0.1`,
      },
      body: envelope,
    });
  } catch (reportError) {
    console.error("[sentry] report failed", reportError);
  }
}
