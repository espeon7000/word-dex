import type { Entry } from "@/types/dictionary";

const DICTIONARY_API = "https://api.dictionaryapi.dev/api/v2/entries/en/";
// A fetch failing right after the app resumes from background is usually
// the network interface still reconnecting, not a real failure - but the
// gap between "resumed" and "user actually taps something" is however long
// the user takes, not a fixed window. Retrying once after a short delay
// handles that regardless of timing, since it reacts to the failure itself
// rather than guessing how long ago the app came back.
const RETRY_DELAY_MS = 800;

async function fetchDefinitionOnce(word: string): Promise<Entry> {
  let res: Response;
  try {
    res = await fetch(`${DICTIONARY_API}${encodeURIComponent(word)}`);
  } catch {
    // fetch() itself throwing (rather than resolving with some status) means
    // the request never reached the network at all - almost always no
    // connection, worth telling apart from a real server-side failure.
    throw new Error("network error");
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
