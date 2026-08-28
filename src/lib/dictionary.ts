import { lookupOffline } from "@/db/dictionary";
import type { Entry } from "@/types/dictionary";

const DICTIONARY_API = "https://api.dictionaryapi.dev/api/v2/entries/en/";
// A fetch failing right after the app resumes from background is usually
// the network interface still reconnecting, not a real failure - but the
// gap between "resumed" and "user actually taps something" is however long
// the user takes, not a fixed window. Retrying once after a short delay
// handles that regardless of timing, since it reacts to the failure itself
// rather than guessing how long ago the app came back.
const RETRY_DELAY_MS = 800;
// fetch() has no built-in timeout - left alone, a slow/flaky response from
// this free, third-party API (confirmed: some lookups take 20-30+ seconds
// to fail, well past what anyone would wait out) just sits there, reading
// as the screen having hung rather than an actual, visible error. Aborting
// after this long forces a fast, bounded failure instead - same "network
// error" outcome as no connection at all, just reached deliberately instead
// of by however long the server feels like taking.
const DEFINITION_TIMEOUT_MS = 4000;

async function fetchDefinitionOnce(word: string): Promise<Entry> {
  let res: Response;
  const controller = new AbortController();
  // Distinguishes *why* fetch() rejected - a genuinely unreachable network
  // (real "check your connection" territory) from this deliberate abort
  // (the connection's fine, the third-party API is just slow/flaky right
  // now) - conflating the two under one message told a working-connection
  // user to go "restore" a connection that was never the problem.
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, DEFINITION_TIMEOUT_MS);
  try {
    res = await fetch(`${DICTIONARY_API}${encodeURIComponent(word)}`, {
      signal: controller.signal,
    });
  } catch {
    throw new Error(timedOut ? "timeout" : "network error");
  } finally {
    clearTimeout(timeout);
  }
  if (res.status === 404) throw new Error("not found");
  if (!res.ok) throw new Error("fetch failed");
  const data = await res.json();
  const entry = data[0];
  return {
    word: entry.word,
    phonetic:
      entry.phonetic ??
      entry.phonetics?.find((p: { text?: string }) => p.text)?.text,
    meanings: entry.meanings.map(
      (m: { partOfSpeech: string; definitions: { definition: string }[] }) => ({
        partOfSpeech: m.partOfSpeech,
        definitions: m.definitions.map((d) => ({ definition: d.definition })),
      }),
    ),
  };
}

export async function fetchDefinition(word: string): Promise<Entry> {
  // Bundled offline dictionary first (see db/dictionary.ts) - a local
  // SQLite lookup, so this resolves near-instantly and works with zero
  // network at all. Only reaches the live API below on an offline miss (a
  // word WordNet doesn't have - new slang, proper nouns, etc.) or if the
  // offline database itself failed to set up for some reason.
  const offline = await lookupOffline(word);
  if (offline) return offline;

  try {
    return await fetchDefinitionOnce(word);
  } catch (e: unknown) {
    // A 404 is a real, deterministic result - retrying it would just waste
    // a request and delay showing the correct "no definition found".
    if (e instanceof Error && e.message === "not found") throw e;
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    return fetchDefinitionOnce(word);
  }
}
