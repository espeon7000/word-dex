// One-off build script - no runtime app dependency on this ever running
// again unless the dictionary itself needs regenerating (it won't; WordNet
// doesn't change). Produces assets/dictionary/wordnet.sqlite.gz, the
// offline dictionary bundled into the app binary and unpacked on first
// launch (see db/dictionary.ts). Run once with:
//   node scripts/build-dictionary.mjs
// Requires `sqlite3` and `tar`/`curl` on PATH (all normally already present
// on macOS/Linux dev machines and CI - not worth a real npm dependency for
// a script that runs maybe once ever).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const WORDNET_URL = "https://wordnetcode.princeton.edu/3.0/WNdb-3.0.tar.gz";
const OUT_DIR = new URL("../assets/dictionary/", import.meta.url).pathname;
const OUT_FILE = join(OUT_DIR, "wordnet.sqlite.gz");

const POS_NAMES = { n: "noun", v: "verb", a: "adjective", s: "adjective", r: "adverb" };
const DATA_FILES = ["data.noun", "data.verb", "data.adj", "data.adv"];

const workDir = mkdtempSync(join(tmpdir(), "wordnet-build-"));
console.log(`working in ${workDir}`);

execFileSync("curl", ["-sL", "-o", "WNdb-3.0.tar.gz", WORDNET_URL], { cwd: workDir });
execFileSync("tar", ["xzf", "WNdb-3.0.tar.gz"], { cwd: workDir });

// word -> pos -> [definition, ...]
const words = new Map();

function addDefinition(word, pos, definition) {
  word = word.toLowerCase();
  if (!words.has(word)) words.set(word, new Map());
  const byPos = words.get(word);
  if (!byPos.has(pos)) byPos.set(pos, []);
  const defs = byPos.get(pos);
  // Same word+pos can appear in multiple synsets - de-dupe identical gloss
  // text (rare, but a couple of function words have exact duplicate senses).
  if (!defs.includes(definition)) defs.push(definition);
}

for (const file of DATA_FILES) {
  const text = readFileSync(join(workDir, "dict", file), "utf8");
  for (const line of text.split("\n")) {
    if (!line || line.startsWith(" ")) continue; // header/copyright lines start with a space
    // Format: synset_offset lex_filenum ss_type w_cnt word lex_id [word lex_id ...] p_cnt [ptr ...] | gloss
    const bar = line.indexOf(" | ");
    if (bar === -1) continue;
    const head = line.slice(0, bar);
    let gloss = line.slice(bar + 3).trim();
    // Strip example sentences (quoted, after a semicolon) - keep just the
    // defining part(s), semicolon-joined if there's more than one packed
    // into a single gloss (rare, WordNet does this occasionally).
    gloss = gloss
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('"'))
      .join("; ");
    if (!gloss) continue;

    const parts = head.trim().split(/\s+/);
    // parts[0]=offset [1]=lex_filenum [2]=ss_type [3]=w_cnt(hex) then w_cnt*2 tokens (word, lex_id)
    const ssType = parts[2];
    const pos = ssType === "s" ? "a" : ssType; // adjective satellite -> adjective
    const wCnt = parseInt(parts[3], 16);
    for (let i = 0; i < wCnt; i++) {
      const word = parts[4 + i * 2].replace(/_/g, " ");
      if (word.includes(" ")) continue; // multi-word phrase - skip, single-word dictionary only
      addDefinition(word, pos, gloss);
    }
  }
}

console.log(`parsed ${words.size} unique words`);

// Matches src/types/dictionary.ts's Entry["meanings"] shape exactly, so
// db/dictionary.ts can hand a row's JSON straight to the caller with no
// transform - see that file's own comment.
const sql = [];
sql.push("PRAGMA journal_mode=OFF;");
sql.push("CREATE TABLE entries (word TEXT PRIMARY KEY, meanings TEXT NOT NULL);");
sql.push("BEGIN;");
const esc = (s) => "'" + s.replace(/'/g, "''") + "'";
for (const [word, byPos] of words) {
  const meanings = [...byPos.entries()].map(([pos, defs]) => ({
    partOfSpeech: POS_NAMES[pos],
    definitions: defs.map((definition) => ({ definition })),
  }));
  sql.push(
    `INSERT INTO entries (word, meanings) VALUES (${esc(word)}, ${esc(JSON.stringify(meanings))});`,
  );
}
sql.push("COMMIT;");
sql.push("CREATE INDEX idx_word ON entries(word);");
sql.push("VACUUM;");
writeFileSync(join(workDir, "import.sql"), sql.join("\n"));

const dbPath = join(workDir, "wordnet.sqlite");
execFileSync("sqlite3", [dbPath], { input: sql.join("\n") });

const compressed = gzipSync(readFileSync(dbPath), { level: 9 });
writeFileSync(OUT_FILE, compressed);
console.log(`wrote ${OUT_FILE} (${(compressed.length / 1024 / 1024).toFixed(1)} MB)`);

rmSync(workDir, { recursive: true, force: true });
