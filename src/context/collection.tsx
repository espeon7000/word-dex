import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState } from "react-native";
import { useRouter } from "expo-router";
import { useDrizzleStudio } from "expo-drizzle-studio-plugin";
import type { SQLiteDatabase } from "expo-sqlite";

import {
  generateId,
  getDatabase,
  getDatabaseSync,
  hashBookId,
} from "@/db/client";
import {
  flushPendingPush,
  requestPush,
  requestPushDebounced,
  runSync,
} from "@/db/sync";
import { useThemeContext } from "@/context/theme";
import { reportError } from "@/lib/report-error";
import type { Entry } from "@/types/dictionary";

// The mastery value at which a word stops being "still learning" - shared
// so app/collection.tsx's own mastery-sort grouping and app/learn.tsx's
// quiz-mode selection (multiple choice vs sentence-writing) always agree on
// exactly the same line, rather than two separate hardcoded 5s drifting
// apart if one ever changes.
export const MASTERED_MASTERY_THRESHOLD = 5;

// How long the app can sit backgrounded before coming back counts as "closed
// and reopened" rather than "still mid-something" - a half-typed learn
// sentence, an unsaved book review draft, an open add-book search, whatever's
// on the discover screen, collection's own view/sort preferences - all
// otherwise just live in React state with nothing writing them to disk as a
// draft. Under this, backgrounding is a no-op and everything's still there
// on return. At/over it, resetGeneration below bumps, which every screen's
// own effect reacts to by clearing its own local draft state - see the
// AppState effect further down for why this doesn't remount/unmount
// anything to achieve that (an earlier version did exactly that - keyed a
// provider on a counter, forcing the whole screen tree to tear down and
// rebuild - which both flashed an empty "no books added yet" state for a
// frame while the remounted provider's data was still reloading from
// SQLite, and didn't even reliably land back on the discover tab, since
// expo-router's own navigation state lives above anything this file can
// remount anyway).
//
const BACKGROUND_RESET_MS = 5 * 60_000;

// Fire-and-forget persistence for the optimistic local-state updates below -
// logs instead of failing silently, since these run detached from any caller
// that could otherwise surface an error.
function persist(task: (db: SQLiteDatabase) => Promise<unknown>) {
  getDatabase()
    .then(task)
    .catch((error) => reportError("[collection] write failed", error));
}

export type BookInfo = {
  title: string;
  author: string | null;
  genre: string | null;
};

// A user_books row as exposed for display (the collection page's books
// list) - BookInfo plus the identity/ordering fields that view needs but
// BookInfo itself doesn't (BookInfo is also used for "a book picked for a
// word" via search, which never has an id/addedAt yet - those only exist
// once a book is actually a saved user_books row).
export type CollectionBook = BookInfo & {
  id: string;
  addedAt: string;
};

// One row from user_book_reviews - a book can have more than one of these
// over time (eg. re-rating after a re-read), so unlike the old single
// rating/review/reviewDate on CollectionBook, this is a separate list rather
// than fields on the book itself.
export type BookReview = {
  id: string;
  bookId: string;
  addedAt: string;
  rating: number;
  review: string;
};

// One row from user_book_categories - exposed separately from CollectionBook
// (which only carries a category's *name* via the genre field, joined in at
// read time) because assigning a book to a category needs the category's id,
// and because a category can exist with zero books in it.
export type Category = {
  id: string;
  name: string;
  addedAt: string;
};

export type CollectionEntry = {
  id: string;
  word: string;
  definition: string;
  mastery: number;
  addedAt: string;
  sentences: string[];
  book: BookInfo | null;
};

// The collection screen's own view/sort preferences - state, not just
// types, lives here too (see CollectionProvider below) rather than as local
// useState in app/collection.tsx, specifically so it survives ordinary tab
// navigation (this provider wraps AppTabs and never unmounts just from
// switching tabs) while still resetting to these defaults whenever
// _layout.tsx's background timer decides the app counts as freshly
// reopened (that remounts everything under AuthProvider, this provider
// included) - deliberately NOT persisted to AsyncStorage, since a "fresh
// open" should genuinely mean fresh, not silently remembering whatever was
// selected days ago.
export type ViewMode = "books" | "words";
export type SortMode = "date" | "mastery" | "book" | "author" | "az";
export type SortDirection = "asc" | "desc";
export type BookSortMode = "rating" | "category" | "date" | "title" | "author";

