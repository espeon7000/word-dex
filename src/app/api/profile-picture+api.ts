import { getSql } from "@/server/db";
import { requireAuth } from "@/server/jwt";
import { captureException } from "@/server/sentry";

// Client-side compressed/cropped to a small square JPEG before it ever gets
// here (see the crop modal in components/profile-picture-modal.tsx) - this
// cap is just a backstop against a misbehaving client, not the primary size
// control. ~2MB of base64 text.
const MAX_AVATAR_LENGTH = 2_000_000;

export async function GET(request: Request) {
  try {
    const { userId } = await requireAuth(request);
    const sql = getSql();
    const rows = await sql`SELECT avatar FROM users WHERE id = ${userId}`;
    return Response.json({ avatar: rows[0]?.avatar ?? null });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[profile-picture] get error", error);
    await captureException(error, "profile-picture:get");
    return Response.json({ error: "something went wrong" }, { status: 500 });
  }
}

// Body: { avatar: "data:image/jpeg;base64,..." } - stored as-is (a data
// URI, not raw base64) so it can be dropped directly into an <Image
// source={{ uri }}> on the client with no reconstruction.
export async function PUT(request: Request) {
  try {
    const { userId } = await requireAuth(request);
    const body = await request.json();
    const avatar = body?.avatar;
    if (typeof avatar !== "string" || !avatar.startsWith("data:image/")) {
      return Response.json({ error: "invalid avatar" }, { status: 400 });
    }
    if (avatar.length > MAX_AVATAR_LENGTH) {
      return Response.json({ error: "image too large" }, { status: 400 });
    }
    const sql = getSql();
    await sql`UPDATE users SET avatar = ${avatar} WHERE id = ${userId}`;
    return Response.json({ success: true });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[profile-picture] put error", error);
    await captureException(error, "profile-picture:put");
    return Response.json({ error: "something went wrong" }, { status: 500 });
  }
}
