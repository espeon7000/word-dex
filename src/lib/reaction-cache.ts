import AsyncStorage from "@react-native-async-storage/async-storage";

// Ephemeral, on-device only - the *only* thing blocking a repeat reaction on
// the same post (see reactions+api.ts's own comment: there's deliberately no
// server-side dedup). Keyed `${kind}:${id}`, value is when it was reacted to,
// pruned against this TTL on load and on every mark. A reinstall, a second
// device, or the cache simply expiring all let the same post be reacted to
// again - accepted tradeoff, not a bug.
const STORAGE_KEY = "words_reactions";
const REACTION_CACHE_TTL_MS = 6 * 60 * 60_000; // 6h - "a few hours"

let cache: Map<string, number> | null = null;

async function load(): Promise<Map<string, number>> {
  if (cache) return cache;
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  const entries: [string, number][] = raw ? JSON.parse(raw) : [];
  const cutoff = Date.now() - REACTION_CACHE_TTL_MS;
  cache = new Map(entries.filter(([, reactedAt]) => reactedAt >= cutoff));
  return cache;
}

function persist() {
  if (!cache) return;
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify([...cache])).catch((error) =>
    console.error("[reaction-cache] failed to persist", error),
  );
}

export async function hasReacted(key: string): Promise<boolean> {
  const map = await load();
  return map.has(key);
}

export async function markReacted(key: string): Promise<void> {
  const map = await load();
  map.set(key, Date.now());
  persist();
}
