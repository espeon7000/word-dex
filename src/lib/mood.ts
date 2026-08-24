import { API_BASE_URL } from "@/constants/api";
import { getCurrentToken } from "@/lib/auth-token";

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
//
// Calls our own /api/classify-mood rather than api.anthropic.com directly -
// see that route's own comment for why (this used to ship a real, billed
// Anthropic key in the app bundle via EXPO_PUBLIC_ANTHROPIC_API_KEY).
// getCurrentToken() (not useAuth() - this module sits outside any component,
// and above AuthProvider besides, since it's called from context/theme.tsx)
// mirrors db/sync.ts's own token access.
export async function classifyMood(text: string): Promise<Mood | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const res = await fetch(`${API_BASE_URL}/api/classify-mood`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getCurrentToken() ?? ""}`,
      },
      body: JSON.stringify({ text: trimmed }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (typeof data.mood !== "string") return null;
    return MOODS_BY_ID.get(data.mood) ?? null;
  } catch {
    return null;
  }
}
