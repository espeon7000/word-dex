import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { Ionicons } from "@expo/vector-icons";

import { API_BASE_URL } from "@/constants/api";
import { Fonts, Spacing } from "@/constants/theme";
import { useCollection } from "@/context/collection";
import { PressableScale } from "@/components/pressable-scale";
import { useTheme } from "@/hooks/use-theme";
import { getCurrentToken } from "@/lib/auth-token";
import { reportError } from "@/lib/report-error";

// Short queries return noisy, mostly-irrelevant matches on Google Books -
// this keeps the same debounced-search UX Open Library needed, even though
// Google Books itself doesn't hard-reject short queries. Exported (along
// with searchBooks below) so other book-search UIs, like collection.tsx's
// AddBookPrompt, can reuse the same search behavior without duplicating the
// fetch/retry logic - they build their own JSX/styling, just share this.
export const MIN_QUERY_LENGTH = 3;
export const DEBOUNCE_MS = 400;
export const RESULT_LIMIT = 4;
export const RECENT_BOOKS_LIMIT = 4;

export type BookResult = {
  title: string;
  author: string | null;
  // Always null for now - Google Books' category data is too sparse/noisy
  // to be a reliable genre source (see searchBooks). Kept typed as
  // string | null rather than dropped, since BookInfo/the DB column still
  // expect it.
  genre: string | null;
};

type GoogleBooksVolume = {
  volumeInfo: {
    // Optional, not string - Google Books occasionally returns a volume
    // with no title at all (rare, but real - see searchBooksOnce's filter
    // below, which is what actually keeps one of these from reaching a
    // BookResult and crashing the title-reveal width math downstream).
    title?: string;
    authors?: string[];
  };
};
type GoogleBooksResponse = { items?: GoogleBooksVolume[]; totalItems: number };

// Retrying a transient 5xx (eg. Google's own "temporarily unavailable")
// after a short delay resolves most of them - a 429 (daily quota already
// exhausted) or other 4xx won't be fixed by trying again a moment later, so
// only 5xx is worth retrying.
const SEARCH_RETRY_DELAY_MS = 800;

// Calls our own /api/search-books rather than googleapis.com directly - see
// that route's own comment for why (this used to ship a real Google Books
// key in the app bundle via EXPO_PUBLIC_GOOGLE_BOOKS_API_KEY). getCurrentToken()
// (not useAuth() - this is a plain function, called from both this file's
// own BookPrompt and collection.tsx's AddBookPrompt) mirrors db/sync.ts's
// own token access.
async function searchBooksOnce(
  query: string,
  offset: number,
): Promise<{ results: BookResult[]; numFound: number }> {
  let res: Response;
  try {
    res = await fetch(
      `${API_BASE_URL}/api/search-books?q=${encodeURIComponent(query)}&offset=${offset}&maxResults=${RESULT_LIMIT}`,
      { headers: { Authorization: `Bearer ${getCurrentToken() ?? ""}` } },
    );
  } catch {
    // fetch() itself throwing (rather than resolving with some status) means
    // the request never reached the network at all - worth telling apart
    // from Google actually rejecting the request.
    throw new Error("network error");
  }
  if (!res.ok) {
    // Includes status + Google's own error reason (eg. quota exceeded vs a
    // malformed query) - a bare "search failed" gave no way to tell those
    // apart after the fact from the console log alone.
    const body = await res.json().catch(() => null);
    const reason = body?.error ?? res.statusText;
    throw Object.assign(new Error(`search failed: ${res.status} ${reason}`), {
      status: res.status,
    });
  }
  const data: GoogleBooksResponse = await res.json();
  // Not populated for now - see BookResult.genre.
  return {
    // A volume with no title isn't a usable result - nothing to show, save,
    // or even swipe-reveal (see GoogleBooksVolume's own comment on why this
    // filter exists at all).
    results: (data.items ?? [])
      .filter((item) => !!item.volumeInfo.title)
      .map((item) => ({
        title: item.volumeInfo.title as string,
        author: item.volumeInfo.authors?.[0] ?? null,
        genre: null,
      })),
    numFound: data.totalItems,
  };
}

export async function searchBooks(
  query: string,
  offset: number,
): Promise<{ results: BookResult[]; numFound: number }> {
  try {
    return await searchBooksOnce(query, offset);
  } catch (e: unknown) {
    const status =
      e instanceof Error
        ? (e as Error & { status?: number }).status
        : undefined;
    if (!status || status < 500) throw e;
    await new Promise((resolve) => setTimeout(resolve, SEARCH_RETRY_DELAY_MS));
    return searchBooksOnce(query, offset);
  }
}

