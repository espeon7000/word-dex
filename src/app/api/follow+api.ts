import { getSql } from "@/server/db";
import { requireAuth } from "@/server/jwt";

// Explore page's followers/following lists - both directions of the same
// edge table, sorted newest-first (most recently followed/followed-by).
export async function GET(request: Request) {
  try {
    const { userId } = await requireAuth(request);
    const sql = getSql();
    const [followers, following] = await Promise.all([
      sql`
        SELECT u.username, f.created_at AS "followedAt"
        FROM follows f
        JOIN users u ON u.id = f.follower_id
        WHERE f.followee_id = ${userId}
        ORDER BY f.created_at DESC
      `,
      sql`
        SELECT u.username, f.created_at AS "followedAt"
        FROM follows f
        JOIN users u ON u.id = f.followee_id
        WHERE f.follower_id = ${userId}
        ORDER BY f.created_at DESC
      `,
    ]);
    return Response.json({ followers, following });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[follow] list error", error);
    return Response.json({ error: "something went wrong" }, { status: 500 });
  }
}

// Follows a user by exact username match - the explore page's "+" flow
// deliberately requires the exact username (no fuzzy/partial search), so
// this is a single lookup, not a search endpoint.
export async function POST(request: Request) {
  try {
    const { userId } = await requireAuth(request);
    const { username } = await request.json();
    if (typeof username !== "string" || !username.trim()) {
      return Response.json({ error: "username is required" }, { status: 400 });
    }

    const sql = getSql();
    const [target] = await sql`
      SELECT id FROM users WHERE username = ${username.trim()}
    `;
    if (!target) {
      return Response.json({ error: "user not found" }, { status: 404 });
    }
    // Neon's driver returns bigint columns (users.id) as strings, not
    // numbers, to avoid precision loss - requireAuth's userId is a real
    // number (see jwt.ts's Number(payload.sub)), so comparing them directly
    // would always be false even for a genuine self-follow attempt.
    if (String(target.id) === String(userId)) {
      return Response.json(
        { error: "cannot follow yourself" },
        { status: 400 },
      );
    }

    // ON CONFLICT DO NOTHING - already following is a no-op, not an error,
    // since the primary key (follower_id, followee_id) is exactly "already
    // following this person."
    await sql`
      INSERT INTO follows (follower_id, followee_id)
      VALUES (${userId}, ${target.id})
      ON CONFLICT DO NOTHING
    `;
    return Response.json({ success: true });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[follow] error", error);
    return Response.json({ error: "something went wrong" }, { status: 500 });
  }
}

// Swipe-to-delete on the explore page's followers/following lists -
// "direction" is which list the swipe happened in, not a database concept:
// "following" unfollows (I'm follower_id, they're followee_id), "followers"
// removes them as a follower of me (they're follower_id, I'm followee_id).
// Plain hard delete, no tombstone - see the earlier design discussion for
// why (follows never goes through local SQLite/sync, so there's no
// offline-cursor problem a tombstone would be solving here).
export async function DELETE(request: Request) {
  try {
    const { userId } = await requireAuth(request);
    const { username, direction } = await request.json();
    if (
      typeof username !== "string" ||
      !username.trim() ||
      (direction !== "following" && direction !== "followers")
    ) {
      return Response.json(
        { error: "username and direction are required" },
        { status: 400 },
      );
    }

    const sql = getSql();
    const [target] = await sql`
      SELECT id FROM users WHERE username = ${username.trim()}
    `;
    if (!target) {
      return Response.json({ error: "user not found" }, { status: 404 });
    }

    if (direction === "following") {
      await sql`
        DELETE FROM follows
        WHERE follower_id = ${userId} AND followee_id = ${target.id}
      `;
    } else {
      await sql`
        DELETE FROM follows
        WHERE follower_id = ${target.id} AND followee_id = ${userId}
      `;
    }
    return Response.json({ success: true });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[follow] delete error", error);
    return Response.json({ error: "something went wrong" }, { status: 500 });
  }
}