type CollectionContextValue = {
  entries: CollectionEntry[];
  entriesByMastery: CollectionEntry[];
  // Distinct books, newest first - sourced straight from user_books (not
  // derived from entries/user_words), since that table is now the actual
  // source of truth for "what books does this account have."
  books: CollectionBook[];
  // Every review for every book, newest first - unlike books/entries above,
  // this is a flat list rather than nested onto CollectionBook, since a book
  // can have any number of these. Callers filter by bookId themselves.
  bookReviews: BookReview[];
  // Every category the account has created, regardless of whether any book
  // currently belongs to it - the books list's "category" sort mode shows
  // empty categories too, which needs this full list rather than just
  // whatever names happen to show up on books.
  categories: Category[];
  loaded: boolean;
  add: (entry: Entry, book: BookInfo | null) => void;
  // Adds a book with no word attached - for the books tab's own "+" button.
  addBook: (book: BookInfo) => void;
  remove: (word: string) => void;
  removeBook: (bookId: string) => void;
  // Plain insert, unlike the old updateBookRating - a book can have more
  // than one of these, so this never overwrites a prior review, and (unlike
  // updateBookRating) actually syncs, since an insert-only log needs none of
  // the update-propagation machinery a single mutable field would have.
  addBookReview: (bookId: string, rating: number, review: string) => void;
  // Resolves true once the category's actually been created, false if a
  // category with this exact name already exists (the caller - AddBookPrompt
  // - jiggles instead of inserting). Unlike every other mutator here, this
  // one has to be awaited end-to-end rather than fired-and-forgotten, since
  // the caller needs that duplicate result synchronously to decide.
  addCategory: (name: string) => Promise<boolean>;
  // Only ever called with a real category id - n/a isn't a row that can be
  // removed. Books that pointed at it fall back to n/a themselves.
  removeCategory: (categoryId: string) => void;
  // Reassigns (or, with null, unassigns) a single book - unlike every other
  // mutator here, this can target a book that was already synced in a
  // previous push, so it can't just rely on the normal local_id-cursor push
  // path (that only ever looks forward for brand-new rows). See the
  // user_books_dirty bookkeeping in db/sync.ts for how the resend actually
  // happens.
  assignBookCategory: (bookId: string, categoryId: string | null) => void;
  has: (word: string) => boolean;
  recordSentence: (word: string, sentence: string) => void;
  recordActivity: () => void;
  streak: number;
  // Today's learn_events (each one a correctly-answered word), exposed as a
  // plain word list so learn.tsx's pool selection can filter against it
  // without knowing about SQL. Skipped/wrong-answer words are NOT tracked
  // here - they never create a learn_events row at all (see recordAttempt),
  // so learn.tsx tracks those itself, locally, just for today's queue
  // ordering.
  attemptedToday: string[];
  // Always a correct attempt - a wrong answer or a skip never reaches this
  // at all (see the comment on its definition below).
  recordAttempt: (word: string) => void;
  // Pure in-memory reset, no DB writes - unlike a "delete today's data"
  // testing tool, this doesn't touch learn_events at all. It exists so
  // learn.tsx can self-correct attemptedToday the moment it notices a day
  // rolled over while the app stayed open (see its own ensureCurrentDay),
  // without waiting for a reload or the swipe-down-on-done gesture.
  clearAttemptedToday: () => void;
  // Fresh read of just today's attempted words, bypassing React state - see
  // the comment on getTodaysActivity's definition for why.
  getTodaysActivity: () => Promise<{
    attemptedToday: string[];
  }>;
  // Collection screen's own view/sort state - see the comment on ViewMode
  // above for why this lives here instead of app/collection.tsx's local
  // useState.
  viewMode: ViewMode;
  setViewMode: React.Dispatch<React.SetStateAction<ViewMode>>;
  sortMode: SortMode;
  setSortMode: React.Dispatch<React.SetStateAction<SortMode>>;
  sortDirection: SortDirection;
  setSortDirection: React.Dispatch<React.SetStateAction<SortDirection>>;
  bookSortMode: BookSortMode;
  setBookSortMode: React.Dispatch<React.SetStateAction<BookSortMode>>;
  bookSortDirection: SortDirection;
  setBookSortDirection: React.Dispatch<React.SetStateAction<SortDirection>>;
  // Bumped once whenever the app's been backgrounded long enough to count
  // as freshly reopened (see BACKGROUND_RESET_MS's own comment above).
  // Screens watch this - not a remount - to reset their own local draft
  // state (an open add-book search, a mid-typed sentence, whatever's on the
  // discover screen), so nothing in the tree ever has to unmount for that
  // to happen.
  resetGeneration: number;
};

