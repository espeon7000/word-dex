import type { SQLiteDatabase } from "expo-sqlite";

import { getDatabase } from "./client";

import { API_BASE_URL } from "@/constants/api";

// Fired from sendPush below whenever the server rejects our token outright
// (expired past its 30-day lifetime, or otherwise invalid) - a single
// module-level slot rather than threading a callback through every
// exported function here, since every push/pull path (runSync, pushOnly,
// the debounced one) already funnels through this one function regardless
// of which caller kicked it off. The registered handler lives in
// _layout.tsx, which has direct access to auth state; this module doesn't
// know or care what "unauthorized" actually means to the rest of the app,
// just that it happened.
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

// Same shape as onUnauthorized above, fired instead whenever sync+api.ts's
// sliding-refresh check decides this token is close enough to its 30-day
// expiry to reissue - most calls don't get one back (see that route's own
// threshold comment), so this only fires occasionally, not on every push.
let onTokenRefreshed: ((newToken: string) => void) | null = null;

export function setTokenRefreshedHandler(
  handler: ((newToken: string) => void) | null,
): void {
  onTokenRefreshed = handler;
}

type Cursor = { last_pushed_rowid: number; last_pulled_seq: number };

// The cursor needs the true maximum id among a batch, not "whichever row
// happens to be last in the array" - a plain `WHERE id > ?` query has no
// guaranteed row order without an explicit ORDER BY, so picking the last
// element could silently pick a lower id than one earlier in the array. That
// would leave the actual max unsynced going forward, getting resent (and,
// for tables with no conflict protection like deleted_words, duplicated) on
// every subsequent sync.
function maxOf<T>(rows: T[], key: keyof T): number | null {
  if (rows.length === 0) return null;
  return Math.max(...rows.map((r) => r[key] as number));
}

async function getCursor(db: SQLiteDatabase, entity: string): Promise<Cursor> {
  const row = await db.getFirstAsync<Cursor>(
    "SELECT last_pushed_rowid, last_pulled_seq FROM sync_cursors WHERE entity = ?",
    [entity],
  );
  return row ?? { last_pushed_rowid: 0, last_pulled_seq: 0 };
}

// Only touches whichever side (push/pull) actually advanced this round -
// passing null for the other leaves it at its current stored value.
async function advanceCursor(
  db: SQLiteDatabase,
  entity: string,
  pushedRowid: number | null,
  pulledSeq: number | null,
) {
  if (pushedRowid === null && pulledSeq === null) return;
  const current = await getCursor(db, entity);
  await db.runAsync(
    `INSERT INTO sync_cursors (entity, last_pushed_rowid, last_pulled_seq) VALUES (?, ?, ?)
     ON CONFLICT (entity) DO UPDATE SET
       last_pushed_rowid = excluded.last_pushed_rowid,
       last_pulled_seq = excluded.last_pulled_seq`,
    [
      entity,
      pushedRowid ?? current.last_pushed_rowid,
      pulledSeq ?? current.last_pulled_seq,
    ],
  );
}

// Clears user_books_dirty entries once they've actually been resent - called
// after sendPush succeeds (never before), same "only advance bookkeeping on
// confirmed success" shape advanceCursor above follows for the cursors.
async function clearDirtyBooks(db: SQLiteDatabase, ids: string[]) {
  if (ids.length === 0) return;
  await db.runAsync(
    `DELETE FROM user_books_dirty WHERE user_book_id IN (${ids.map(() => "?").join(",")})`,
    ids,
  );
}

