import { getSql } from "@/server/db";
import { requireAuth } from "@/server/jwt";
import { captureException } from "@/server/sentry";

// Every other table's user data hangs off users.id via ON DELETE CASCADE
// (user_words, user_books, sentences, user_activity, deleted_words directly;
// learn_events transitively through user_words) - a single delete here is
// enough to wipe the whole account server-side.
export async function DELETE(request: Request) {
  try {
    const { userId } = await requireAuth(request);
    const sql = getSql();
    await sql`DELETE FROM users WHERE id = ${userId}`;
    return Response.json({ success: true });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[account] delete error", error);
    await captureException(error, "account:delete");
    return Response.json({ error: "something went wrong" }, { status: 500 });
  }
}
