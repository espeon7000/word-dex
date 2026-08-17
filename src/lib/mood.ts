// 13 points on the color wheel, arranged like a clock face - the 12 hour
// positions plus dead center. Hue values follow the same convention
// components/color-wheel.tsx's own polarToCartesian uses (hue 0 = 3
// o'clock, increasing clockwise as hue increases), so a mood's hue here is
// exactly where its label would sit if drawn on that same wheel. Center is
// desaturated (saturation 0) rather than a hue pointing nowhere in
// particular - "bleak, emotionless, isolated" is the one mood that isn't
// really a color at all, just gray; its own hue value is unused at
// saturation 0 and picked arbitrarily.
export type Mood = {
  id: string;
  label: string;
  hue: number;
  saturation: number;
};

export const MOODS: Mood[] = [
  { id: "center", label: "bleak, emotionless, isolated", hue: 0, saturation: 0 },
  { id: "9", label: "playful, whimsical, funny", hue: 180, saturation: 100 },
  {
    id: "10",
    label: "melancholy, sentimental, nostalgic, wistful",
    hue: 210,
    saturation: 100,
  },
  {
    id: "11",
    label: "passionately sad, despairing, tragic",
    hue: 240,
    saturation: 100,
  },
  { id: "12", label: "reflective, serene, beautiful", hue: 270, saturation: 100 },
  {
    id: "1",
    label: "majestic, heroic, proud but feminine",
    hue: 300,
    saturation: 100,
  },
  {
    id: "2",
    label:
      "budding youth, energetic, blood flowing through one's veins, lively",
    hue: 330,
    saturation: 100,
  },
  { id: "3", label: "intense warmth, love, sacrificial", hue: 0, saturation: 100 },
  { id: "4", label: "academic, precise, professional", hue: 30, saturation: 100 },
  { id: "5", label: "spiritual, transcendence, bright", hue: 60, saturation: 100 },
  { id: "6", label: "comical, ironic, jester-like", hue: 90, saturation: 100 },
  { id: "7", label: "nature, lush landscapes", hue: 120, saturation: 100 },
  {
    id: "8",
    label: "majestic, heroic, proud but masculine",
    hue: 150,
    saturation: 100,
  },
];

const MOODS_BY_ID = new Map(MOODS.map((m) => [m.id, m]));

// Best-effort, silent on any failure (bad network, malformed response,
// missing key) - this is a background flourish, not core functionality, so
// unlike learn.tsx's verifyWithClaude it never throws a distinguishable
// error for a caller to react to. Deliberately selective in the prompt
// itself ("be selective, most text matches none of them") - most sentences/
// titles/reviews are mood-neutral, and forcing every one into the nearest
// bucket would make the background shift on nearly everything instead of
// only when something actually reads that way.
export async function classifyMood(text: string): Promise<Mood | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const apiKey = process.env.EXPO_PUBLIC_ANTHROPIC_API_KEY;
  const moodList = MOODS.map((m) => `- ${m.id}: ${m.label}`).join("\n");
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey ?? "",
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
    if (!res.ok) return null;
    const data = await res.json();
    const raw: string = data.content?.[0]?.text ?? "{}";
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    const parsed = JSON.parse(cleaned);
    if (typeof parsed.mood !== "string") return null;
    return MOODS_BY_ID.get(parsed.mood) ?? null;
  } catch {
    return null;
  }
}
