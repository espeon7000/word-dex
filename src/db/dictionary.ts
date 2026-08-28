import { Asset } from "expo-asset";
import { Directory, File, Paths } from "expo-file-system";
import * as SQLite from "expo-sqlite";
import { ungzip } from "pako";

import { reportError } from "@/lib/report-error";
import type { Entry } from "@/types/dictionary";

// Bundled into the app binary (not downloaded post-install - see
// scripts/build-dictionary.mjs for how it's built and why bundling beats a
// first-launch fetch: this whole feature exists to stop depending on a
// flaky third-party API, and a required network download after install
// would just relocate that same dependency rather than remove it).
const DICTIONARY_ASSET = require("../../assets/dictionary/wordnet.sqlite.gz");

const DB_NAME = "dictionary.db";

// Unpacked once per install into expo-sqlite's own database directory - on
// every later app open the file's already there, so this just opens it
// directly with no unpacking work at all. Module-level, not per-call, so
// concurrent lookups (eg. typing quickly) share one in-flight setup instead
// of each racing to unpack the asset themselves.
let ready: Promise<SQLite.SQLiteDatabase | null> | null = null;

async function setupDatabase(): Promise<SQLite.SQLiteDatabase | null> {
  try {
    const sqliteDir = new Directory(Paths.document, "SQLite");
    if (!sqliteDir.exists) sqliteDir.create({ intermediates: true });
    const dbFile = new File(sqliteDir, DB_NAME);
    if (!dbFile.exists) {
      const asset = Asset.fromModule(DICTIONARY_ASSET);
      await asset.downloadAsync();
      if (!asset.localUri) {
        throw new Error("bundled dictionary asset has no local URI");
      }
      const gzipped = await new File(asset.localUri).bytes();
      const decompressed = ungzip(gzipped);
      dbFile.create({ intermediates: true });
      dbFile.write(decompressed);
    }
    return SQLite.openDatabaseSync(DB_NAME);
  } catch (error) {
    // Not fatal - lib/dictionary.ts's fetchDefinition falls back to the
    // live API for every lookup if this is ever null, same as before this
    // feature existed.
    reportError("[dictionary] failed to set up offline dictionary", error);
    return null;
  }
}

function getDictionaryDatabase(): Promise<SQLite.SQLiteDatabase | null> {
  if (!ready) ready = setupDatabase();
  return ready;
}

// Case-insensitive, single-word only (see build-dictionary.mjs - multi-word
// phrases were deliberately excluded from the offline set). Returns null on
// a miss - not an error, just "not in WordNet," which lib/dictionary.ts
// treats as "fall back to the live API" rather than "not found."
export async function lookupOffline(word: string): Promise<Entry | null> {
  const database = await getDictionaryDatabase();
  if (!database) return null;
  const row = await database.getFirstAsync<{ meanings: string }>(
    "SELECT meanings FROM entries WHERE word = ? COLLATE NOCASE",
    [word.toLowerCase()],
  );
  if (!row) return null;
  try {
    return { word, meanings: JSON.parse(row.meanings) };
  } catch (error) {
    reportError("[dictionary] failed to parse offline entry", error, word);
    return null;
  }
}
