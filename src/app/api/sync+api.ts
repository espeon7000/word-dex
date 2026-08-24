import { getSql } from "@/server/db";
import { issueToken, requireAuth } from "@/server/jwt";

// How close to its own 30-day expiry (see jwt.ts's issueToken) a token has
// to be before this route bothers reissuing it - a sliding session, but not
// a literal "renew on every single call" one: as long as the app is opened
// at least this often, staying logged in never depends on hitting the exact
// 30-day mark, but a token nowhere near expiring just gets reused as-is
// instead of resigning a fresh JWT on every sync request for no reason.
const TOKEN_REFRESH_THRESHOLD_SECONDS = 7 * 24 * 60 * 60;

type PushPayload = {
  userWords: {
    id: string;
    word: string;
    definition: string;
    mastery: number;
    addedAt: string;
    userBookId: string | null;
  }[];
  userBooks: {
    id: string;
    addedAt: string;
    title: string;
    author: string | null;
    userBookCategoryId: string | null;
  }[];
  // Insert-only, like userBookReviews below - a category name is either
  // created or it isn't, no update path.
  userBookCategories: {
    id: string;
    addedAt: string;
    name: string;
  }[];
  sentences: { createdAt: string; word: string; body: string }[];
  // Every row means "answered correctly" - a wrong answer or a skip never
  // creates one, so there's no delta/skipped flag to carry.
  learnEvents: {
    id: string;
    userWordId: string;
    timestamp: string;
  }[];
  // Insert-only, like learnEvents - a book can have more than one review
  // over time, so there's no update path here, just new rows.
  userBookReviews: {
    id: string;
    userBookId: string;
    addedAt: string;
    rating: number;
    review: string;
  }[];
  deletedWords: { userWordId: string; deletedAt: string }[];
  deletedBooks: { userBookId: string; deletedAt: string }[];
  deletedCategories: { userBookCategoryId: string; deletedAt: string }[];
  activityDays: string[];
};

// No sentencesSeq - sentences are push-only, never pulled back (see the
// pull section below for why that's actually safe).
type Cursors = {
  userWordsSeq: number;
  userBooksSeq: number;
  userBookCategoriesSeq: number;
  learnEventsSeq: number;
  userBookReviewsSeq: number;
  deletedWordsSeq: number;
  deletedBooksSeq: number;
  deletedCategoriesSeq: number;
};

type SyncRequestBody = { push: PushPayload; cursors: Cursors };