// All four of these use an explicit local_id/id (AUTOINCREMENT INTEGER PRIMARY
// KEY) as the local push-cursor value, never the rowid pseudo-column - two
// different failure modes made plain rowid unsafe here. On sentences/
// deleted_words, id itself already IS an AUTOINCREMENT primary key, and
// selecting the bare "rowid" alias for it was unreliable (the result can come
// back under the column's origin name, "id", leaving `.rowid` undefined on
// the returned row). On user_words/learn_events, id is a UUID (TEXT PRIMARY
// KEY), which doesn't alias rowid at all - so their implicit rowid had no
// AUTOINCREMENT protection against reuse: deleting a row and inserting a new
// one afterward could hand the new row the exact rowid the deleted one used,
// making it look "already pushed" to the cursor even though it never was.
// local_id is a genuine second AUTOINCREMENT column purely for cursor
// tracking, with the UUID staying UNIQUE (not primary) for its existing job
// as the stable cross-device identity / foreign key target.
type LocalUserWordRow = {
  local_id: number;
  id: string;
  word: string;
  definition: string;
  mastery: number;
  added_at: string;
  user_book_id: string | null;
};
// Same local_id/id split as user_words, same reasons (see the type comment
// above).
type LocalUserBookRow = {
  local_id: number;
  id: string;
  added_at: string;
  title: string;
  author: string | null;
  user_book_category_id: string | null;
};
// Same local_id/id split again - insert-only, like user_book_reviews below
// (a category name is either created or it isn't; there's no update path).
type LocalUserBookCategoryRow = {
  local_id: number;
  id: string;
  added_at: string;
  name: string;
};
type LocalSentenceRow = {
  id: number;
  created_at: string;
  word: string;
  body: string;
};
type LocalLearnEventRow = {
  local_id: number;
  id: string;
  user_word_id: string;
  timestamp: string;
};
// Same local_id/id split, same reasons - a book can have more than one
// review over time, so this is an insert-only log, same shape/treatment as
// learn_events rather than a mutable field on user_books.
type LocalUserBookReviewRow = {
  local_id: number;
  id: string;
  user_book_id: string;
  added_at: string;
  rating: number;
  review: string;
};
type LocalDeletedWordRow = {
  id: number;
  user_word_id: string;
  deleted_at: string;
};
type LocalDeletedBookRow = {
  id: number;
  user_book_id: string;
  deleted_at: string;
};
type LocalDeletedCategoryRow = {
  id: number;
  user_book_category_id: string;
  deleted_at: string;
};
type LocalDirtyBookRow = { user_book_id: string };

type PulledUserWord = {
  id: string;
  word: string;
  definition: string;
  mastery: number;
  addedAt: string;
  userBookId: string | null;
  seq: number;
};
type PulledUserBook = {
  id: string;
  addedAt: string;
  title: string;
  author: string | null;
  userBookCategoryId: string | null;
  seq: number;
};
type PulledUserBookCategory = {
  id: string;
  addedAt: string;
  name: string;
  seq: number;
};
type PulledLearnEvent = {
  id: string;
  userWordId: string;
  timestamp: string;
  seq: number;
};
type PulledUserBookReview = {
  id: string;
  userBookId: string;
  addedAt: string;
  rating: number;
  review: string;
  seq: number;
};
type PulledDeletedWord = { seq: number; userWordId: string; deletedAt: string };
type PulledDeletedBook = { seq: number; userBookId: string; deletedAt: string };
type PulledDeletedCategory = {
  seq: number;
  userBookCategoryId: string;
  deletedAt: string;
};

