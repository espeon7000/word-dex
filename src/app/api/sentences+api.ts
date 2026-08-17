import { getSql } from "@/server/db";
import { requireAuth } from "@/server/jwt";

// Discover page's "example usage" section - the 3 most recent sentences
// written for this word by any user (not just the caller's own), newest
// first. Read-only and cross-user, unlike every other sentences access in
// this app (sync+api.ts only ever pushes rows into this table, never pulls
// them back down per-account) - this is the one place the table is queried
// back out.
export async function GET(request: Request) {
  try {
    await requireAuth(request);
    const url = new URL(request.url);
    const word = url.searchParams.get("word")?.trim().toLowerCase();
    if (!word) {
      return Response.json({ error: "word is required" }, { status: 400 });
    }
    const sql = getSql();
    const rows = await sql`
      SELECT body FROM sentences
      WHERE word = ${word}
      ORDER BY created_at DESC
      LIMIT 3
    `;
    return Response.json({
      sentences: rows.map((r) => (r as { body: string }).body),
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[sentences] fetch error", error);
    return Response.json({ error: "something went wrong" }, { status: 500 });
  }
}
