import { requireAuth } from "@/server/jwt";
import { MOODS } from "@/lib/mood";

// context/theme.tsx's own background-mood classifier, moved server-side -
// same reasoning as verify-sentence+api.ts (the client used to call
// api.anthropic.com directly with EXPO_PUBLIC_ANTHROPIC_API_KEY inlined into
// the bundle). Only ever returns a mood id (lib/mood.ts's own MOODS_BY_ID
// resolves that back to hue/saturation client-side) - the MOODS list itself
// isn't sensitive, just reused here (not duplicated) to build the same
// prompt.
export async function POST(request: Request) {
  try {
    await requireAuth(request);
    const { text } = await request.json();
    if (typeof text !== "string" || !text.trim()) {
      return Response.json({ mood: null });
    }
    const trimmed = text.trim();

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error("[classify-mood] ANTHROPIC_API_KEY is not set");
      return Response.json({ mood: null });
    }

    const moodList = MOODS.map((m) => `- ${m.id}: ${m.label}`).join("\n");
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 32,
        messages: [
          {
            role: "user",
            content: `A short piece of text follows - a sentence, a book title, or a book review. Decide whether it strongly evokes exactly one of these moods. Be selective - most text matches none of them, so only pick one if it's a clear, strong match.\n${moodList}\n\nText: "${trimmed}"\n\nReply ONLY with a JSON object: {"mood": "<id>"} using one of the ids above, or {"mood": null} if nothing fits well.`,
          },
        ],
      }),
    });
    if (!res.ok) return Response.json({ mood: null });

    const data = await res.json();
    const raw: string = data.content?.[0]?.text ?? "{}";
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    const parsed = JSON.parse(cleaned);
    return Response.json({
      mood: typeof parsed.mood === "string" ? parsed.mood : null,
    });
  } catch (error) {
    // Best-effort, same as classifyMood's own client-side try/catch it
    // replaces - a background flourish, not core functionality, so this
    // fails silently (a mood of null) rather than surfacing an error the
    // caller would have to handle.
    if (error instanceof Response) return error;
    console.error("[classify-mood] error", error);
    return Response.json({ mood: null });
  }
}