// How far (px) a leftward swipe has to travel before it counts as "reveal
// the title," and the reveal/hold/hide timings - same values as
// collection.tsx's BookRow, whose title-clip gesture this mirrors, so every
// clipped book title in the app reveals at the same speed. Reveal is
// constant-speed (px/sec), not a fixed duration - a fixed duration made a
// heavily-clipped title slide brutally fast to cover its larger overflow in
// the same window as a barely-clipped one, which crawled by comparison.
const RESULT_TITLE_SWIPE_THRESHOLD = 24;
const RESULT_TITLE_REVEAL_PIXELS_PER_SECOND = 55;
const RESULT_TITLE_HIDE_DURATION = 350;
const RESULT_TITLE_REVEAL_PAUSE = 900;
const RESULT_TITLE_BOX_WIDTH = 2000;
// Fonts?.mono (styles.resultTitle's font) is genuinely monospace, so
// character count times this ratio closely estimates the title's actual
// rendered width - just enough to know how far to slide it into view,
// without an extra measuring pass.
const RESULT_MONO_CHAR_WIDTH = 16 * 0.62; // styles.resultTitle's fontSize

function estimateResultTitleWidth(text: string): number {
  return text.length * RESULT_MONO_CHAR_WIDTH;
}

function BookResultRow({
  book,
  onPress,
  borderColor,
  titleColor,
  authorColor,
  pressedColor,
  isLast,
}: {
  book: BookResult;
  onPress: () => void;
  borderColor: string;
  titleColor: string;
  authorColor: string;
  pressedColor: string;
  isLast: boolean;
}) {
  const [containerWidth, setContainerWidth] = useState(0);
  // Which display mode the title shows - the clipped, native-ellipsized
  // Text (rest) or the full, sliding title (mid-reveal). Plain state, not a
  // shared value, since switching which Text renders is a real content
  // change, not something a worklet-driven style alone can do.
  const [revealed, setRevealed] = useState(false);
  const titleTranslateX = useSharedValue(0);
  const estimatedTextWidth = useMemo(
    () => estimateResultTitleWidth(book.title),
    [book.title],
  );

  const revealTitle = () => {
    if (revealed) return; // already mid-animation - ignore a swipe until it resets
    const overflow = estimatedTextWidth - containerWidth;
    if (overflow <= 0) return; // already fully visible - nothing to reveal
    const revealDuration =
      (overflow / RESULT_TITLE_REVEAL_PIXELS_PER_SECOND) * 1000;
    setRevealed(true);
    titleTranslateX.value = withSequence(
      withTiming(-overflow, {
        duration: revealDuration,
        easing: Easing.linear,
      }),
      withDelay(
        RESULT_TITLE_REVEAL_PAUSE,
        withTiming(
          0,
          { duration: RESULT_TITLE_HIDE_DURATION, easing: Easing.linear },
          (finished) => {
            if (finished) runOnJS(setRevealed)(false);
          },
        ),
      ),
    );
  };

  // Threshold-triggered, fire-and-forget - unlike WordRow/BookRow's delete
  // swipe elsewhere, these rows don't live-track the finger, since there's
  // no drag-to-confirm affordance to show here, just a swipe that kicks off
  // the reveal animation once released past the threshold.
  const pan = Gesture.Pan()
    .activeOffsetX([-10, 10])
    .failOffsetY([-10, 10])
    .onEnd((e) => {
      if (e.translationX < -RESULT_TITLE_SWIPE_THRESHOLD) {
        runOnJS(revealTitle)();
      }
    });

  const titleStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: titleTranslateX.value }],
  }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View>
        <Pressable
          style={({ pressed }) => [
            styles.resultRow,
            { borderTopColor: borderColor },
            isLast && {
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderBottomColor: borderColor,
            },
            pressed && { backgroundColor: pressedColor },
          ]}
          onPress={onPress}
        >
          <View
            style={styles.resultTitleClip}
            onLayout={(e) => setContainerWidth(e.nativeEvent.layout.width)}
          >
            {revealed ? (
              <Animated.Text
                style={[
                  styles.resultTitle,
                  styles.resultTitleRevealed,
                  { color: titleColor },
                  titleStyle,
                ]}
              >
                {book.title}
              </Animated.Text>
            ) : (
              <Text
                style={[styles.resultTitle, { color: titleColor }]}
                numberOfLines={1}
              >
                {book.title}
              </Text>
            )}
          </View>
          {/* Always rendered (even with no author) so every row reserves the same
              height - opacity 0 keeps the space without showing anything, more
              reliable than guessing a fixed row height that has to match the
              text's actual line height. */}
          <Text
            style={[
              styles.resultAuthor,
              { color: authorColor },
              !book.author && styles.hiddenAuthor,
            ]}
            numberOfLines={1}
          >
            {book.author ?? " "}
          </Text>
        </Pressable>
      </Animated.View>
    </GestureDetector>
  );
}

