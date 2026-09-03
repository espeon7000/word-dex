import { lookupOffline } from "@/db/dictionary";
import type { Entry } from "@/types/dictionary";

// Bundled offline dictionary only (see db/dictionary.ts) - no live API
// fallback anymore. That used to be api.dictionaryapi.dev, a free
// third-party service that turned out to be too unreliable to depend on
// (confirmed: some lookups took 20-30+ seconds to fail, and other
// developers were hitting the same thing around the same time - see PR
// history/commit log for the full investigation). A local SQLite lookup is
// instant and can't be flaky the way a third-party network call can, at the
// cost of only covering the ~83k words WordNet actually has - a miss here
// is a real "no definition found", not a "let's also try the network"
// situation.
export async function fetchDefinition(word: string): Promise<Entry> {
  const offline = await lookupOffline(word);
  if (offline) return offline;
  throw new Error("not found");
}
