import { getSql } from "@/server/db";
import { requireAuth } from "@/server/jwt";
import { captureException } from "@/server/sentry";

// Explore page's activity feed - two kinds of entry, both from anyone the
// current user follows, newest first: reviews, and "started reading" entries
// (one per book, derived from user_books.added_at - there's no separate
// started/finished status column, so a book's own creation time doubles as
// its "started reading" moment). Reviews have no direct user_id column (see
// user_book_reviews' own schema) - the owning user only exists one hop up,
// via the book it's attached to.
//
// A book with at least one review only shows its review(s) - the "started
// reading" entry is suppressed for it (NOT EXISTS below), since a review
// already implies the book was started, and showing both is redundant. Only
// books with zero reviews get a bare "started reading" entry.
//
// Capped to the past 3 months (both branches) - unbounded history means
// every explore-tab load refetches the entire lifetime feed of everyone you
// follow, growing forever. No pagination yet, just a fixed cutoff, until
// that actually proves too small.
export async function GET(request: Request) {
  try {
    const { userId } = await requireAuth(request);
    const sql = getSql();
    const feed = await sql`
      SELECT
        ub.id,
        'started' AS kind,
        NULL::real AS rating,
        NULL::text AS review,
        ub.added_at AS "addedAt",
        u.username,
        u.avatar,
        ub.title,
        ub.author
      FROM follows f
      JOIN user_books ub ON ub.user_id = f.followee_id
      JOIN users u ON u.id = f.followee_id
      WHERE f.follower_id = ${userId}
        AND ub.added_at >= now() - interval '3 months'
        AND NOT EXISTS (
          SELECT 1 FROM user_book_reviews r WHERE r.user_book_id = ub.id
        )

      UNION ALL

      SELECT
        ubr.id,
        'review' AS kind,
        ubr.rating,
        ubr.review,
        ubr.added_at AS "addedAt",
        u.username,
        u.avatar,
        ub.title,
        ub.author
      FROM follows f
      JOIN user_books ub ON ub.user_id = f.followee_id
      JOIN user_book_reviews ubr ON ubr.user_book_id = ub.id
      JOIN users u ON u.id = f.followee_id
      WHERE f.follower_id = ${userId}
        AND ubr.added_at >= now() - interval '3 months'

      ORDER BY "addedAt" DESC
    `;
    return Response.json({ feed });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[reviews] error", error);
    await captureException(error, "reviews");
    return Response.json({ error: "something went wrong" }, { status: 500 });
  }
}
