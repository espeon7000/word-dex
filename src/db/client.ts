import * as Crypto from "expo-crypto";
import * as SQLite from "expo-sqlite";

let db: SQLite.SQLiteDatabase | null = null;
let ready: Promise<SQLite.SQLiteDatabase> | null = null;

// Locally-generated primary key. Needs to be genuinely collision-safe across
// independent devices with no coordination - each one generates rows entirely
// on its own, and they all merge into one shared table once sync exists.
// Simple auto-increment integers don't work here for most tables - every
// device would start counting from 1, so Device A's row 1 and Device B's row
// 1 are guaranteed to collide the moment both get pushed to the same shared
// table. It also guards against double-applying a retried push (server
// checks "have I seen this id before?") - which matters for tables where a
// duplicate has a real consequence, like learn_events double-counting
// mastery.
//
// UUIDv7 (RFC 9562), not v4 - the first 48 bits are a millisecond timestamp,
// so ids sort by creation order instead of v4's fully random ordering (handy
// for eg. inspecting rows in Drizzle Studio, or any index built on id). The
// remaining 74 bits are still genuine CSPRNG randomness (getRandomBytes, the
// same underlying source v4 used), so two devices generating ids in the same
// millisecond with zero coordination still don't collide - the exact same
// "decentralized generation, merge later" safety v4 had, just with a useful
// ordering property layered on top. It's also a real, standards-compliant
// UUID string, so it drops straight into the existing Postgres `uuid`
// columns with no type/schema change.
export function generateId(): string {
  const bytes = Crypto.getRandomBytes(16);
  const ms = Date.now();
  const high = Math.floor(ms / 0x100000000); // top 16 bits of the 48-bit ms timestamp
  const low = ms >>> 0; // bottom 32 bits
  bytes[0] = (high >>> 8) & 0xff;
  bytes[1] = high & 0xff;
  bytes[2] = (low >>> 24) & 0xff;
  bytes[3] = (low >>> 16) & 0xff;
  bytes[4] = (low >>> 8) & 0xff;
  bytes[5] = low & 0xff;
  bytes[6] = 0x70 | (bytes[6] & 0x0f); // version nibble (0111 = 7)
  bytes[8] = 0x80 | (bytes[8] & 0x3f); // variant bits (10)
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Deterministic (not random) id for a book, derived from account + title +
// author - so two devices independently creating "the same" book (before
// either has synced and pulled the other's row) compute the identical id
// instead of two different UUIDs for one conceptual book. That lets the
// existing id-based ON CONFLICT DO NOTHING push logic (already there for
// retry safety) dedupe them for free, with no separate merge step needed
// anywhere. Scoped by account (email, the one stable per-account value the
// client has - it doesn't know its own numeric server-side user_id), not
// just title+author, since two different users' copies of the same
// real-world book must not collide on id - it's the table's actual primary
// key across every account, not just this one.
export async function hashBookId(
  email: string,
  title: string,
  author: string | null,
): Promise<string> {
  const key = `${email.trim().toLowerCase()}|${title.trim().toLowerCase()}|${(author ?? "").trim().toLowerCase()}`;
  const hex = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    key,
  );
  // Postgres's uuid column only validates 8-4-4-4-12 hex syntax, not that
  // the value came from a real UUID algorithm - any 32 hex chars formatted
  // this way is accepted.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// Synchronous handle to the (already-open, not necessarily migrated yet)
// database. Only meant for dev tooling like Drizzle Studio that just needs a
// live connection to introspect - use getDatabase() for actual app queries.
export function getDatabaseSync(): SQLite.SQLiteDatabase {
  if (!db) db = SQLite.openDatabaseSync("words.db");
  return db;
}

type ColumnInfo = { name: string; type: string };

// A table needs dropping and recreating if it exists but doesn't match the
// shape we currently expect - CREATE TABLE IF NOT EXISTS never alters an
// existing table, so schema changes (dropped/renamed/retyped columns) only
// take effect if the stale table is removed first. No-op once a table's
// already current, so it's safe to leave these checks in permanently.
async function dropIfStale(
  database: SQLite.SQLiteDatabase,
  table: string,
  isStale: (columns: ColumnInfo[]) => boolean,
) {
  const columns = await database.getAllAsync<ColumnInfo>(
    `PRAGMA table_info(${table})`,
  );
  if (columns.length === 0) return; // doesn't exist yet - nothing to migrate
  if (isStale(columns)) {
    await database.execAsync(`DROP TABLE ${table};`);
  }
}

function hasColumn(columns: ColumnInfo[], name: string): boolean {
  return columns.some((c) => c.name === name);
}

// Additive migration for tables holding real data that can't just be dropped
// and recreated (unlike the disposable/idempotent tables dropIfStale is used
// for) - ALTER TABLE ADD COLUMN preserves every existing row.
async function addColumnIfMissing(
  database: SQLite.SQLiteDatabase,
  table: string,
  column: string,
  definition: string,
) {
  const columns = await database.getAllAsync<ColumnInfo>(
    `PRAGMA table_info(${table})`,
  );
  if (columns.length === 0) return; // table doesn't exist yet - CREATE TABLE below covers it
  if (!hasColumn(columns, column)) {
    await database.execAsync(
      `ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`,
    );
  }
}

// Drops one column while preserving every other row/column - for a column
// being fully removed (unlike dropIfStale, which recreates the whole table
// and would wipe real data). Relies on SQLite's ALTER TABLE DROP COLUMN
// (3.35+), well within what expo-sqlite bundles.
async function dropColumnIfPresent(
  database: SQLite.SQLiteDatabase,
  table: string,
  column: string,
) {
  const columns = await database.getAllAsync<ColumnInfo>(
    `PRAGMA table_info(${table})`,
  );
  if (columns.length === 0) return;
  if (hasColumn(columns, column)) {
    await database.execAsync(`ALTER TABLE ${table} DROP COLUMN ${column};`);
  }
}

// Renames a column in place, preserving its data - for a column that's
// changing name but not meaning.
async function renameColumnIfPresent(
  database: SQLite.SQLiteDatabase,
  table: string,
  from: string,
  to: string,
) {
  const columns = await database.getAllAsync<ColumnInfo>(
    `PRAGMA table_info(${table})`,
  );
  if (columns.length === 0) return;
  if (hasColumn(columns, from) && !hasColumn(columns, to)) {
    await database.execAsync(
      `ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to};`,
    );
  }
}

// SQLite can't ALTER TABLE ADD a foreign key to an existing column, so
// retrofitting user_words.user_book_id -> user_books(id) onto an install
// that already has data means rebuilding the table: create the new shape,
// copy every row across, drop the old table, rename the new one into place.
// Guarded by PRAGMA foreign_key_list so it's a no-op once already applied.
async function ensureUserWordsBookForeignKey(database: SQLite.SQLiteDatabase) {
  const columns = await database.getAllAsync<ColumnInfo>(
    `PRAGMA table_info(user_words)`,
  );
  if (columns.length === 0) return; // table doesn't exist yet - CREATE TABLE below covers it, FK included
  const foreignKeys = await database.getAllAsync<{
    table: string;
    from: string;
  }>(`PRAGMA foreign_key_list(user_words)`);
  const alreadyHasFk = foreignKeys.some(
    (fk) => fk.table === "user_books" && fk.from === "user_book_id",
  );
  if (alreadyHasFk) return;

  // Orphaned references (eg. from before deleted_books tombstones existed)
  // would make the rebuild below fail against the new FK - null them out
  // first, same as a real book deletion already does today.
  await database.execAsync(
    `UPDATE user_words SET user_book_id = NULL
     WHERE user_book_id IS NOT NULL
       AND user_book_id NOT IN (SELECT id FROM user_books);`,
  );

  // AUTOINCREMENT's whole point is remembering the all-time-high local_id
  // even if the row that used it was later deleted, so a plain "recompute
  // from what's currently in the table" after the rebuild would risk
  // handing out an id that's already been used before - the exact
  // rowid-reuse class of bug this table's local_id/id split exists to
  // prevent. Captured here, before anything is dropped, so it survives the
  // rebuild regardless of whether SQLite's own copy-through of
  // sqlite_sequence during CREATE/INSERT/DROP/RENAME can be relied on.
  const priorSeqRows = await database.getAllAsync<{ seq: number }>(
    `SELECT seq FROM sqlite_sequence WHERE name = 'user_words'`,
  );
  const priorSeq = priorSeqRows[0]?.seq ?? 0;

  // foreign_keys is turned off for exactly the DROP TABLE below - verified
  // empirically (not just by the docs) that DROP TABLE actually fires
  // learn_events' ON DELETE CASCADE for every row that referenced one of
  // these words, even though the rows themselves were already safely copied
  // into user_words_new first. Left on, this migration would have silently
  // deleted every learn_events row on its very first run. Restored
  // immediately after the rename, before anything else touches the db.
  await database.execAsync(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE user_words_new (
      local_id INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      word TEXT NOT NULL,
      definition TEXT NOT NULL,
      mastery INTEGER NOT NULL DEFAULT 0,
      added_at TEXT NOT NULL,
      user_book_id TEXT REFERENCES user_books(id) ON DELETE SET NULL,
      UNIQUE (word)
    );
    INSERT INTO user_words_new (local_id, id, word, definition, mastery, added_at, user_book_id)
      SELECT local_id, id, word, definition, mastery, added_at, user_book_id FROM user_words;
    DROP TABLE user_words;
    ALTER TABLE user_words_new RENAME TO user_words;
    PRAGMA foreign_keys = ON;
  `);

  if (priorSeq > 0) {
    const postRows = await database.getAllAsync<{ seq: number }>(
      `SELECT seq FROM sqlite_sequence WHERE name = 'user_words'`,
    );
    if (postRows.length === 0) {
      await database.execAsync(
        `INSERT INTO sqlite_sequence (name, seq) VALUES ('user_words', ${priorSeq});`,
      );
    } else if (postRows[0].seq < priorSeq) {
      await database.execAsync(
        `UPDATE sqlite_sequence SET seq = ${priorSeq} WHERE name = 'user_words';`,
      );
    }
  }
}

export function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (!ready) {
    db = getDatabaseSync();
    ready = (async () => {
      const database = db as SQLite.SQLiteDatabase;

      // One-time migrations - see hasColumn() call comments for what each is
      // detecting. All are no-ops once a table already has its current shape.
      // Additive, not dropIfStale - user_words holds real collection data
      // that a destructive migration would wipe out.
      // book_title/book_author/book_genre are superseded by user_books (via
      // user_book_id) and dropped outright rather than kept in parallel -
      // nothing reads them anymore. book_id -> user_book_id is a plain
      // rename, not a type/meaning change, so RENAME COLUMN preserves the
      // existing values instead of losing them.
      await dropColumnIfPresent(database, "user_words", "book_title");
      await dropColumnIfPresent(database, "user_words", "book_author");
      await dropColumnIfPresent(database, "user_words", "book_genre");
      await renameColumnIfPresent(
        database,
        "user_words",
        "book_id",
        "user_book_id",
      );
      await addColumnIfMissing(database, "user_words", "user_book_id", "TEXT");
      // Additive, same reasoning as above - user_books can already hold
      // real rows by the time these two were added.
      // Superseded by user_book_reviews below - a book can now have more
      // than one review, so a single mutable rating/review/review_date on
      // user_books itself no longer makes sense. Nothing had ever been
      // saved into these columns before the switch, so there's no data to
      // carry over into the new table first.
      await dropColumnIfPresent(database, "user_books", "rating");
      await dropColumnIfPresent(database, "user_books", "review");
      await dropColumnIfPresent(database, "user_books", "review_date");
      // category is superseded by a real user_book_categories table + FK,
      // same reasoning as above - nothing has ever written a non-null value
      // into it (see the comment on add()'s book branch in
      // context/collection.tsx), so there's no data to carry over first.
      // The new column is plain TEXT (no declared FK) on an existing
      // install, same as user_book_id originally was on user_words below -
      // SQLite can't ALTER TABLE ADD a constrained column, and nothing yet
      // deletes a category for the FK's ON DELETE behavior to matter.
      await dropColumnIfPresent(database, "user_books", "category");
      await addColumnIfMissing(
        database,
        "user_books",
        "user_book_category_id",
        "TEXT",
      );
      await dropIfStale(
        database,
        "sentences",
        (cols) =>
          hasColumn(cols, "user_id") || // used to carry a user_id column
          !hasColumn(cols, "word") || // pre-dates the word/word_hash key entirely
          (cols.find((c) => c.name === "id")?.type ?? "").toUpperCase() ===
            "TEXT", // id used to be a UUID
      );
      await dropIfStale(database, "user_activity", (cols) =>
        hasColumn(cols, "user_id"),
      );
      await dropIfStale(
        database,
        "learn_events",
        (cols) => !hasColumn(cols, "local_id"),
      );
      // mastery_delta/skipped are being dropped - every row from here on
      // implicitly means "answered correctly" (mastery += 1), so a wrong
      // answer or a skip is no longer synced/stored at all. Old rows that
      // don't fit that (skipped, or mastery_delta = 0) don't correspond to
      // anything under the new schema - they're deleted first so a future
      // COUNT(*)-based mastery recompute doesn't overcount them as
      // successful attempts, then the columns themselves are dropped.
      {
        const learnEventCols = await database.getAllAsync<ColumnInfo>(
          `PRAGMA table_info(learn_events)`,
        );
        if (
          hasColumn(learnEventCols, "skipped") ||
          hasColumn(learnEventCols, "mastery_delta")
        ) {
          await database.execAsync(
            "DELETE FROM learn_events WHERE skipped = 1 OR mastery_delta = 0;",
          );
        }
      }
      await dropColumnIfPresent(database, "learn_events", "skipped");
      await dropColumnIfPresent(database, "learn_events", "mastery_delta");
      await dropIfStale(
        database,
        "deleted_words",
        (cols) =>
          (cols.find((c) => c.name === "id")?.type ?? "").toUpperCase() ===
            "TEXT" || hasColumn(cols, "word"), // used to match by word text instead of user_word_id
      );
      await ensureUserWordsBookForeignKey(database);

      await database.execAsync(
        `
        PRAGMA foreign_keys = ON;

        -- Same local_id/id split as user_books/user_words below, same reason
        -- (AUTOINCREMENT protection for the sync cursor). No user_id column,
        -- same reason every other local table omits one - this db holds one
        -- account's data at a time (wiped on logout), so it's implicit.
        -- Created before user_books so its FK below has something to
        -- reference immediately - though, per the comment on user_words
        -- further down, SQLite would tolerate the reverse order too.
        CREATE TABLE IF NOT EXISTS user_book_categories (
          local_id INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          added_at TEXT NOT NULL,
          name TEXT NOT NULL,
          UNIQUE (name)
        );

        -- Same local_id/id split as user_words below, same reason
        -- (AUTOINCREMENT protection for the sync cursor). One row per
        -- distinct book - collection.tsx's add() finds-or-creates by
        -- title+author instead of inserting a fresh row per word, so
        -- multiple words from the same book share one id here via
        -- user_words.user_book_id. Created before user_words so the FK
        -- below has something to reference immediately, though SQLite
        -- would also tolerate the reverse order - a FOREIGN KEY only needs
        -- its target to exist by the time a row is actually inserted, not
        -- at CREATE TABLE time. user_book_category_id gets its real FK
        -- declared directly here (unlike the plain-column retrofit an
        -- existing install gets above) - a fresh install has no pre-existing
        -- data to make that a problem for.
        CREATE TABLE IF NOT EXISTS user_books (
          local_id INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          added_at TEXT NOT NULL,
          title TEXT NOT NULL,
          author TEXT,
          user_book_category_id TEXT REFERENCES user_book_categories(id) ON DELETE SET NULL
        );

        -- local_id (not id) is the real rowid-alias here, specifically so it's
        -- protected by AUTOINCREMENT against reuse after a delete - a plain
        -- TEXT PRIMARY KEY table's implicit rowid has no such protection, and
        -- SQLite is free to hand out a deleted row's old rowid to a brand new
        -- row, which silently breaks the sync cursor (it looks "already
        -- pushed" even though it's an entirely different row). id (the UUID)
        -- stays UNIQUE rather than PRIMARY KEY - that's all a FOREIGN KEY
        -- target needs, so learn_events' reference to it is unaffected.
        -- user_book_id references user_books(id) directly (ON DELETE SET
        -- NULL, not CASCADE - a word losing its book association shouldn't
        -- delete the word itself) - existing installs get this retrofitted
        -- via ensureUserWordsBookForeignKey above, since SQLite can't just
        -- ALTER TABLE ADD a foreign key onto a table that already has data.
        CREATE TABLE IF NOT EXISTS user_words (
          local_id INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          word TEXT NOT NULL,
          definition TEXT NOT NULL,
          mastery INTEGER NOT NULL DEFAULT 0,
          added_at TEXT NOT NULL,
          user_book_id TEXT REFERENCES user_books(id) ON DELETE SET NULL,
          UNIQUE (word)
        );

        -- Same local_id/id split again. Replaces user_books' old single
        -- mutable rating/review/review_date columns - a book can have more
        -- than one review over time (eg. re-rating after a re-read), so
        -- this is an insert-only log (like learn_events/sentences) rather
        -- than a field that gets overwritten in place. ON DELETE CASCADE
        -- here (unlike user_words' SET NULL above) - a review only makes
        -- sense attached to its book, so it shouldn't outlive it.
        CREATE TABLE IF NOT EXISTS user_book_reviews (
          local_id INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          user_book_id TEXT NOT NULL REFERENCES user_books(id) ON DELETE CASCADE,
          added_at TEXT NOT NULL,
          rating REAL NOT NULL CHECK (rating >= 0.0 AND rating <= 10.0),
          review TEXT NOT NULL
        );

        -- Duplicates here are harmless (just an example sentence occasionally
        -- shown more often than intended), so no need for collision-proof ids
        -- - a plain auto-increment integer is enough.
        CREATE TABLE IF NOT EXISTS sentences (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL,
          word TEXT NOT NULL,
          body TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS user_activity (
          day TEXT PRIMARY KEY NOT NULL
        );

        -- Cleans up rows written back when the server's pull query returned
        -- a "date" column as a JS Date object (eg.
        -- "2026-07-06T04:00:00.000Z") instead of a plain "YYYY-MM-DD"
        -- string - a real day value never contains "T", so this is a safe,
        -- idempotent no-op once the bad rows are gone. The server-side query
        -- now casts to text, so this only matters for rows already pulled
        -- before that fix.
        DELETE FROM user_activity WHERE day LIKE '%T%';

        -- Same local_id/id split as user_words, and for the identical reason -
        -- a learn_event's rowid is freed the moment its parent word is
        -- deleted (ON DELETE CASCADE), so an unprotected rowid could be
        -- reused by a brand new event afterward. Every row here means "this
        -- word was answered correctly" - a wrong answer or a skip never
        -- creates a row at all, so mastery is just a row count, not a
        -- summed delta, and there's no skipped flag to track.
        CREATE TABLE IF NOT EXISTS learn_events (
          local_id INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          user_word_id TEXT NOT NULL REFERENCES user_words(id) ON DELETE CASCADE,
          timestamp TEXT NOT NULL
        );

        -- Duplicates here are harmless too - a tombstone just says "this word
        -- is deleted"; processing that twice on pull is a no-op, not a
        -- double-count. No FK dependents either, so plain auto-increment.
        -- user_word_id is NOT a foreign key to user_words(id) on purpose - a
        -- tombstone's entire job is to outlive the row it refers to, so
        -- enforcing referential integrity here would either block the delete
        -- or force an ON DELETE action that destroys the exact id this table
        -- exists to remember.
        CREATE TABLE IF NOT EXISTS deleted_words (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_word_id TEXT NOT NULL,
          deleted_at TEXT NOT NULL
        );

        -- Same shape and reasoning as deleted_words, one level up - a
        -- book's tombstone also drives unlinking any user_words rows that
        -- pointed at it (see collection.tsx's removeBook and sync.ts's
        -- pull-apply for deletedBooks), since there's no FK from
        -- user_words.user_book_id to enforce that automatically.
        CREATE TABLE IF NOT EXISTS deleted_books (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_book_id TEXT NOT NULL,
          deleted_at TEXT NOT NULL
        );

        -- Same shape and reasoning again, one level further - a category's
        -- tombstone drives unlinking any user_books rows that pointed at it
        -- (see collection.tsx's removeCategory and sync.ts's pull-apply for
        -- deletedCategories) - the n/a bucket isn't a real row here at all,
        -- so it's the one category that can never produce one of these.
        CREATE TABLE IF NOT EXISTS deleted_categories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_book_category_id TEXT NOT NULL,
          deleted_at TEXT NOT NULL
        );

        -- Sync bookkeeping: per-table, how far local pushes and pulls have
        -- gotten. Not used yet (no backend to sync with), but the schema's
        -- ready for when the sync engine lands.
        CREATE TABLE IF NOT EXISTS sync_cursors (
          entity TEXT PRIMARY KEY NOT NULL,
          last_pushed_rowid INTEGER NOT NULL DEFAULT 0,
          last_pulled_seq INTEGER NOT NULL DEFAULT 0
        );

        -- The user_books push cursor (sync_cursors' local_id watermark
        -- above) only ever looks forward for brand-new rows - it has no way
        -- to notice that an already-pushed book's user_book_category_id
        -- changed. assignBookCategory in context/collection.tsx marks a
        -- reassigned book here so db/sync.ts's gatherPush can pick it back
        -- up and resend it (server-side upserted, not just inserted) on the
        -- next push, regardless of where the cursor already is. Cleared once
        -- that resend actually succeeds.
        CREATE TABLE IF NOT EXISTS user_books_dirty (
          user_book_id TEXT PRIMARY KEY NOT NULL
        );
      `,
      );

      return database;
    })();
  }
  return ready;
}

// Wipes every local table. Called on logout - since local data no longer
// carries a user_id, an account switch has to start from a clean slate rather
// than relying on filtering to keep accounts apart. Repopulating on the next
// login is a job for the sync-pull mechanism once a backend exists; for now
// a fresh login just starts empty, same as a fresh install.
export async function clearAllTables(): Promise<void> {
  const database = await getDatabase();
  await database.execAsync(`
    DELETE FROM learn_events;
    DELETE FROM sentences;
    DELETE FROM deleted_words;
    DELETE FROM deleted_books;
    DELETE FROM deleted_categories;
    DELETE FROM user_activity;
    DELETE FROM user_words;
    DELETE FROM user_books;
    DELETE FROM user_book_categories;
    DELETE FROM user_books_dirty;
    DELETE FROM sync_cursors;
  `);
}
