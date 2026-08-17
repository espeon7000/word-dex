import { getSql } from "@/server/db";
import { requireAuth } from "@/server/jwt";

type TargetKind = "review" | "started";

// How far back a reaction "counts" toward the grouped notification text
// ("X and Y loved your review...") - long enough to catch a burst of
// friends reacting close together, short enough that a stale name doesn't
// linger in the aggregate for hours. Independent of the client's own
// reaction-cache TTL (src/lib/reaction-cache.ts) - that one gates whether a
// *tap* fires a request at all; this one only shapes notification text.
const GROUPING_WINDOW = "90 minutes";
const MAX_NAMED_REACTORS = 3;

function groupedText(
  kind: TargetKind,
  title: string,
  usernames: string[],
  total: number,
): string {
  const subject =
    total === 1
      ? usernames[0]
      : total === 2
        ? `${usernames[0]} and ${usernames[1]}`
        : `${usernames[0]}, ${usernames[1]}, and ${total - 2} others`;
  return kind === "review"
    ? `${subject} loved your review on ${title}`
    : `${subject} ${total === 1 ? "is" : "are"} cheering you on`;
}

// Fire-and-await, not fire-and-forget - EAS Hosting's edge runtime gives no
// guarantee a dangling promise finishes after the response is sent, so a
// truly fire-and-forget push here would silently drop sometimes. Failures
// are swallowed (logged only) since a push failing shouldn't fail the
// reaction itself - the reaction is already committed by the time this runs.
async function sendPush(
  tokens: string[],
  body: string,
  data: Record<string, string>,
  collapseKey: string,
) {
  if (tokens.length === 0) return;
  try {
    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(
        tokens.map((to) => ({
          to,
          title: "word-dex",
          body,
          data,
          sound: "default",
          // groupedText already folds every reactor within GROUPING_WINDOW
          // into one up-to-date string, but without this a burst of
          // reactions still shows up as one push notification *per*
          // reaction - the text just happens to be freshest in the last
          // one. collapseId replaces an already-displayed notification on
          // iOS (not just in-flight ones - that's the part that actually
          // matters here) and coalesces on Android; tag is Android's own
          // "replace what's already shown" field, set to the same key so
          // both platforms end up showing just the single latest
          // notification for this target instead of a stack of them.
          collapseId: collapseKey,
          tag: collapseKey,
        })),
      ),
    });
  } catch (error) {
    console.error("[reactions] push send failed", error);
  }
}

// Double-tapping a review or started-reading row in the explore feed. No
// server-side "already reacted" dedup by design - the reactions table is a
// plain insert-only event log (needed anyway to know who to notify and to
// build the grouped text), and the only spam gate is the client's own
// ephemeral local cache (see reaction-cache.ts). A reinstall, second
// device, or the local cache simply expiring can all lead to a repeat
// reaction landing here - that's an accepted tradeoff, not a bug.
export async function POST(request: Request) {
  try {
    const { userId: reactorId } = await requireAuth(request);
    const { targetKind, targetId } = await request.json();
    if (
      (targetKind !== "review" && targetKind !== "started") ||
      typeof targetId !== "string" ||
      !targetId
    ) {
      return Response.json(
        { error: "targetKind and targetId are required" },
        { status: 400 },
      );
    }

    const sql = getSql();
    const [target] =
      targetKind === "started"
        ? await sql`
            SELECT user_id AS "ownerId", title, author
            FROM user_books
            WHERE id = ${targetId}
          `
        : await sql`
            SELECT ub.user_id AS "ownerId", ub.title, ub.author
            FROM user_book_reviews ubr
            JOIN user_books ub ON ub.id = ubr.user_book_id
            WHERE ubr.id = ${targetId}
          `;
    if (!target) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    // Neon returns users.id (bigint) as a string - see follow+api.ts's own
    // comment on the same gotcha.
    if (String(target.ownerId) === String(reactorId)) {
      return Response.json({ ok: true });
    }

    await sql`
      INSERT INTO reactions (target_kind, target_id, reactor_id)
      VALUES (${targetKind}, ${targetId}, ${reactorId})
    `;

    const reactors = await sql`
      SELECT u.username, COUNT(*) OVER() AS total
      FROM reactions r
      JOIN users u ON u.id = r.reactor_id
      WHERE r.target_kind = ${targetKind} AND r.target_id = ${targetId}
        AND r.created_at >= now() - ${GROUPING_WINDOW}::interval
      ORDER BY r.created_at DESC
      LIMIT ${MAX_NAMED_REACTORS}
    `;
    const usernames = reactors.map((r) => r.username as string);
    const total = reactors.length > 0 ? Number(reactors[0].total) : 1;
    const body = groupedText(targetKind, target.title, usernames, total);

    const tokenRows = await sql`
      SELECT token FROM push_tokens WHERE user_id = ${target.ownerId}
    `;
    await sendPush(
      tokenRows.map((r) => r.token as string),
      body,
      { targetKind, targetId },
      `reaction:${targetKind}:${targetId}`,
    );

    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[reactions] error", error);
    return Response.json({ error: "something went wrong" }, { status: 500 });
  }
}