// Everything needed to push whatever's currently unsynced, gathered once and
// shared between runSync (push+pull) and pushOnly (push, no pull) so the two
// don't duplicate the "what's unsynced" logic.
async function gatherPush(db: SQLiteDatabase) {
  const [
    userWordsCursor,
    userBooksCursor,
    userBookCategoriesCursor,
    sentencesCursor,
    learnEventsCursor,
    userBookReviewsCursor,
    deletedWordsCursor,
    deletedBooksCursor,
    deletedCategoriesCursor,
  ] = await Promise.all([
    getCursor(db, "user_words"),
    getCursor(db, "user_books"),
    getCursor(db, "user_book_categories"),
    getCursor(db, "sentences"),
    getCursor(db, "learn_events"),
    getCursor(db, "user_book_reviews"),
    getCursor(db, "deleted_words"),
    getCursor(db, "deleted_books"),
    getCursor(db, "deleted_categories"),
  ]);

  const unsyncedUserWords = await db.getAllAsync<LocalUserWordRow>(
    `SELECT local_id, id, word, definition, mastery, added_at, user_book_id
     FROM user_words WHERE local_id > ? ORDER BY local_id`,
    [userWordsCursor.last_pushed_rowid],
  );
  const unsyncedUserBooks = await db.getAllAsync<LocalUserBookRow>(
    `SELECT local_id, id, added_at, title, author, user_book_category_id
     FROM user_books WHERE local_id > ? ORDER BY local_id`,
    [userBooksCursor.last_pushed_rowid],
  );
  // Books whose category changed after they were already pushed once - the
  // local_id cursor above only ever looks forward for brand-new rows, so a
  // reassignment to an already-synced book would otherwise never get sent
  // at all. See user_books_dirty's comment in db/client.ts. Only fetched
  // for ids not already covered by unsyncedUserBooks above (a book both
  // added and reassigned before its first-ever push doesn't need a second,
  // separate fetch).
  const dirtyBookRows = await db.getAllAsync<LocalDirtyBookRow>(
    "SELECT user_book_id FROM user_books_dirty",
  );
  const dirtyBookIds = dirtyBookRows.map((d) => d.user_book_id);
  const alreadyPushedIds = new Set(unsyncedUserBooks.map((b) => b.id));
  const extraDirtyIds = dirtyBookIds.filter((id) => !alreadyPushedIds.has(id));
  const resentUserBooks =
    extraDirtyIds.length > 0
      ? await db.getAllAsync<LocalUserBookRow>(
          `SELECT local_id, id, added_at, title, author, user_book_category_id
           FROM user_books WHERE id IN (${extraDirtyIds.map(() => "?").join(",")})`,
          extraDirtyIds,
        )
      : [];
  // The actual push payload - unsyncedUserBooks stays separate below since
  // it alone (not this resent set) drives the local_id cursor.
  const pushUserBooks = [...unsyncedUserBooks, ...resentUserBooks];
  const unsyncedUserBookCategories =
    await db.getAllAsync<LocalUserBookCategoryRow>(
      `SELECT local_id, id, added_at, name
       FROM user_book_categories WHERE local_id > ? ORDER BY local_id`,
      [userBookCategoriesCursor.last_pushed_rowid],
    );
  const unsyncedSentences = await db.getAllAsync<LocalSentenceRow>(
    "SELECT id, created_at, word, body FROM sentences WHERE id > ? ORDER BY id",
    [sentencesCursor.last_pushed_rowid],
  );
  const unsyncedLearnEvents = await db.getAllAsync<LocalLearnEventRow>(
    "SELECT local_id, id, user_word_id, timestamp FROM learn_events WHERE local_id > ? ORDER BY local_id",
    [learnEventsCursor.last_pushed_rowid],
  );
  const unsyncedUserBookReviews = await db.getAllAsync<LocalUserBookReviewRow>(
    `SELECT local_id, id, user_book_id, added_at, rating, review
     FROM user_book_reviews WHERE local_id > ? ORDER BY local_id`,
    [userBookReviewsCursor.last_pushed_rowid],
  );
  const unsyncedDeletedWords = await db.getAllAsync<LocalDeletedWordRow>(
    "SELECT id, user_word_id, deleted_at FROM deleted_words WHERE id > ? ORDER BY id",
    [deletedWordsCursor.last_pushed_rowid],
  );
  const unsyncedDeletedBooks = await db.getAllAsync<LocalDeletedBookRow>(
    "SELECT id, user_book_id, deleted_at FROM deleted_books WHERE id > ? ORDER BY id",
    [deletedBooksCursor.last_pushed_rowid],
  );
  const unsyncedDeletedCategories =
    await db.getAllAsync<LocalDeletedCategoryRow>(
      "SELECT id, user_book_category_id, deleted_at FROM deleted_categories WHERE id > ? ORDER BY id",
      [deletedCategoriesCursor.last_pushed_rowid],
    );
  // Always sent in full - this table is small and bounded (one row per
  // active day), so it syncs as "merge the whole list" rather than needing
  // its own cursor. Still pulled back in full on runSync's pull side.
  const activityRows = await db.getAllAsync<{ day: string }>(
    "SELECT day FROM user_activity",
  );

  return {
    userWordsCursor,
    userBooksCursor,
    userBookCategoriesCursor,
    sentencesCursor,
    learnEventsCursor,
    userBookReviewsCursor,
    deletedWordsCursor,
    deletedBooksCursor,
    deletedCategoriesCursor,
    unsyncedUserWords,
    unsyncedUserBooks,
    pushUserBooks,
    dirtyBookIds,
    unsyncedUserBookCategories,
    unsyncedSentences,
    unsyncedLearnEvents,
    unsyncedUserBookReviews,
    unsyncedDeletedWords,
    unsyncedDeletedBooks,
    unsyncedDeletedCategories,
    activityRows,
  };
}