// book_title/book_author/book_genre aren't real user_words columns anymore -
// they're aliased in via a LEFT JOIN on user_books (see refresh()'s query),
// kept under these names so the rest of this mapping code didn't need to
// change shape, just where the values come from.
type WordRow = {
  id: string;
  word: string;
  definition: string;
  mastery: number;
  added_at: string;
  book_title: string | null;
  book_author: string | null;
  book_genre: string | null;
};

type SentenceRow = {
  id: number;
  created_at: string;
  word: string;
  body: string;
};

type LearnEventRow = {
  id: string;
  user_word_id: string;
  timestamp: string;
  word: string;
};

function byMasteryThenDate(a: CollectionEntry, b: CollectionEntry) {
  return (
    (a.mastery ?? 0) - (b.mastery ?? 0) || a.addedAt.localeCompare(b.addedAt)
  );
}

// Exported so learn.tsx can compare against the exact same "what day is it"
// definition when deciding whether its own today-scoped state has gone
// stale (see clearAttemptedToday below).
export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Consecutive days (ending today, or yesterday if today hasn't happened yet)
// with at least one word learned.
function computeStreak(activityDates: string[]): number {
  const days = new Set(activityDates);
  const cursor = new Date();
  if (!days.has(cursor.toISOString().slice(0, 10))) {
    cursor.setDate(cursor.getDate() - 1);
  }
  let streak = 0;
  while (days.has(cursor.toISOString().slice(0, 10))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

const CollectionContext = createContext<CollectionContextValue | null>(null);

export function CollectionProvider({
  email,
  token,
  children,
}: {
  email: string;
  token: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { shiftMoodFromText } = useThemeContext();
  const [entries, setEntries] = useState<CollectionEntry[]>([]);
  const [books, setBooks] = useState<CollectionBook[]>([]);
  const [bookReviews, setBookReviews] = useState<BookReview[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [activityDates, setActivityDates] = useState<string[]>([]);
  const [attemptedToday, setAttemptedToday] = useState<string[]>([]);
  const [resetGeneration, setResetGeneration] = useState(0);
  const backgroundedAtRef = useRef<number | null>(null);

  // Collection screen's view/sort state - see ViewMode's own comment above
  // for why it's declared here rather than as local state in
  // app/collection.tsx.
  const [viewMode, setViewMode] = useState<ViewMode>("books");
  const [sortMode, setSortMode] = useState<SortMode>("date");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [bookSortMode, setBookSortMode] = useState<BookSortMode>("rating");
  const [bookSortDirection, setBookSortDirection] =
    useState<SortDirection>("desc");

  // Lets Drizzle Studio (npx expo start, then open the DevTools plugin) browse
  // the live local database. Dev-only - never connects in a production build.
  useDrizzleStudio(__DEV__ ? getDatabaseSync() : null);

  // Re-reads local state into React state - called on mount (so the app
  // shows whatever's local immediately, with no network dependency), and
  // again after each sync pass picks up anything new from the server.
  const refresh = useCallback(async () => {
    const db = await getDatabase();
    // No user_id filtering anywhere below - logout wipes every local table
    // (see clearAllTables in db/client.ts), so whatever's here belongs to
    // whoever's currently logged in by construction.
    const words = await db.getAllAsync<WordRow>(
      `SELECT w.id, w.word, w.definition, w.mastery, w.added_at,
              ub.title AS book_title, ub.author AS book_author, ubc.name AS book_genre
       FROM user_words w
       LEFT JOIN user_books ub ON ub.id = w.user_book_id
       LEFT JOIN user_book_categories ubc ON ubc.id = ub.user_book_category_id
       ORDER BY w.added_at DESC`,
    );
    const bookRows = await db.getAllAsync<{
      id: string;
      title: string;
      author: string | null;
      category: string | null;
      added_at: string;
    }>(
      // Ordered by the more recent of the book's own added_at or its most
      // recently added word's added_at - a book you're actively tagging
      // words to should stay near the top (of book-prompt.tsx's
      // recentBooks, in particular) rather than getting pushed down by a
      // newer book that has no words on it yet. MAX() here is SQLite's
      // scalar (multi-argument) form, not the aggregate one - picks the
      // larger of the two ISO8601 strings, which sorts correctly since
      // they're all the same format.
      `SELECT ub.id, ub.title, ub.author, ubc.name AS category, ub.added_at
       FROM user_books ub
       LEFT JOIN user_book_categories ubc ON ubc.id = ub.user_book_category_id
       ORDER BY MAX(
         ub.added_at,
         COALESCE(
           (SELECT MAX(w.added_at) FROM user_words w WHERE w.user_book_id = ub.id),
           ub.added_at
         )
       ) DESC`,
    );
    const bookReviewRows = await db.getAllAsync<{
      id: string;
      user_book_id: string;
      added_at: string;
      rating: number;
      review: string;
    }>(
      "SELECT id, user_book_id, added_at, rating, review FROM user_book_reviews ORDER BY added_at DESC",
    );
    const categoryRows = await db.getAllAsync<{
      id: string;
      name: string;
      added_at: string;
    }>("SELECT id, name, added_at FROM user_book_categories ORDER BY name");
    const sentenceRows = await db.getAllAsync<SentenceRow>(
      "SELECT * FROM sentences ORDER BY created_at ASC",
    );
    const sentencesByWord = new Map<string, string[]>();
    for (const row of sentenceRows) {
      const list = sentencesByWord.get(row.word) ?? [];
      list.push(row.body);
      sentencesByWord.set(row.word, list);
    }
    const activityRows = await db.getAllAsync<{ day: string }>(
      "SELECT day FROM user_activity",
    );
    const today = todayISO();
    const todaysEvents = await db.getAllAsync<LearnEventRow>(
      `SELECT l.id, l.user_word_id, l.timestamp, w.word FROM learn_events l
       JOIN user_words w ON w.id = l.user_word_id
       WHERE substr(l.timestamp, 1, 10) = ?`,
      [today],
    );
    setEntries(
      words.map((w) => ({
        id: w.id,
        word: w.word,
        definition: w.definition,
        mastery: w.mastery,
        addedAt: w.added_at,
        sentences: sentencesByWord.get(w.word.toLowerCase()) ?? [],
        book: w.book_title
          ? { title: w.book_title, author: w.book_author, genre: w.book_genre }
          : null,
      })),
    );
    setBooks(
      bookRows.map((b) => ({
        id: b.id,
        title: b.title,
        author: b.author,
        genre: b.category,
        addedAt: b.added_at,
      })),
    );
    setBookReviews(
      bookReviewRows.map((r) => ({
        id: r.id,
        bookId: r.user_book_id,
        addedAt: r.added_at,
        rating: r.rating,
        review: r.review,
      })),
    );
    setCategories(
      categoryRows.map((c) => ({
        id: c.id,
        name: c.name,
        addedAt: c.added_at,
      })),
    );
    setActivityDates(activityRows.map((r) => r.day));
    setAttemptedToday(todaysEvents.map((e) => e.word));
    setLoaded(true);
  }, []);

  // Narrow, standalone query for just today's attempted words - doesn't
  // touch user_words/sentences/user_activity at all, unlike refresh() above.
  // Exists so a caller checking "is it still today" (eg. the learn screen's
  // swipe-down-on-done gesture) gets a genuinely fresh read without
  // re-fetching everything else refresh() happens to also load, and without
  // depending on attemptedToday React state, which only updates on the next
  // render and could still be stale from before a day change.
  const getTodaysActivity = useCallback(async () => {
    const db = await getDatabase();
    const today = todayISO();
    const todaysEvents = await db.getAllAsync<LearnEventRow>(
      `SELECT l.id, l.user_word_id, l.timestamp, w.word FROM learn_events l
       JOIN user_words w ON w.id = l.user_word_id
       WHERE substr(l.timestamp, 1, 10) = ?`,
      [today],
    );
    return {
      attemptedToday: todaysEvents.map((e) => e.word),
    };
  }, []);

  useEffect(() => {
    refresh();
  }, [email, refresh]);

  // Push local changes and pull server changes on login and whenever the app
  // returns to the foreground. Best-effort: a failed attempt (offline, server
  // hiccup) just means the next trigger tries again - local-first usage is
  // unaffected either way, this only ever adds data on top of it.
  //
  // Also where the "was this backgrounded long enough to count as freshly
  // reopened" check lives - same AppState listener the sync-on-foreground
  // logic already needs, so this just piggybacks on it rather than running a
  // second subscription. See BACKGROUND_RESET_MS's own comment for why this
  // resets in place (bump resetGeneration, reset view/sort state, navigate)
  // instead of remounting anything.
  useEffect(() => {
    let inFlight = false;
    const sync = () => {
      // Guards against overlapping runs (eg. the mount call and an AppState
      // "active" event landing close together) racing on sync_cursors -
      // sentences have no idempotency protection server-side, so two
      // concurrent pushes reading the same not-yet-advanced cursor would
      // each resend the same local rows and create real duplicates.
      if (inFlight) return;
      inFlight = true;
      runSync(token)
        .then(refresh)
        .catch((error) => reportError("[sync] failed", error))
        .finally(() => {
          inFlight = false;
        });
    };
    sync();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        const backgroundedAt = backgroundedAtRef.current;
        backgroundedAtRef.current = null;
        if (
          backgroundedAt !== null &&
          Date.now() - backgroundedAt >= BACKGROUND_RESET_MS
        ) {
          setViewMode("books");
          setSortMode("date");
          setSortDirection("desc");
          setBookSortMode("rating");
          setBookSortDirection("desc");
          setResetGeneration((g) => g + 1);
          router.navigate("/discover");
        }
        sync();
      } else {
        // Otherwise (background/inactive) - fire any category edit still
        // sitting in requestPushDebounced's window right away, rather than
        // leaving it unsynced until the user happens to reopen the app.
        flushPendingPush();
        if (backgroundedAtRef.current === null) {
          backgroundedAtRef.current = Date.now();
        }
      }
    });
    return () => subscription.remove();
  }, [token, refresh, router]);

  const add = useCallback(
    (entry: Entry, book: BookInfo | null) => {
      setEntries((prev) => {
        if (prev.some((e) => e.word === entry.word)) return prev;
        const id = generateId();
        const addedAt = new Date().toISOString();
        const definition = entry.meanings[0]?.definitions[0]?.definition ?? "";
        persist(async (db) => {
          // Deterministic id (see hashBookId) - this INSERT is idempotent by
          // construction, so no separate "does it already exist" check is
          // needed: whether this device already has the row, or another
          // device independently created the same book before either synced,
          // both converge on the same id and this just no-ops.
          let userBookId: string | null = null;
          if (book) {
            userBookId = await hashBookId(email, book.title, book.author);
            // user_book_category_id always starts null - it's user-assigned
            // (see addCategory below), never auto-derived from the picked
            // book's (currently always-null) genre field.
            await db.runAsync(
              "INSERT OR IGNORE INTO user_books (id, added_at, title, author, user_book_category_id) VALUES (?, ?, ?, ?, NULL)",
              [userBookId, addedAt, book.title, book.author],
            );
            // Same optimistic-update idea as entries below, just delayed
            // until here since the id depends on the async hashBookId - the
            // books list otherwise only ever changes on the next refresh()
            // (mount or a full sync), so a book added via a word wouldn't
            // show up on the books tab until then. If the book already
            // exists, this bumps it to the front rather than leaving it in
            // place - adding a word to an existing book counts as
            // "interacting" with it, same as refresh()'s own query, which
            // orders books by the more recent of their own added_at or
            // their most recently added word's added_at.
            const newBookId = userBookId;
            setBooks((prev) => {
              const existing = prev.find((b) => b.id === newBookId);
              if (existing) {
                return [existing, ...prev.filter((b) => b.id !== newBookId)];
              }
              return [
                {
                  id: newBookId,
                  title: book.title,
                  author: book.author,
                  genre: null,
                  addedAt,
                },
                ...prev,
              ];
            });
          }
          return db.runAsync(
            `INSERT INTO user_words
             (id, word, definition, mastery, added_at, user_book_id)
             VALUES (?, ?, ?, 0, ?, ?)`,
            [id, entry.word, definition, addedAt, userBookId],
          );
        });
        const next: CollectionEntry = {
          id,
          word: entry.word,
          definition,
          mastery: 0,
          addedAt,
          sentences: [],
          book,
        };
        return [next, ...prev].sort((a, b) =>
          b.addedAt.localeCompare(a.addedAt),
        );
      });
      requestPush(token);
      if (book) shiftMoodFromText(book.title);
    },
    [token, email, shiftMoodFromText],
  );

  // Same book-creation logic as add()'s book branch above, just without a
  // word attached - for the books tab's own "+" button, where there's no
  // entry driving the add.
  const addBook = useCallback(
    (book: BookInfo) => {
      const addedAt = new Date().toISOString();
      persist(async (db) => {
        const userBookId = await hashBookId(email, book.title, book.author);
        await db.runAsync(
          "INSERT OR IGNORE INTO user_books (id, added_at, title, author, user_book_category_id) VALUES (?, ?, ?, ?, NULL)",
          [userBookId, addedAt, book.title, book.author],
        );
        setBooks((prev) =>
          prev.some((b) => b.id === userBookId)
            ? prev
            : [
                {
                  id: userBookId,
                  title: book.title,
                  author: book.author,
                  genre: null,
                  addedAt,
                },
                ...prev,
              ],
        );
      });
      requestPush(token);
      shiftMoodFromText(book.title);
    },
    [token, email, shiftMoodFromText],
  );

  const remove = useCallback(
    (word: string) => {
      const wordId = entries.find((e) => e.word === word)?.id;
      setEntries((prev) => prev.filter((e) => e.word !== word));
      if (!wordId) return;
      persist(async (db) => {
        // Tombstone first so the removal survives to sync even though the
        // local row itself is about to be hard-deleted. Recorded by id, not
        // word text - a word re-added later gets a fresh id, so this
        // tombstone can only ever match the exact instance it was made for.
        await db.runAsync(
          "INSERT INTO deleted_words (user_word_id, deleted_at) VALUES (?, ?)",
          [wordId, new Date().toISOString()],
        );
        return db.runAsync("DELETE FROM user_words WHERE id = ?", [wordId]);
      });
      // Debounced, not immediate - same "burst of individual actions"
      // pattern requestPushDebounced was built for (see its own comment),
      // just from swipe-deleting several rows in a row instead of dragging
      // books between categories.
      requestPushDebounced(token);
    },
    [entries, token],
  );

  const removeBook = useCallback(
    (bookId: string) => {
      const removed = books.find((b) => b.id === bookId);
      setBooks((prev) => prev.filter((b) => b.id !== bookId));
      // Words that pointed at this book lose that association immediately
      // too, matched by title+author since CollectionEntry.book doesn't
      // carry the book's id - same optimistic-update reasoning as add()'s
      // book, otherwise this wouldn't show up until the next refresh().
      if (removed) {
        setEntries((prev) =>
          prev.map((e) =>
            e.book &&
            e.book.title === removed.title &&
            e.book.author === removed.author
              ? { ...e, book: null }
              : e,
          ),
        );
      }
      persist(async (db) => {
        // Tombstone first, same reasoning as remove()'s word tombstone -
        // survives to sync even though the local rows it drives (the book
        // itself, and any words pointing at it) are about to change. No FK
        // to cascade the unlink, so it's applied explicitly here - the
        // same two statements sync.ts's pull-apply and sync+api.ts's push
        // handler run for this same tombstone on every other device/server.
        await db.runAsync(
          "INSERT INTO deleted_books (user_book_id, deleted_at) VALUES (?, ?)",
          [bookId, new Date().toISOString()],
        );
        await db.runAsync(
          "UPDATE user_words SET user_book_id = NULL WHERE user_book_id = ?",
          [bookId],
        );
        return db.runAsync("DELETE FROM user_books WHERE id = ?", [bookId]);
      });
      // Debounced, not immediate - see remove()'s own comment above.
      requestPushDebounced(token);
    },
    [books, token],
  );

  // Unlike the old updateBookRating, this actually syncs - a plain insert
  // into an append-only log (same shape as recordAttempt/recordSentence)
  // needs none of the update-propagation machinery a single mutable
  // rating/review field on user_books would have required. A book can have
  // any number of these; this never overwrites a prior review, just adds
  // another one.
  const addBookReview = useCallback(
    (bookId: string, rating: number, review: string) => {
      const id = generateId();
      const addedAt = new Date().toISOString();
      setBookReviews((prev) => [
        { id, bookId, addedAt, rating, review },
        ...prev,
      ]);
      persist((db) =>
        db.runAsync(
          "INSERT INTO user_book_reviews (id, user_book_id, added_at, rating, review) VALUES (?, ?, ?, ?, ?)",
          [id, bookId, addedAt, rating, review],
        ),
      );
      requestPush(token);
      if (review.trim()) shiftMoodFromText(review.trim());
    },
    [token, shiftMoodFromText],
  );

  // Not the persist()/optimistic-state pattern every other mutator here
  // uses - the caller (AddBookPrompt) needs to know synchronously whether
  // this actually created a row or hit an existing name, so this awaits the
  // database directly instead of firing the write in the background.
  const addCategory = useCallback(
    async (name: string): Promise<boolean> => {
      const db = await getDatabase();
      const existing = await db.getFirstAsync(
        "SELECT 1 FROM user_book_categories WHERE name = ?",
        [name],
      );
      if (existing) return false;
      const id = generateId();
      const addedAt = new Date().toISOString();
      await db.runAsync(
        "INSERT INTO user_book_categories (id, added_at, name) VALUES (?, ?, ?)",
        [id, addedAt, name],
      );
      setCategories((prev) => [...prev, { id, name, addedAt }]);
      requestPushDebounced(token);
      return true;
    },
    [token],
  );

  // n/a isn't a real row here - it's the absence of a category, not a
  // deletable one - so this is only ever called with a genuine category id.
  // Same tombstone-first shape as removeBook: books that pointed at this
  // category lose that association immediately too, matched by genre name
  // (CollectionBook doesn't carry the category's id) for the optimistic
  // update, same reasoning as removeBook's own title+author match.
  const removeCategory = useCallback(
    (categoryId: string) => {
      const removed = categories.find((c) => c.id === categoryId);
      setCategories((prev) => prev.filter((c) => c.id !== categoryId));
      if (removed) {
        setBooks((prev) =>
          prev.map((b) =>
            b.genre === removed.name ? { ...b, genre: null } : b,
          ),
        );
      }
      persist(async (db) => {
        // Tombstone first, same reasoning as removeBook's own - survives to
        // sync even though the local rows it drives (the category itself,
        // and any books pointing at it) are about to change. No FK to
        // cascade the unlink on existing installs (see user_books_dirty's
        // own comment for why this table's FK can't be relied on), so it's
        // applied explicitly here - the same two statements sync.ts's
        // pull-apply and sync+api.ts's push handler run for this same
        // tombstone on every other device/server.
        await db.runAsync(
          "INSERT INTO deleted_categories (user_book_category_id, deleted_at) VALUES (?, ?)",
          [categoryId, new Date().toISOString()],
        );
        await db.runAsync(
          "UPDATE user_books SET user_book_category_id = NULL WHERE user_book_category_id = ?",
          [categoryId],
        );
        return db.runAsync("DELETE FROM user_book_categories WHERE id = ?", [
          categoryId,
        ]);
      });
      requestPushDebounced(token);
    },
    [categories, token],
  );

  // Back to the ordinary persist()/optimistic-state pattern, unlike
  // addCategory above - there's no duplicate check to await here, just a
  // reassignment. The local write also marks the book dirty (see
  // user_books_dirty in db/client.ts) - if this book was already synced in
  // an earlier push, its local_id is already below the push cursor, so
  // without that marker this change would never get resent.
  const assignBookCategory = useCallback(
    (bookId: string, categoryId: string | null) => {
      setBooks((prev) =>
        prev.map((b) =>
          b.id === bookId
            ? {
                ...b,
                genre: categoryId
                  ? (categories.find((c) => c.id === categoryId)?.name ??
                    null)
                  : null,
              }
            : b,
        ),
      );
      persist(async (db) => {
        await db.runAsync(
          "UPDATE user_books SET user_book_category_id = ? WHERE id = ?",
          [categoryId, bookId],
        );
        await db.runAsync(
          "INSERT OR IGNORE INTO user_books_dirty (user_book_id) VALUES (?)",
          [bookId],
        );
      });
      requestPushDebounced(token);
    },
    [token, categories],
  );

  const has = useCallback(
    (word: string) => entries.some((e) => e.word === word),
    [entries],
  );

  const recordSentence = useCallback((word: string, sentence: string) => {
    setEntries((prev) =>
      prev.map((e) =>
        e.word === word ? { ...e, sentences: [...e.sentences, sentence] } : e,
      ),
    );
    persist((db) =>
      db.runAsync(
        "INSERT INTO sentences (created_at, word, body) VALUES (?, ?, ?)",
        [new Date().toISOString(), word.toLowerCase(), sentence],
      ),
    );
  }, []);

  const recordActivity = useCallback(() => {
    const today = todayISO();
    setActivityDates((prev) => {
      if (prev.includes(today)) return prev;
      persist((db) =>
        db.runAsync("INSERT OR IGNORE INTO user_activity (day) VALUES (?)", [
          today,
        ]),
      );
      return [...prev, today];
    });
  }, []);

  // Logs a learn_events row and bumps the cached mastery column - always a
  // correct attempt. A wrong answer or a skip never reaches this at all:
  // they're not durable/synced events anymore, just a local "try this word
  // again later today" signal that learn.tsx tracks itself (see its own
  // deprioritizedToday state) without touching the database.
  const recordAttempt = useCallback(
    (word: string) => {
      const wordId = entries.find((e) => e.word === word)?.id;
      if (!wordId) return;
      setEntries((prev) =>
        prev.map((e) =>
          e.word === word ? { ...e, mastery: e.mastery + 1 } : e,
        ),
      );
      setAttemptedToday((prev) =>
        prev.includes(word) ? prev : [...prev, word],
      );
      persist((db) =>
        db
          .runAsync(
            "INSERT INTO learn_events (id, user_word_id, timestamp) VALUES (?, ?, ?)",
            [generateId(), wordId, new Date().toISOString()],
          )
          .then(() =>
            db.runAsync(
              "UPDATE user_words SET mastery = mastery + 1 WHERE id = ?",
              [wordId],
            ),
          ),
      );
      requestPush(token);
    },
    [entries, token],
  );

  const clearAttemptedToday = useCallback(() => {
    setAttemptedToday([]);
  }, []);

  const entriesByMastery = useMemo(
    () => [...entries].sort(byMasteryThenDate),
    [entries],
  );
  const streak = useMemo(() => computeStreak(activityDates), [activityDates]);

  return (
    <CollectionContext
      value={{
        entries,
        entriesByMastery,
        books,
        bookReviews,
        categories,
        loaded,
        add,
        addBook,
        remove,
        removeBook,
        addBookReview,
        addCategory,
        removeCategory,
        assignBookCategory,
        has,
        recordSentence,
        recordActivity,
        streak,
        attemptedToday,
        recordAttempt,
        clearAttemptedToday,
        getTodaysActivity,
        viewMode,
        setViewMode,
        sortMode,
        setSortMode,
        sortDirection,
        setSortDirection,
        bookSortMode,
        setBookSortMode,
        bookSortDirection,
        setBookSortDirection,
        resetGeneration,
      }}
    >
      {children}
    </CollectionContext>
  );
}

export function useCollection() {
  const ctx = useContext(CollectionContext);
  if (!ctx)
    throw new Error("useCollection must be used within CollectionProvider");
  return ctx;
}
