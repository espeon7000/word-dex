import { getSql } from "@/server/db";
import { requireAuth } from "@/server/jwt";

// Double-tapping a review or started-reading row in the explore feed. No
// server-side "already reacted" dedup by design - the reactions table is a
// plain insert-only event log, and the only spam gate is the client's own
// ephemeral local cache (see reaction-cache.ts). A reinstall, second
// device, or the local cache simply expiring can all lead to a repeat
// reaction landing here - that's an accepted tradeoff, not a bug.
//
// Deliberately no push notification for a reaction landing here - liking a
// post is high-frequency and low-signal compared to the activity/follow
// notifications in sync+api.ts and follow+api.ts, so it's a silent,
// in-feed-only interaction (the flying heart is the only feedback).
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
            SELECT user_id AS "ownerId"
            FROM user_books
            WHERE id = ${targetId}
          `
        : await sql`
            SELECT ub.user_id AS "ownerId"
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

    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[reactions] error", error);
    return Response.json({ error: "something went wrong" }, { status: 500 });
  }
}