type PushGather = Awaited<ReturnType<typeof gatherPush>>;

async function sendPush(
  token: string,
  g: PushGather,
): Promise<{
  token: string | null;
  pull: {
    userWords: PulledUserWord[];
    userBooks: PulledUserBook[];
    userBookCategories: PulledUserBookCategory[];
    learnEvents: PulledLearnEvent[];
    userBookReviews: PulledUserBookReview[];
    deletedWords: PulledDeletedWord[];
    deletedBooks: PulledDeletedBook[];
    deletedCategories: PulledDeletedCategory[];
    activityDays: string[];
  };
}> {
  const res = await fetch(`${API_BASE_URL}/api/sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      push: {
        userWords: g.unsyncedUserWords.map((w) => ({
          id: w.id,
          word: w.word,
          definition: w.definition,
          mastery: w.mastery,
          addedAt: w.added_at,
          userBookId: w.user_book_id,
        })),
        userBooks: g.pushUserBooks.map((b) => ({
          id: b.id,
          addedAt: b.added_at,
          title: b.title,
          author: b.author,
          userBookCategoryId: b.user_book_category_id,
        })),
        userBookCategories: g.unsyncedUserBookCategories.map((c) => ({
          id: c.id,
          addedAt: c.added_at,
          name: c.name,
        })),
        sentences: g.unsyncedSentences.map((s) => ({
          createdAt: s.created_at,
          word: s.word,
          body: s.body,
        })),
        learnEvents: g.unsyncedLearnEvents.map((e) => ({
          id: e.id,
          userWordId: e.user_word_id,
          timestamp: e.timestamp,
        })),
        userBookReviews: g.unsyncedUserBookReviews.map((r) => ({
          id: r.id,
          userBookId: r.user_book_id,
          addedAt: r.added_at,
          rating: r.rating,
          review: r.review,
        })),
        deletedWords: g.unsyncedDeletedWords.map((d) => ({
          userWordId: d.user_word_id,
          deletedAt: d.deleted_at,
        })),
        deletedBooks: g.unsyncedDeletedBooks.map((d) => ({
          userBookId: d.user_book_id,
          deletedAt: d.deleted_at,
        })),
        deletedCategories: g.unsyncedDeletedCategories.map((d) => ({
          userBookCategoryId: d.user_book_category_id,
          deletedAt: d.deleted_at,
        })),
        activityDays: g.activityRows.map((r) => r.day),
      },
      cursors: {
        userWordsSeq: g.userWordsCursor.last_pulled_seq,
        userBooksSeq: g.userBooksCursor.last_pulled_seq,
        userBookCategoriesSeq: g.userBookCategoriesCursor.last_pulled_seq,
        learnEventsSeq: g.learnEventsCursor.last_pulled_seq,
        userBookReviewsSeq: g.userBookReviewsCursor.last_pulled_seq,
        deletedWordsSeq: g.deletedWordsCursor.last_pulled_seq,
        deletedBooksSeq: g.deletedBooksCursor.last_pulled_seq,
        deletedCategoriesSeq: g.deletedCategoriesCursor.last_pulled_seq,
      },
    }),
  });
  if (!res.ok) {
    // A rejected token means every subsequent call is going to fail the
    // exact same way until the user logs in again - firing this here,
    // right where it's actually detected, means it fires regardless of
    // which caller's push/pull triggered this request (the on-open one,
    // a per-action debounced one, whichever), not just the one the app
    // happens to run first.
    if (res.status === 401) onUnauthorized?.();
    // Temporary: sync+api.ts's catch-all includes the real error under
    // "detail" specifically so it can surface here, in the same overlay
    // this throw shows up in - avoids needing the dev server's own
    // terminal output to diagnose a failure.
    const body: { error?: string; detail?: string } | null = await res
      .json()
      .catch(() => null);
    throw new Error(
      `sync failed: ${res.status} ${body?.detail ?? body?.error ?? ""}`,
    );
  }
  const body = await res.json();
  // Most responses don't carry a replacement token (see sync+api.ts's own
  // threshold check) - only fire the handler on the calls that actually do.
  if (typeof body.token === "string") onTokenRefreshed?.(body.token);
  return body;
}

// Push whatever's new locally since the last successful push, then pull
// whatever's new server-side since the last successful pull - in that order,
// via one request, so the pull naturally reflects this device's own just-
// pushed changes (the server applies push before running the pull query).
// Used on mount only - per-action syncing goes through requestPush below.
export async function runSync(token: string): Promise<void> {
  const db = await getDatabase();
  const g = await gatherPush(db);
  const { pull } = await sendPush(token, g);
  await clearDirtyBooks(db, g.dirtyBookIds);

  // Applied before userBooks - a pulled book's user_book_category_id can
  // reference one of these rows (a real FK - see the CREATE TABLE IF NOT
  // EXISTS in db/client.ts), so the category needs to exist locally first or
  // the insert below would be rejected outright. Plain insert-only, like
  // userBookReviews below - a category name is either created or it isn't.
  for (const c of pull.userBookCategories) {
    await db.runAsync(
      "INSERT OR IGNORE INTO user_book_categories (id, added_at, name) VALUES (?, ?, ?)",
      [c.id, c.addedAt, c.name],
    );
  }

  // Applied before userWords/userBookReviews - a pulled word's user_book_id
  // and a pulled review's user_book_id can both reference one of these rows
  // (the former now a real FK, ON DELETE SET NULL - see
  // ensureUserWordsBookForeignKey in db/client.ts), so the book needs to
  // exist locally first or the insert would be rejected outright.
  for (const b of pull.userBooks) {
    await db.runAsync(
      `INSERT OR IGNORE INTO user_books (id, added_at, title, author, user_book_category_id)
       VALUES (?, ?, ?, ?, ?)`,
      [b.id, b.addedAt, b.title, b.author, b.userBookCategoryId],
    );
  }

  for (const w of pull.userWords) {
    await db.runAsync(
      `INSERT OR IGNORE INTO user_words
       (id, word, definition, mastery, added_at, user_book_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [w.id, w.word, w.definition, w.mastery, w.addedAt, w.userBookId],
    );
  }

  for (const e of pull.learnEvents) {
    const result = await db.runAsync(
      "INSERT OR IGNORE INTO learn_events (id, user_word_id, timestamp) VALUES (?, ?, ?)",
      [e.id, e.userWordId, e.timestamp],
    );
    // Only bump mastery if this event was actually new - if it already
    // existed locally (this device's own event, echoed back by the pull),
    // re-applying it would double-count. Every learn_event now means "got
    // it right," so this is always +1, never a variable delta.
    if (result.changes > 0) {
      await db.runAsync(
        "UPDATE user_words SET mastery = mastery + 1 WHERE id = ?",
        [e.userWordId],
      );
    }
  }

  // Plain insert-only, unlike the old single rating/review fields - no
  // mastery-style side effect to (re-)apply, so no need to check whether
  // the row was actually new the way learn_events does above.
  for (const r of pull.userBookReviews) {
    await db.runAsync(
      "INSERT OR IGNORE INTO user_book_reviews (id, user_book_id, added_at, rating, review) VALUES (?, ?, ?, ?, ?)",
      [r.id, r.userBookId, r.addedAt, r.rating, r.review],
    );
  }

  for (const d of pull.deletedWords) {
    // Matched by exact id, not word text - a word re-added since this
    // tombstone was created always gets a fresh id, so this can only ever
    // delete the specific instance the tombstone was made for.
    await db.runAsync("DELETE FROM user_words WHERE id = ?", [d.userWordId]);
  }

  for (const d of pull.deletedBooks) {
    // Unlink first, then remove the book row - same order as the local
    // delete and the server's push-apply, so a word that raced the
    // deletion (added on another device before it saw this tombstone)
    // still ends up correctly unlinked once it does.
    await db.runAsync(
      "UPDATE user_words SET user_book_id = NULL WHERE user_book_id = ?",
      [d.userBookId],
    );
    await db.runAsync("DELETE FROM user_books WHERE id = ?", [d.userBookId]);
  }

  for (const d of pull.deletedCategories) {
    // Same unlink-then-remove order as deletedBooks above, one level up.
    await db.runAsync(
      "UPDATE user_books SET user_book_category_id = NULL WHERE user_book_category_id = ?",
      [d.userBookCategoryId],
    );
    await db.runAsync("DELETE FROM user_book_categories WHERE id = ?", [
      d.userBookCategoryId,
    ]);
  }

  for (const day of pull.activityDays) {
    await db.runAsync("INSERT OR IGNORE INTO user_activity (day) VALUES (?)", [
      day,
    ]);
  }

  await advanceCursor(
    db,
    "user_words",
    maxOf(g.unsyncedUserWords, "local_id"),
    maxOf(pull.userWords, "seq"),
  );
  await advanceCursor(
    db,
    "user_books",
    maxOf(g.unsyncedUserBooks, "local_id"),
    maxOf(pull.userBooks, "seq"),
  );
  await advanceCursor(
    db,
    "user_book_categories",
    maxOf(g.unsyncedUserBookCategories, "local_id"),
    maxOf(pull.userBookCategories, "seq"),
  );
  // sentences never has a pulled seq - push-only, see sync+api.ts.
  await advanceCursor(db, "sentences", maxOf(g.unsyncedSentences, "id"), null);
  await advanceCursor(
    db,
    "learn_events",
    maxOf(g.unsyncedLearnEvents, "local_id"),
    maxOf(pull.learnEvents, "seq"),
  );
  await advanceCursor(
    db,
    "user_book_reviews",
    maxOf(g.unsyncedUserBookReviews, "local_id"),
    maxOf(pull.userBookReviews, "seq"),
  );
  await advanceCursor(
    db,
    "deleted_words",
    maxOf(g.unsyncedDeletedWords, "id"),
    maxOf(pull.deletedWords, "seq"),
  );
  await advanceCursor(
    db,
    "deleted_books",
    maxOf(g.unsyncedDeletedBooks, "id"),
    maxOf(pull.deletedBooks, "seq"),
  );
  await advanceCursor(
    db,
    "deleted_categories",
    maxOf(g.unsyncedDeletedCategories, "id"),
    maxOf(pull.deletedCategories, "seq"),
  );
}