export async function POST(request: Request) {
  try {
    const { userId, username, exp } = await requireAuth(request);
    const { push, cursors }: SyncRequestBody = await request.json();
    const sql = getSql();

    // Resolves each pushed category's client id to the id that will
    // actually exist server-side once the push below applies - itself,
    // unless a category with the same (user_id, name) already exists under
    // a *different* id (two devices independently creating the same-named
    // category before either had synced). In that case the category insert
    // below silently no-ops (its own comment explains why: an unqualified
    // ON CONFLICT DO NOTHING, absorbing this exact collision) and the
    // *existing* row's id wins - so every user_books row below that
    // referenced the losing client id needs remapping to it too, or it'd be
    // written as a foreign key to a category that was never actually
    // created, invisible until a fresh install's real local SQLite FK
    // rejects it on pull. A plain read, not part of the transaction below -
    // nothing here writes anything.
    const categoryIdRemap = new Map<string, string>();
    if (push.userBookCategories.length > 0) {
      const names = push.userBookCategories.map((c) => c.name);
      const existing = await sql`
        SELECT id, name FROM user_book_categories
        WHERE user_id = ${userId} AND name = ANY(${names})
      `;
      const idByName = new Map(
        existing.map((r) => [r.name as string, r.id as string]),
      );
      for (const c of push.userBookCategories) {
        categoryIdRemap.set(c.id, idByName.get(c.name) ?? c.id);
      }
    }
    const resolvedCategoryId = (id: string | null) =>
      id === null ? null : (categoryIdRemap.get(id) ?? id);

    // --- push: apply whatever this device has that the server doesn't yet ---
    // All in one transaction - previously these ran as separate statements, so
    // if one row later in the batch failed (eg. a learn_event whose user_word
    // insert was earlier in the same batch, or any other row-level error),
    // everything before it in the loop had already committed independently.
    // That's how the server ended up missing a user_words row while the
    // client's push cursor had already moved past it: a partial failure and a
    // full failure looked identical to the caller. One transaction makes a
    // partial failure impossible - it's all-or-nothing, so the client's
    // cursor bookkeeping can never drift from what the server actually has.

    if (
      push.userWords.length > 0 ||
      push.userBooks.length > 0 ||
      push.userBookCategories.length > 0 ||
      push.sentences.length > 0 ||
      push.learnEvents.length > 0 ||
      push.userBookReviews.length > 0 ||
      push.deletedWords.length > 0 ||
      push.deletedBooks.length > 0 ||
      push.deletedCategories.length > 0 ||
      push.activityDays.length > 0
    ) {
      await sql.transaction((txn) => {
        const queries = [];

        // Inserted before userBooks below - a book's user_book_category_id
        // can reference one of these rows, same FK-ordering reasoning as
        // userBooks before userWords further down. Unqualified ON CONFLICT
        // DO NOTHING (not ON CONFLICT (id)) - this table has a second unique
        // constraint, (user_id, name), that two offline devices creating the
        // same category name (with different client-generated ids) before
        // either syncs could hit; leaving the conflict target unspecified
        // absorbs either case instead of failing the whole transaction. One
        // device's row silently wins - both meant the same thing anyway.
        for (const c of push.userBookCategories) {
          queries.push(txn`
            INSERT INTO user_book_categories (id, user_id, added_at, name)
            VALUES (${c.id}, ${userId}, ${c.addedAt}, ${c.name})
            ON CONFLICT DO NOTHING
          `);
        }

        // Inserted before userWords below - a word's user_book_id can
        // reference one of these rows, and unlike SQLite, Postgres checks
        // FK constraints per-statement (not deferred), so the book has to
        // exist first within this same transaction. DO UPDATE (not DO
        // NOTHING) on a conflict, unlike every other id-keyed table here -
        // db/sync.ts's user_books_dirty resend deliberately re-sends an
        // already-pushed book (same id) after its category changes, and
        // needs this row to actually pick up the new value rather than
        // getting silently ignored as if it were just a retried insert.
        // title/author get harmlessly rewritten to the same value they
        // already have on a resend, since nothing else ever changes them.
        // The WHERE guard matters here specifically because DO UPDATE (unlike
        // DO NOTHING) would otherwise let a request authenticated as one user
        // overwrite another user's book just by colliding on its id - every
        // other table's id conflicts are harmless no-ops, but this one now
        // actually writes, so it needs its own ownership check.
        //
        // server_seq is bumped to a fresh value on every update, not just set
        // once at insert - pull (below, and every other device's) only fetches
        // rows past its own cursor, so a resend that left server_seq
        // untouched would be pushed successfully but then never actually
        // reach another device on a normal sync; it'd silently sit there
        // until that device did a full resync (eg. a fresh login, which
        // resets its cursor to 0). This is what made a category reassignment
        // on one device invisible on a second device without a full
        // logout/login.
        //
        // resolvedCategoryId (see above) rewrites the client's category id to
        // whichever one actually exists server-side, if two devices created
        // the same-named category independently - without this, a resend
        // could otherwise write a foreign key to a category id that the
        // insert above just silently declined to create.
        for (const b of push.userBooks) {
          queries.push(txn`
            INSERT INTO user_books (id, user_id, added_at, title, author, user_book_category_id)
            VALUES (
              ${b.id}, ${userId}, ${b.addedAt}, ${b.title}, ${b.author}, ${resolvedCategoryId(b.userBookCategoryId)}
            )
            ON CONFLICT (id) DO UPDATE SET
              title = EXCLUDED.title,
              author = EXCLUDED.author,
              user_book_category_id = EXCLUDED.user_book_category_id,
              server_seq = nextval('user_books_server_seq_seq')
            WHERE user_books.user_id = ${userId}
          `);
        }

        for (const w of push.userWords) {
          // Client-generated UUID, so a retried push just no-ops on conflict
          // instead of creating a duplicate word.
          queries.push(txn`
            INSERT INTO user_words
            (id, user_id, word, definition, mastery, added_at, user_book_id)
            VALUES (
              ${w.id}, ${userId}, ${w.word}, ${w.definition}, ${w.mastery}, ${w.addedAt}, ${w.userBookId}
            )
            ON CONFLICT (id) DO NOTHING
          `);
        }

        for (const s of push.sentences) {
          // Server assigns its own id - duplicates here are harmless, so no
          // conflict handling needed. Never pulled back down to any device
          // (see the pull section below), so there's no need to track the
          // assigned id at all here either.
          queries.push(txn`
            INSERT INTO sentences (user_id, created_at, word, body)
            VALUES (${userId}, ${s.createdAt}, ${s.word}, ${s.body})
          `);
        }

        const touchedWordIds = new Set<string>();
        for (const e of push.learnEvents) {
          queries.push(txn`
            INSERT INTO learn_events (id, user_word_id, timestamp)
            VALUES (${e.id}, ${e.userWordId}, ${e.timestamp})
            ON CONFLICT (id) DO NOTHING
          `);
          touchedWordIds.add(e.userWordId);
        }
        // Recomputed as a count over this word's own learn_events, not an
        // incremental "+1" update - a retried push already no-ops the
        // INSERT above via ON CONFLICT, but an incremental update has no such
        // protection and would double-count on a resend. Counting the
        // (deduplicated) rows is naturally idempotent: recomputing it twice
        // from the same underlying rows always gives the same answer. Every
        // row here is a correct attempt (see the PushPayload comment), so a
        // plain count is the whole computation - no delta to sum anymore.
        for (const wordId of touchedWordIds) {
          queries.push(txn`
            UPDATE user_words
            SET mastery = (SELECT COUNT(*) FROM learn_events WHERE user_word_id = ${wordId})
            WHERE id = ${wordId}
          `);
        }

        // Insert-only, same as learn_events above - a book can have more
        // than one review, so there's no update path, just new rows.
        for (const r of push.userBookReviews) {
          queries.push(txn`
            INSERT INTO user_book_reviews (id, user_book_id, added_at, rating, review)
            VALUES (${r.id}, ${r.userBookId}, ${r.addedAt}, ${r.rating}, ${r.review})
            ON CONFLICT (id) DO NOTHING
          `);
        }

        for (const d of push.deletedWords) {
          queries.push(txn`
            INSERT INTO deleted_words (user_id, user_word_id, deleted_at)
            VALUES (${userId}, ${d.userWordId}, ${d.deletedAt})
          `);
          // Matched by exact id, not word text - a word re-added since this
          // tombstone was created always gets a fresh id, so this can only
          // ever delete the specific instance the tombstone was made for.
          queries.push(txn`
            DELETE FROM user_words WHERE user_id = ${userId} AND id = ${d.userWordId}
          `);
        }

        for (const d of push.deletedBooks) {
          queries.push(txn`
            INSERT INTO deleted_books (user_id, user_book_id, deleted_at)
            VALUES (${userId}, ${d.userBookId}, ${d.deletedAt})
          `);
          // No FK from user_words.user_book_id to rely on, so both
          // consequences of the deletion are applied explicitly here - same
          // two statements the client runs locally and on pull-apply.
          queries.push(txn`
            UPDATE user_words SET user_book_id = NULL
            WHERE user_id = ${userId} AND user_book_id = ${d.userBookId}
          `);
          queries.push(txn`
            DELETE FROM user_books WHERE user_id = ${userId} AND id = ${d.userBookId}
          `);
        }

        for (const d of push.deletedCategories) {
          queries.push(txn`
            INSERT INTO deleted_categories (user_id, user_book_category_id, deleted_at)
            VALUES (${userId}, ${d.userBookCategoryId}, ${d.deletedAt})
          `);
          // Same unlink-then-remove as deletedBooks above, one level up - no
          // FK cascade relied on here either.
          queries.push(txn`
            UPDATE user_books SET user_book_category_id = NULL
            WHERE user_id = ${userId} AND user_book_category_id = ${d.userBookCategoryId}
          `);
          queries.push(txn`
            DELETE FROM user_book_categories WHERE user_id = ${userId} AND id = ${d.userBookCategoryId}
          `);
        }

        for (const day of push.activityDays) {
          queries.push(txn`
            INSERT INTO user_activity (user_id, day) VALUES (${userId}, ${day})
            ON CONFLICT (user_id, day) DO NOTHING
          `);
        }

        return queries;
      });
    }

    // --- pull: everything new since the provided cursors ---
    // Runs after the push above completes, in the same request, so this
    // naturally reflects whatever this device just pushed - no separate
    // round trip needed to get push-before-pull ordering right.
    //
    // sentences are deliberately excluded - they're push-only. Every other
    // table's pull-application is idempotent regardless of timing
    // (user_words/learn_events use INSERT OR IGNORE on a stable UUID,
    // deleted_words just re-applies an idempotent DELETE), so they tolerate
    // push and pull happening on completely independent schedules.
    // sentences never had that property (no stable cross-device id, plain
    // INSERT with no conflict handling) - the only reason it was safe to
    // pull before was that push and pull ran in the same request, letting
    // the server exclude exactly what this device just pushed. Once push
    // fires per-action instead of alongside every pull, that guarantee goes
    // away - so rather than carry that fragility forward, sentences simply
    // aren't part of the pull at all anymore. A word's example sentences are
    // low-stakes enough that "each device only shows what it personally
    // wrote" is an acceptable tradeoff for the simplicity this buys.

    // All 9 of these batched into one transaction() call - same reason as
    // the push side above, but for subrequests rather than atomicity: each
    // was previously its own separate `await sql` (its own fetch to Neon,
    // its own Cloudflare Workers subrequest), and stacked on top of the
    // fixed cost of the category-resolve + push transaction above, that was
    // enough on its own to trip Cloudflare's "too many subrequests per
    // Worker invocation" limit - even on a tiny, single-learn-event sync,
    // since this pull section runs unconditionally on every sync regardless
    // of payload size. One transaction here is however many logical queries
    // down to exactly 1 real network round trip, same as the push side.
    const [
      userWords,
      userBooks,
      userBookCategories,
      learnEvents,
      userBookReviews,
      deletedWords,
      deletedBooks,
      deletedCategories,
      activityRows,
    ] = await sql.transaction((txn) => [
      txn`
        SELECT id, word, definition, mastery, added_at AS "addedAt",
               user_book_id AS "userBookId", server_seq AS "seq"
        FROM user_words
        WHERE user_id = ${userId} AND server_seq > ${cursors.userWordsSeq}
        ORDER BY server_seq
      `,
      txn`
        SELECT id, added_at AS "addedAt", title, author,
               user_book_category_id AS "userBookCategoryId", server_seq AS "seq"
        FROM user_books
        WHERE user_id = ${userId} AND server_seq > ${cursors.userBooksSeq}
        ORDER BY server_seq
      `,
      txn`
        SELECT id, added_at AS "addedAt", name, server_seq AS "seq"
        FROM user_book_categories
        WHERE user_id = ${userId} AND server_seq > ${cursors.userBookCategoriesSeq}
        ORDER BY server_seq
      `,
      txn`
        SELECT le.id, le.user_word_id AS "userWordId", le.timestamp, le.server_seq AS "seq"
        FROM learn_events le
        JOIN user_words w ON w.id = le.user_word_id
        WHERE w.user_id = ${userId} AND le.server_seq > ${cursors.learnEventsSeq}
        ORDER BY le.server_seq
      `,
      // Ownership scoped the same way as learn_events - via a JOIN through
      // the parent row's user_id, not a user_id column on this table itself.
      txn`
        SELECT r.id, r.user_book_id AS "userBookId", r.added_at AS "addedAt",
               r.rating, r.review, r.server_seq AS "seq"
        FROM user_book_reviews r
        JOIN user_books b ON b.id = r.user_book_id
        WHERE b.user_id = ${userId} AND r.server_seq > ${cursors.userBookReviewsSeq}
        ORDER BY r.server_seq
      `,
      txn`
        SELECT id AS "seq", user_word_id AS "userWordId", deleted_at AS "deletedAt"
        FROM deleted_words
        WHERE user_id = ${userId} AND id > ${cursors.deletedWordsSeq}
        ORDER BY id
      `,
      txn`
        SELECT id AS "seq", user_book_id AS "userBookId", deleted_at AS "deletedAt"
        FROM deleted_books
        WHERE user_id = ${userId} AND id > ${cursors.deletedBooksSeq}
        ORDER BY id
      `,
      txn`
        SELECT id AS "seq", user_book_category_id AS "userBookCategoryId", deleted_at AS "deletedAt"
        FROM deleted_categories
        WHERE user_id = ${userId} AND id > ${cursors.deletedCategoriesSeq}
        ORDER BY id
      `,
      // Cast to text - the driver returns a native "date" column as a JS
      // Date object, which serializes to a full ISO timestamp (eg.
      // "2026-07-06T04:00:00.000Z", shifted by server timezone) rather than
      // the plain "YYYY-MM-DD" string that was originally pushed. That broke
      // streak computation on any device other than the one that logged the
      // activity: the pulled value never matched computeStreak's exact
      // "YYYY-MM-DD" Set lookups, so synced days silently never counted.
      txn`
        SELECT day::text AS day FROM user_activity WHERE user_id = ${userId}
      `,
    ]);

    // Sliding session, not a fixed 30-day-from-login expiry: this app talks
    // to the server on every open and every foreground return (see
    // CollectionProvider's own mount effect), so a token only ever gets
    // this close to expiring if the app genuinely hasn't been opened in
    // ~23 days - reissuing here means "still using the app every so often"
    // is what actually keeps you logged in, not "it's been under 30 days
    // since you last typed a password." null (no reissue) is the common
    // case; the client (sync.ts's sendPush) only persists a replacement
    // token when one actually comes back.
    const token =
      exp - Math.floor(Date.now() / 1000) <= TOKEN_REFRESH_THRESHOLD_SECONDS
        ? await issueToken(userId, username)
        : null;

    return Response.json({
      token,
      pull: {
        userWords,
        userBooks,
        userBookCategories,
        learnEvents,
        userBookReviews,
        deletedWords,
        deletedBooks,
        deletedCategories,
        activityDays: activityRows.map((r) => r.day),
      },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[sync] error", error);
    // Temporary: surfaces the real error to the client instead of just the
    // generic message, so it shows up in the in-app error overlay directly -
    // no terminal access to the dev server needed to diagnose a failure.
    const detail = error instanceof Error ? error.message : String(error);
    return Response.json(
      { error: "something went wrong", detail },
      { status: 500 },
    );
  }
}
