import { requireAuth } from "@/server/jwt";

// learn.tsx's own sentence-quiz check, moved server-side - this used to call
// api.anthropic.com directly from the client with the key inlined via
// EXPO_PUBLIC_ANTHROPIC_API_KEY, which ships the real, billed key in the app
// bundle for anyone to extract. ANTHROPIC_API_KEY here is a plain (non
// EXPO_PUBLIC_) env var, so it only ever exists on the server.
export async function POST(request: Request) {
  try {
    await requireAuth(request);
    const { word, sentence } = await request.json();
    if (typeof word !== "string" || typeof sentence !== "string") {
      return Response.json(
        { error: "word and sentence are required" },
        { status: 400 },
      );
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error("[verify-sentence] ANTHROPIC_API_KEY is not set");
      return Response.json({ error: "something went wrong" }, { status: 500 });
    }

    let res: Response;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 256,
          messages: [
            {
              role: "user",
              content: `Does this phrase/sentence(s) use the word "${word}" correctly in context? If the word is not included, it is incorrect. Doesn't have to be a complete sentence or have perfect grammar, as long as the word's meaning is conveyed accurately. Reply ONLY with a JSON object with two fields: "correct" (boolean) and "reason" (a very short explanation why, 8 words max).\n\nSentence: ${sentence}`,
            },
          ],
        }),
      });
    } catch (error) {
      console.error("[verify-sentence] anthropic request failed", error);
      return Response.json({ error: "network error" }, { status: 502 });
    }

    if (!res.ok) {
      console.error("[verify-sentence] anthropic rejected", res.status);
      return Response.json({ error: "api error" }, { status: 502 });
    }

    const data = await res.json();
    const raw: string = data.content?.[0]?.text ?? "{}";
    const text = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    try {
      const parsed = JSON.parse(text);
      return Response.json({
        correct: !!parsed.correct,
        reason: typeof parsed.reason === "string" ? parsed.reason : "",
      });
    } catch {
      return Response.json({
        correct: false,
        reason: "could not parse response",
      });
    }
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[verify-sentence] error", error);
    return Response.json({ error: "something went wrong" }, { status: 500 });
  }
}