// Push only - no pull applied, even though the response technically includes
// one (same endpoint as runSync). Used after individual actions, where we
// deliberately don't want a pull's side effects (and don't want the extra
// round-trip cost of applying one) on every single learn attempt or word
// add/remove. Safe to call this independently of runSync's own schedule -
// see the comment above the pull section in sync+api.ts for why every
// pulled table tolerates push and pull happening on unrelated timelines.
async function pushOnly(token: string): Promise<void> {
  const db = await getDatabase();
  const g = await gatherPush(db);
  await sendPush(token, g);
  await clearDirtyBooks(db, g.dirtyBookIds);

  await advanceCursor(
    db,
    "user_words",
    maxOf(g.unsyncedUserWords, "local_id"),
    null,
  );
  await advanceCursor(
    db,
    "user_books",
    maxOf(g.unsyncedUserBooks, "local_id"),
    null,
  );
  await advanceCursor(
    db,
    "user_book_categories",
    maxOf(g.unsyncedUserBookCategories, "local_id"),
    null,
  );
  await advanceCursor(db, "sentences", maxOf(g.unsyncedSentences, "id"), null);
  await advanceCursor(
    db,
    "learn_events",
    maxOf(g.unsyncedLearnEvents, "local_id"),
    null,
  );
  await advanceCursor(
    db,
    "user_book_reviews",
    maxOf(g.unsyncedUserBookReviews, "local_id"),
    null,
  );
  await advanceCursor(
    db,
    "deleted_words",
    maxOf(g.unsyncedDeletedWords, "id"),
    null,
  );
  await advanceCursor(
    db,
    "deleted_books",
    maxOf(g.unsyncedDeletedBooks, "id"),
    null,
  );
  await advanceCursor(
    db,
    "deleted_categories",
    maxOf(g.unsyncedDeletedCategories, "id"),
    null,
  );
}

