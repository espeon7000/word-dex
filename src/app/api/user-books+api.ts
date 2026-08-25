import { getSql } from "@/server/db";
import { requireAuth } from "@/server/jwt";
import { captureException } from "@/server/sentry";

// The explore page's read-only "view this user's books" screen, opened by
// tapping any username there (feed cards, follow lists). Same no-privacy-
// gate lookup as follow+api.ts's POST (exact username, no accept/block
// concept in this app) - anyone logged in who knows the username can view
// it, same as anyone can already follow them by it.
export async function GET(request: Request) {
  try {
    await requireAuth(request);
    const url = new URL(request.url);
    const username = url.searchParams.get("username")?.trim();
    if (!username) {
      return Response.json({ error: "username is required" }, { status: 400 });
    }

    const sql = getSql();
    const [target] = await sql`
      SELECT id, avatar FROM users WHERE username = ${username}
    `;
    if (!target) {
      return Response.json({ error: "user not found" }, { status: 404 });
    }

    // Same three shapes context/collection.tsx's own refresh() reads out of
    // local SQLite for the signed-in user's own collection - genre aliased
    // from the category join so this lines up field-for-field with
    // CollectionBook, letting the explore screen's book list reuse the exact
    // same sort/group logic as the collection page's.
    const [books, categories, bookReviews] = await Promise.all([
      sql`
        SELECT ub.id, ub.title, ub.author, ubc.name AS genre, ub.added_at AS "addedAt"
        FROM user_books ub
        LEFT JOIN user_book_categories ubc ON ubc.id = ub.user_book_category_id
        WHERE ub.user_id = ${target.id}
        ORDER BY ub.added_at DESC
      `,
      sql`
        SELECT id, name, added_at AS "addedAt"
        FROM user_book_categories
        WHERE user_id = ${target.id}
        ORDER BY name
      `,
      sql`
        SELECT r.id, r.user_book_id AS "bookId", r.added_at AS "addedAt", r.rating, r.review
        FROM user_book_reviews r
        JOIN user_books b ON b.id = r.user_book_id
        WHERE b.user_id = ${target.id}
        ORDER BY r.added_at DESC
      `,
    ]);

    return Response.json({
      avatar: target.avatar ?? null,
      books,
      categories,
      bookReviews,
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[user-books] error", error);
    await captureException(error, "user-books");
    return Response.json({ error: "something went wrong" }, { status: 500 });
  }
}