// The parent mounts/unmounts this component entirely (rather than passing a
// `visible` flag and rendering null internally) specifically so each time it
// reopens is a fresh instance with clean useState defaults - no reset effect
// needed, and no risk of a stale-results frame flashing before one runs.
export default function BookPrompt({
  onDismiss,
  onSelectBook,
}: {
  onDismiss: () => void;
  onSelectBook: (book: BookResult) => void;
}) {
  const theme = useTheme();
  const { books } = useCollection();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<BookResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const [numFound, setNumFound] = useState(0);
  // True only once a completed search has confirmed zero matches for the
  // current query - reset on every keystroke so mid-typing/debounce-wait
  // state doesn't get mistaken for a confirmed empty result.
  const [searchedEmpty, setSearchedEmpty] = useState(false);
  // Set only for a genuine connectivity failure (see searchBooksOnce's own
  // "network error" throw) - other failures (quota, malformed query) just
  // log to console like before, since there's nothing the user can do about
  // those by retrying.
  const [searchError, setSearchError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);

  // Shared by both the debounced search-as-you-type effect and the reload
  // button, so pagination state (offset/numFound) stays consistent between
  // the two triggers instead of each managing its own copy.
  const runSearch = useCallback(
    async (searchQuery: string, searchOffset: number) => {
      setLoading(true);
      setSearchError(null);
      const requestId = ++requestIdRef.current;
      try {
        const { results: found, numFound: total } = await searchBooks(
          searchQuery,
          searchOffset,
        );
        if (requestId === requestIdRef.current) {
          setResults(found);
          setNumFound(total);
          setOffset(searchOffset);
          setSearchedEmpty(found.length === 0);
        }
      } catch (error) {
        reportError("[book-prompt] search failed", error);
        if (
          requestId === requestIdRef.current &&
          error instanceof Error &&
          error.message === "network error"
        ) {
          setSearchError("please restore connection");
        }
      } finally {
        if (requestId === requestIdRef.current) setLoading(false);
      }
    },
    [],
  );

  // Most recently added books, straight from user_books (already newest
  // first, already one row per distinct book - see collection.tsx's
  // hashBookId-based dedup) - no re-deriving from word entries needed.
  const recentBooks = useMemo(
    () => books.slice(0, RECENT_BOOKS_LIMIT),
    [books],
  );

  const showingRecent = query.trim().length === 0;

  // Recent books also fill in for the entire debounce wait + request round
  // trip after the first keystroke (not just once loading actually starts)
  // - otherwise the list disappears the instant you type, then reappears
  // once the debounce fires, then swaps to real results: a double flicker.
  // Once a search actually completes with zero matches, stop falling back -
  // an empty result set shouldn't be misread as "these are your matches".
  // A connectivity failure takes over this slot entirely instead of falling
  // back to recent books - showing recent books there would look like a
  // real (if sparse) result for the query just typed, not the searchError
  // message below explaining why nothing came back.
  const showRecentBooks =
    showingRecent || (results.length === 0 && !searchedEmpty && !searchError);
  const displayBooks = showRecentBooks ? recentBooks : results;

  // Debounced, prefix-style search - querying on every keystroke would feel
  // laggy and burns through Google Books' request quota unnecessarily.
  // Waiting for a pause in typing plus a minimum query length keeps it to
  // one request per "thought", not one per character.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setSearchedEmpty(false);
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setNumFound(0);
      setOffset(0);
      setLoading(false);
      setSearchError(null);
      return;
    }
    // A new query always starts back at the first page.
    debounceRef.current = setTimeout(() => runSearch(trimmed, 0), DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, runSearch]);

  // Wraps back to the first page once the next page would run past the end,
  // so tapping reload repeatedly cycles through all results rather than
  // dead-ending on the last (possibly partial) page.
  const handleReload = () => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH || loading) return;
    const nextOffset =
      offset + RESULT_LIMIT >= numFound ? 0 : offset + RESULT_LIMIT;
    runSearch(trimmed, nextOffset);
  };

  return (
    <View style={styles.backdrop}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onDismiss} />
      {/* Scoped to just this card (not the whole screen) - a screen-level
          KeyboardAvoidingView here previously caused the background/old
          search bar to shift too, which is why avoidingEnabled in
          discover.tsx disables that one while this prompt is open. */}
      <KeyboardAvoidingView
        behavior="position"
        keyboardVerticalOffset={Spacing.two}
        style={styles.avoidingWrap}
      >
        <View style={[styles.card, { backgroundColor: theme.background }]}>
          <Text style={[styles.prompt, { color: theme.text }]}>
            from a book?
          </Text>

          <View style={styles.searchRow}>
            <TextInput
              style={[
                styles.input,
                styles.searchInput,
                { backgroundColor: theme.backgroundElement, color: theme.text },
              ]}
              placeholderTextColor={theme.textSecondary}
              placeholder="search for a book"
              value={query}
              onChangeText={setQuery}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              onSubmitEditing={Keyboard.dismiss}
            />
            <PressableScale
              style={styles.reloadButton}
              onPress={handleReload}
              disabled={showingRecent || loading || numFound <= RESULT_LIMIT}
            >
              {loading ? (
                <ActivityIndicator size="small" color={theme.textSecondary} />
              ) : (
                <Ionicons
                  name="arrow-down"
                  size={18}
                  color={
                    showingRecent || numFound <= RESULT_LIMIT
                      ? theme.textSecondary
                      : theme.text
                  }
                />
              )}
            </PressableScale>
          </View>

          {searchError && !showingRecent && (
            <View style={styles.searchErrorBlock}>
              <Text
                style={[styles.searchErrorText, { color: theme.textSecondary }]}
              >
                {searchError}
              </Text>
            </View>
          )}

          {!searchError && displayBooks.length > 0 && (
            <ScrollView
              style={styles.results}
              keyboardShouldPersistTaps="handled"
            >
              {displayBooks.map((book, i) => (
                <BookResultRow
                  key={`${book.title}-${i}`}
                  book={book}
                  onPress={() => onSelectBook(book)}
                  borderColor={theme.separator}
                  titleColor={theme.text}
                  authorColor={theme.textSecondary}
                  pressedColor={theme.backgroundElement}
                  isLast={i === displayBooks.length - 1}
                />
              ))}
            </ScrollView>
          )}

          <PressableScale style={styles.skip} onPress={onDismiss}>
            <Text style={[styles.skipText, { color: theme.textSecondary }]}>
              skip
            </Text>
          </PressableScale>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.4)",
    paddingHorizontal: Spacing.five + Spacing.one,
  },
  avoidingWrap: {
    width: "100%",
  },
  card: {
    width: "100%",
    borderRadius: Spacing.four,
    paddingVertical: Spacing.four,
    gap: Spacing.three,
  },
  prompt: {
    fontSize: 20,
    fontWeight: "600",
    fontFamily: Fonts?.mono,
    textAlign: "center",
    paddingHorizontal: Spacing.four,
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.one,
    marginLeft: Spacing.three,
    marginRight: Spacing.one,
  },
  input: {
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
    fontSize: 16,
  },
  searchInput: {
    flex: 1,
    paddingVertical: 11,
  },
  reloadButton: {
    width: 44,
    height: 44,
    borderRadius: Spacing.two,
    alignItems: "center",
    justifyContent: "center",
  },
  results: {
    maxHeight: 220,
  },
  searchErrorBlock: {
    paddingVertical: Spacing.three,
    paddingHorizontal: Spacing.four,
    alignItems: "center",
  },
  searchErrorText: {
    fontSize: 14,
    fontFamily: Fonts?.mono,
    textAlign: "center",
  },
  resultRow: {
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.four,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  // Fixed height + overflow:hidden is what actually crops the title at
  // rest, and gives onLayout a real width to measure the reveal/clip
  // against - no explicit width, so it stretches to the row's full width
  // via the default column alignItems:stretch.
  resultTitleClip: {
    height: 20,
    overflow: "hidden",
  },
  resultTitle: {
    fontSize: 16,
    fontFamily: Fonts?.mono,
  },
  // Only used for the revealed (full-text) state - explicit, generous,
  // fixed width so it never wraps and simply extends past resultTitleClip's
  // edge for the swipe/translateX to reveal.
  resultTitleRevealed: {
    width: RESULT_TITLE_BOX_WIDTH,
  },
  resultAuthor: {
    fontSize: 13,
    marginTop: 2,
  },
  hiddenAuthor: {
    opacity: 0,
  },
  skip: {
    alignItems: "center",
    paddingTop: Spacing.one,
    paddingHorizontal: Spacing.four,
  },
  skipText: {
    fontSize: 14,
    fontFamily: Fonts?.mono,
    textDecorationLine: "underline",
  },
});