// Coalescing guard: at most one push in flight at a time. A trigger that
// arrives while one's already running doesn't start a second, overlapping
// request (which could race the in-flight one on the same not-yet-advanced
// cursor) - it just marks that another push is needed, and the in-flight
// one fires exactly one more push immediately after it finishes. That final
// push picks up everything that piled up in the meantime via the cursor, so
// nothing needs to track which specific actions were waiting - "did
// anything happen while I was busy" is enough. Also doubles as the retry
// mechanism for a failed push: pending stays true, so the next push (right
// after, or from the next foreground/mount) naturally includes whatever
// failed to go out last time.
let pushInFlight = false;
let pushPending = false;

export function requestPush(token: string): void {
  if (pushInFlight) {
    pushPending = true;
    return;
  }
  runPushLoop(token);
}

async function runPushLoop(token: string): Promise<void> {
  pushInFlight = true;
  pushPending = false;
  try {
    await pushOnly(token);
  } catch (error) {
    console.error("[push] failed", error);
  } finally {
    pushInFlight = false;
    if (pushPending) runPushLoop(token);
  }
}

// How long to wait after the last debounced trigger before actually
// pushing - long enough that a string of edits (dragging several books
// between categories, deleting and recreating a category) collapses into
// one push instead of one per action. 1500ms turned out too short for this
// in practice - each drag-and-drop itself (long-press, reposition, release)
// plus the pause to line up the next one easily exceeds it, so a real
// multi-book shuffle was still firing a push per drop instead of one at the
// end. Long enough to comfortably span that gap; still short enough that
// the tail push after the user actually stops shows up almost immediately.
const DEBOUNCED_PUSH_DELAY_MS = 4000;

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let debouncedToken: string | null = null;

// Debounced sibling of requestPush, for actions that tend to arrive in
// bursts on the collection page's category editing (add/remove a category,
// drag a book into a different one) - each call resets the timer rather
// than firing immediately, so a burst of them only reaches the server once,
// after things settle. Safe to let a pending timer get dropped (app
// backgrounded/killed before it fires, beyond what flushPendingPush below
// catches): local SQLite is already updated synchronously by the caller
// regardless of this timer, so the next runSync (mount, or foreground
// return) picks up whatever never got a chance to fire, same as any other
// failed/skipped push already does via pushPending above.
export function requestPushDebounced(token: string): void {
  debouncedToken = token;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    const t = debouncedToken;
    debouncedToken = null;
    if (t) requestPush(t);
  }, DEBOUNCED_PUSH_DELAY_MS);
}

// Fires a still-pending debounced push right away instead of waiting out
// the rest of its delay - call this when the app is about to leave the
// foreground, so a burst of category edits doesn't sit unsynced (invisible
// to other devices) until the user happens to reopen the app.
export function flushPendingPush(): void {
  if (!debounceTimer) return;
  clearTimeout(debounceTimer);
  debounceTimer = null;
  const t = debouncedToken;
  debouncedToken = null;
  if (t) requestPush(t);
}
