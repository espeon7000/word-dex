import { getSql } from "@/server/db";
import { requireAuth } from "@/server/jwt";

// Registers (or refreshes) an Expo push token for the current user - called
// from push-notifications.ts on login/signup/restored-session. A user can
// have more than one token (multiple devices), hence the composite key
// rather than one-row-per-user; re-registering the same token just bumps
// created_at instead of erroring.
export async function POST(request: Request) {
  try {
    const { userId } = await requireAuth(request);
    const { token } = await request.json();
    if (typeof token !== "string" || !token.trim()) {
      return Response.json({ error: "token is required" }, { status: 400 });
    }

    const sql = getSql();
    await sql`
      INSERT INTO push_tokens (user_id, token)
      VALUES (${userId}, ${token.trim()})
      ON CONFLICT (user_id, token) DO UPDATE SET created_at = now()
    `;
    return Response.json({ success: true });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[push-tokens] error", error);
    return Response.json({ error: "something went wrong" }, { status: 500 });
  }
}
