import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Keyboard,
  LayoutAnimation,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  UIManager,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import DraggableFlatList, {
  ScaleDecorator,
} from "react-native-draggable-flatlist";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import type { ParamListBase } from "@react-navigation/native";
import { useNavigation, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import {
  DEBOUNCE_MS,
  MIN_QUERY_LENGTH,
  RESULT_LIMIT,
  searchBooks,
  type BookResult,
} from "@/components/book-prompt";
import ColorWheel from "@/components/color-wheel";
import {
  ExpandableReviewText,
  formatReviewDate,
} from "@/components/expandable-review-text";
import { PressableScale } from "@/components/pressable-scale";
import { Fonts, Spacing } from "@/constants/theme";
import { useAuth } from "@/context/auth";
import { MASTERED_MASTERY_THRESHOLD, useCollection } from "@/context/collection";
import type {
  BookReview,
  BookSortMode,
  CollectionBook,
  CollectionEntry,
  SortDirection,
  SortMode,
  ViewMode,
} from "@/context/collection";
import { useThemeContext } from "@/context/theme";
import { useTheme } from "@/hooks/use-theme";
import { fetchDefinition } from "@/lib/dictionary";
import type { Entry } from "@/types/dictionary";

// LayoutAnimation is opt-in on Android (already the default on iOS) - see
// the books list's draggableData sync effect for what this actually
// animates. setLayoutAnimationEnabled is real (and required here) but
// missing from RN's own types, hence the cast.
const androidUIManager = UIManager as unknown as {
  setLayoutAnimationEnabled?: (enabled: boolean) => void;
};
if (Platform.OS === "android" && androidUIManager.setLayoutAnimationEnabled) {
  androidUIManager.setLayoutAnimationEnabled(true);
}

// Drag distance (px) that counts as "completed the swipe" for the settings
// panel's edge-swipe-to-dismiss - 38% of screen width, not a fixed pixel
// count, so it scales with device width.
const COMPLETE_THRESHOLD = Dimensions.get("window").width * 0.38;
// Same idea, separate constant - word/book row delete swipes want an easier
// (shorter) threshold than the settings dismiss above, so they don't share
// COMPLETE_THRESHOLD even though the mechanics are otherwise identical.
const DELETE_THRESHOLD = Dimensions.get("window").width * 0.35;
// How far off the right edge the row slides once the swipe is confirmed.
const SLIDE_OFF_DISTANCE = Dimensions.get("window").width + 100;

// A fast enough rightward/downward flick completes a swipe-to-confirm
// gesture even from a short drag - matches how iOS/Instagram's own
// edge-swipe-back reads a decisive flick as "yes, go back" regardless of how
// far the finger actually traveled, rather than requiring a distance
// threshold to be crossed on its own. Shared by every such gesture in this
// file (settings dismiss, word/book row delete) - distance thresholds stay
// separate per gesture (DELETE_THRESHOLD is deliberately easier than
// COMPLETE_THRESHOLD), but a decisive flick reads the same regardless of
// which gesture it's on. px/sec, from the gesture event's own velocityX.
const SWIPE_VELOCITY_THRESHOLD = 950;
// Shared by every swipe-to-confirm gesture in this file (settings dismiss,
// word/book row delete) - tuned to settle without any bounce/overshoot (a
// row/page shouldn't wobble once it's off/back on screen), while still
// picking up the release velocity as its starting speed so the settle reads
// as a continuation of the swipe instead of a disconnected animation taking
// over once you let go.
const SWIPE_SPRING = { damping: 28, stiffness: 260, mass: 0.6 };

// Longest a username can render before getting cut off with "..".
const MAX_USERNAME_LENGTH = 14;
// Streak only shows once it's reached this many days.
const STREAK_MIN_TO_SHOW = 3;

type Section<T> = { header: string; items: T[] };

// Cycled through in this order by the single sort-mode button.
const SORT_MODES: SortMode[] = ["date", "mastery", "book", "author", "az"];
const SORT_MODE_LABELS: Record<SortMode, string> = {
  date: "date",
  mastery: "mastery",
  book: "book",
  author: "author",
  az: "a-z",
};

const BOOK_SORT_MODES: BookSortMode[] = [
  "rating",
  "category",
  "date",
  "title",
  "author",
];
const BOOK_SORT_MODE_LABELS: Record<BookSortMode, string> = {
  rating: "rating",
  category: "category",
  date: "date",
  title: "title",
  author: "author",
};

// Entries/books with no book/author/category attached still get a section
// rather than being dropped - grouped under these labels like any other
// group.
const NO_BOOK_LABEL = "n/a";
const NO_AUTHOR_LABEL = "n/a";
const NO_CATEGORY_LABEL = "n/a";

// Bands are 0, 1+, 5+, 10+, 50+, 100+, ... (every 50 after 10) - the wording
// stays "wow :D" for every band from 10+ on, but the number keeps climbing
// (10, 50, 100, 150...), so a jump into a new 50-band still gets its own
// header while entries within the same band merge into one section.
function masteryGroup(mastery: number): string {
  if (mastery === 0) return "not learned (0)";
  if (mastery < MASTERED_MASTERY_THRESHOLD) return "learning (1+)";
  if (mastery < 10) return "mastered (5+)";
  const threshold = mastery < 50 ? 10 : Math.floor(mastery / 50) * 50;
  return `wow :D (${threshold}+)`;
}

function monthGroup(addedAt: string): string {
  const d = new Date(addedAt);
  const month = d.toLocaleDateString("en-US", { month: "long" }).toLowerCase();
  const year = String(d.getFullYear() % 100).padStart(2, "0");
  return `${month} ${year}`;
}

type GroupCount = { value: string; count: number; mostRecent: string };

// entries is already sorted most-recently-added-first (see collection.tsx's
// add()), so the first occurrence of each key while iterating in order is
// automatically its most recent addedAt - no extra comparison needed.
function countBy(
  entries: CollectionEntry[],
  keyFor: (e: CollectionEntry) => string,
): Map<string, GroupCount> {
  const counts = new Map<string, GroupCount>();
  for (const e of entries) {
    const key = keyFor(e);
    const existing = counts.get(key);
    if (existing) {
      existing.count++;
    } else {
      counts.set(key, { value: key, count: 1, mostRecent: e.addedAt });
    }
  }
  return counts;
}

function groupConsecutive<T>(
  items: T[],
  keyFor: (item: T) => string,
): Section<T>[] {
  const sections: Section<T>[] = [];
  for (const item of items) {
    const key = keyFor(item);
    const last = sections[sections.length - 1];
    if (last && last.header === key) {
      last.items.push(item);
    } else {
      sections.push({ header: key, items: [item] });
    }
  }
  return sections;
}

// Shared between BookRow's rating circle and the books list's "rating" sort
// mode below - null (no reviews yet) rather than 0, so callers can tell
// "unrated" apart from "rated a genuine zero."
function averageBookRating(
  bookId: string,
  reviews: BookReview[],
): number | null {
  const ratings = reviews
    .filter((r) => r.bookId === bookId)
    .map((r) => r.rating);
  if (ratings.length === 0) return null;
  return ratings.reduce((sum, r) => sum + r, 0) / ratings.length;
}

// "Recent" for a book means whichever is more recent: the book's own
// addedAt, or the addedAt of its most recent review - reviewing an old book
// again should bring it back to the top the same way adding it fresh would,
// not leave it stuck wherever it originally landed. Used by both the books
// list's "date" sort mode and category mode's fixed within-group order (see
// their own comments for how each uses it) - ISO 8601 strings compare
// chronologically as plain strings, same as addedAt comparisons elsewhere
// in this file.
function latestBookActivity(book: CollectionBook, reviews: BookReview[]): string {
  let latest = book.addedAt;
  for (const r of reviews) {
    if (r.bookId === book.id && r.addedAt > latest) latest = r.addedAt;
  }
  return latest;
}

function WordRow({ entry }: { entry: CollectionEntry }) {
  const theme = useTheme();
  const router = useRouter();
  const { remove } = useCollection();
  const snippet = entry.definition;

  const translateX = useSharedValue(0);
  const startX = useSharedValue(0);
  const confirmed = useSharedValue(false);

  const revealStyle = useAnimatedStyle(() => ({
    backgroundColor: theme.backgroundSelected,
    opacity: interpolate(
      translateX.value,
      [0, 30, DELETE_THRESHOLD],
      [0, 1, 1],
      Extrapolation.CLAMP,
    ),
  }));

  const foregroundStyle = useAnimatedStyle(() => ({
    backgroundColor: confirmed.value
      ? theme.backgroundSelected
      : theme.background,
    transform: [{ translateX: translateX.value }],
  }));

  const pan = Gesture.Pan()
    .activeOffsetX([-10, 10])
    .failOffsetY([-10, 10])
    .onStart(() => {
      startX.value = translateX.value;
    })
    .onUpdate((e) => {
      translateX.value = Math.max(0, startX.value + e.translationX);
    })
    .onEnd((e) => {
      const shouldDelete =
        translateX.value > DELETE_THRESHOLD ||
        e.velocityX > SWIPE_VELOCITY_THRESHOLD;
      if (shouldDelete) {
        confirmed.value = true;
        // Fixed-duration, not spring, unlike the cancel/snap-back path below
        // - a spring aimed at a target this far away (screen width+) visibly
        // clears the viewport almost immediately, but keeps crawling toward
        // its exact target for a while after that before Reanimated calls it
        // "finished," which is what actually drives the row's removal below.
        // That gap left the "delete?" background sitting there alone,
        // looking like a stuck, darkened empty row, for longer than the
        // slide-off itself took to look complete. Same fixed timing
        // CategoryHeaderRow's own confirmed-delete already uses, for the
        // same reason.
        translateX.value = withTiming(
          SLIDE_OFF_DISTANCE,
          { duration: 280 },
          (finished) => {
            if (finished) runOnJS(remove)(entry.word);
          },
        );
      } else {
        translateX.value = withSpring(0, {
          ...SWIPE_SPRING,
          velocity: e.velocityX,
        });
      }
    });

  return (
    <View style={styles.rowWrapper}>
      <Animated.View style={[styles.deleteAction, revealStyle]}>
        <Text style={styles.deleteButtonText}>delete?</Text>
      </Animated.View>
      <GestureDetector gesture={pan}>
        <Animated.View style={foregroundStyle}>
          <Pressable
            style={({ pressed }) => [
              styles.row,
              { borderBottomColor: theme.separator },
              pressed && { backgroundColor: theme.backgroundElement },
            ]}
            onPress={() =>
              router.navigate({
                pathname: "/discover",
                params: { word: entry.word },
              })
            }
          >
            <Text style={[styles.word, { color: theme.text }]}>
              {entry.word}
            </Text>
            {snippet && (
              <Text
                style={[styles.snippet, { color: theme.textSecondary }]}
                numberOfLines={1}
              >
                {snippet}
              </Text>
            )}
          </Pressable>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

// How close (px) to the books list's top/bottom edge a drag's touch has to
// get before it starts auto-scrolling to reach it (DraggableFlatList's own
// autoscrollThreshold) - without this, a category pinned further down the
// list (eg. "n/a", always last) would be unreachable by dragging whenever
// it's off-screen.
const AUTO_SCROLL_EDGE = 80;

// Row heights for the category list's own getItemLayout below - must
// exactly match sectionHeaderRow+sectionHeader (headers) and
// bookRowPressable (books); see those styles' own comments for why they're
// pinned to these exact values. Without getItemLayout, VirtualizedList
// (which DraggableFlatList wraps) estimates unmeasured rows' heights and
// deliberately clamps how far it'll let you scroll past the last
// *measured* cell - which is what was making its true scrollable extent
// (and so the gap to the floating "+" button/tab bar) come out shorter
// than a plain ScrollView's for the exact same footer height. Supplying
// real heights up front removes that estimation entirely - as long as
// they're actually correct: an under-counted BOOK_ROW_HEIGHT here
// previously reproduced the exact same "falls short" symptom by a
// different route, since VirtualizedList trusts getItemLayout's numbers
// for the scrollable extent, not what's really on screen.
const HEADER_ROW_HEIGHT =
  Spacing.two + Spacing.two + 15 + StyleSheet.hairlineWidth;
// bookRowPressable's minHeight (56) is NOT the binding constraint here -
// ratingCircle (44, a row sibling of the title/author column, not nested
// inside it) is taller than that column's own content (40 with an author
// line), and alignItems:center on the row means the taller sibling wins:
// paddingTop(8) + paddingBottom(8) + ratingCircle(44) = 60.
const BOOK_ROW_HEIGHT = 60 + StyleSheet.hairlineWidth;

// How far (px) a leftward drag has to travel before it counts as "swipe to
// reveal the title," rather than an incidental touch/scroll wobble.
const TITLE_SWIPE_THRESHOLD = 24;
// Constant-speed reveal, not a fixed duration - a fixed duration made a
// heavily-clipped title (eg. "The Persecution and Assassination of
// Jean-Paul Marat...") slide brutally fast to cover its much larger
// overflow in the same window as a barely-clipped one (eg. "Harry Potter
// and the Deathly Hallows"), which crawled by comparison. Moving at a fixed
// px/sec instead means travel time scales with how far the title actually
// has to go, so every title reveals at the same readable pace. Shared with
// AutoMarqueeTitle's tap-triggered reveal below, for the same reason.
const TITLE_REVEAL_PIXELS_PER_SECOND = 55;
// Snapping back is deliberately quicker than the reveal, not the same
// duration in reverse - the slow reveal is for reading the title, the
// return trip is just resetting, so there's no reason for it to linger.
const TITLE_HIDE_DURATION = 350;
const TITLE_REVEAL_PAUSE = 900;
const TITLE_FONT_SIZE = 18;
// Fonts?.mono is a genuinely monospace font, so every character has the
// same advance width - used both to estimate a title's full rendered width
// (how far to reveal it) and to truncate the resting display at an exact
// character boundary (see truncateTitle) instead of clipping rendered
// pixels, which - tried first - could slice straight through the middle of
// a character depending on exactly where the clip boundary landed.
const MONO_CHAR_WIDTH = TITLE_FONT_SIZE * 0.62;
// Comfortably wider than any realistic title, so it never needs to wrap -
// only used for the revealed (full-text, sliding) state.
const TITLE_BOX_WIDTH = 2000;

function estimateTextWidth(text: string): number {
  return text.length * MONO_CHAR_WIDTH;
}

// Truncates at a whole character, reserving 2 characters' worth of width
// for the ".." suffix - never mid-character, unlike clipping rendered
// pixels at an arbitrary boundary.
function truncateTitle(title: string, width: number): string {
  if (width <= 0) return title; // not measured yet - avoid a flash of over-truncated text
  const visibleChars = Math.floor(width / MONO_CHAR_WIDTH);
  if (title.length <= visibleChars) return title;
  return title.slice(0, Math.max(0, visibleChars - 2)) + "..";
}

// AutoMarqueeTitle's own pause/hide timings - kept separate from BookRow's
// TITLE_REVEAL_PAUSE/TITLE_HIDE_DURATION above since it's tap-triggered and
// meant to be read passively like a now-playing marquee, so it lingers a
// touch longer. Reveal speed itself (TITLE_REVEAL_PIXELS_PER_SECOND) is
// shared, so every clipped title in the app slides at the same pace.
const AUTO_MARQUEE_REVEAL_PAUSE = 1000;
const AUTO_MARQUEE_HIDE_DURATION = 600;

// Same clip/reveal math as BookRow's swipe-triggered title reveal below
// (estimateTextWidth/truncateTitle), just triggered by tapping the title
// instead of a swipe gesture - slides left to show the full title, pauses,
// then slides back, like a Spotify now-playing title. Only used for a
// title that's actually clipped; a title that already fits never animates.
function AutoMarqueeTitle({ title, color }: { title: string; color: string }) {
  const [containerWidth, setContainerWidth] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const titleTranslateX = useSharedValue(0);
  const estimatedTextWidth = useMemo(() => estimateTextWidth(title), [title]);
  const truncatedTitle = useMemo(
    () => truncateTitle(title, containerWidth),
    [title, containerWidth],
  );

  const handlePress = () => {
    if (revealed) return; // already mid-animation - ignore taps until it resets
    const overflow = estimatedTextWidth - containerWidth;
    if (overflow <= 0) return; // already fully visible - nothing to reveal
    const revealDuration = (overflow / TITLE_REVEAL_PIXELS_PER_SECOND) * 1000;
    setRevealed(true);
    titleTranslateX.value = withSequence(
      withTiming(-overflow, {
        duration: revealDuration,
        easing: Easing.linear,
      }),
      withDelay(
        AUTO_MARQUEE_REVEAL_PAUSE,
        withTiming(
          0,
          { duration: AUTO_MARQUEE_HIDE_DURATION, easing: Easing.linear },
          (finished) => {
            if (finished) runOnJS(setRevealed)(false);
          },
        ),
      ),
    );
  };

  const titleAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: titleTranslateX.value }],
  }));

  return (
    <Pressable
      style={styles.ratingModalTitleClip}
      onLayout={(e) => setContainerWidth(e.nativeEvent.layout.width)}
      onPress={handlePress}
    >
      {revealed ? (
        <Animated.Text
          style={[
            styles.ratingModalTitle,
            styles.ratingModalTitleFull,
            { color },
            titleAnimatedStyle,
          ]}
          numberOfLines={1}
        >
          {title}
        </Animated.Text>
      ) : (
        <Text style={[styles.ratingModalTitle, { color }]} numberOfLines={1}>
          {truncatedTitle}
        </Text>
      )}
    </Pressable>
  );
}

// CollectionScreen's category-mode list, flattened to a single array of
// rows (headers and books interleaved in render order) - what
// react-native-draggable-flatlist's `data` is built from. Dragging is
// handled entirely by that library now (see CollectionScreen's own
// DraggableFlatList); this file only resolves what a finished drag means -
// see categoryForDropIndex below.
type FlatRow =
  | { key: string; type: "header"; categoryId: string | null; label: string }
  | { key: string; type: "book"; book: CollectionBook }
  | { key: string; type: "footer" };

// Trailing reserve for the floating "+" button/tab bar, appended as a real
// row (see CollectionScreen's dataWithFooter) rather than folded into the
// getItemLayout numbers for whatever the actual last row happens to be -
// that was tried first and didn't work: once a real row (eg. a BookRow)
// actually mounts, VirtualizedList's own onLayout-driven measurement of it
// overwrites getItemLayout's estimate for that cell with its true (smaller)
// rendered height, silently discarding the inflation. A dedicated row that
// really renders at the reserved height doesn't have that problem - its own
// measurement matches what getItemLayout already claims.
const CATEGORY_FOOTER_ROW: FlatRow = { key: "__footer__", type: "footer" };

// Stand-in for categoryId: null (the uncategorized/n/a bucket) in a header
// row's key - row keys are plain strings, which null can't be used as
// directly without a sentinel.
const UNCATEGORIZED_DRAG_KEY = "__uncategorized__";

// Given the reordered array a drop produced and the dropped book's new
// index in it, finds the category implied by whichever header most
// immediately precedes it. `topCategoryId` (the current #1-ranked
// category's own id) is the fallback for a book with nothing preceding it
// at all - which, now that that category's header is rendered as a fixed
// element above the draggable list rather than a row inside it (see
// CollectionScreen's own render), is the *only* way that can happen; there
// is no longer a real header at the very top of `rows` to find instead.
function categoryForDropIndex(
  rows: FlatRow[],
  index: number,
  topCategoryId: string | null,
): string | null {
  for (let i = Math.min(index, rows.length) - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.type === "header") return row.categoryId;
  }
  return topCategoryId;
}

// Same rightward-swipe-to-delete gesture as BookRow's (no leftward title
// reveal here - a header only ever has the one gesture). categoryId is
// null for the n/a bucket, which isn't a real row and can never be
// removed - that case skips the gesture entirely rather than wiring one up
// that can never fire.
function CategoryHeaderRow({
  categoryId,
  label,
}: {
  categoryId: string | null;
  label: string;
}) {
  const theme = useTheme();
  const { removeCategory } = useCollection();
  const rowTranslateX = useSharedValue(0);
  const startX = useSharedValue(0);
  const confirmed = useSharedValue(false);

  const pan = Gesture.Pan()
    .activeOffsetX([-10, 10])
    .failOffsetY([-10, 10])
    .onStart(() => {
      startX.value = rowTranslateX.value;
    })
    .onUpdate((e) => {
      rowTranslateX.value = Math.max(0, startX.value + e.translationX);
    })
    .onEnd(() => {
      if (rowTranslateX.value > DELETE_THRESHOLD) {
        confirmed.value = true;
        rowTranslateX.value = withTiming(
          SLIDE_OFF_DISTANCE,
          { duration: 280 },
          (finished) => {
            if (finished && categoryId) runOnJS(removeCategory)(categoryId);
          },
        );
      } else {
        rowTranslateX.value = withTiming(0, { duration: 180 });
      }
    });

  const revealStyle = useAnimatedStyle(() => ({
    backgroundColor: theme.backgroundSelected,
    opacity: interpolate(
      rowTranslateX.value,
      [0, 30, DELETE_THRESHOLD],
      [0, 1, 1],
      Extrapolation.CLAMP,
    ),
  }));

  const foregroundStyle = useAnimatedStyle(() => ({
    backgroundColor: confirmed.value
      ? theme.backgroundSelected
      : theme.backgroundElement,
    transform: [{ translateX: rowTranslateX.value }],
  }));

  if (categoryId === null) {
    return (
      <View
        style={[
          styles.sectionHeaderRow,
          {
            borderBottomColor: theme.separator,
            backgroundColor: theme.backgroundElement,
          },
        ]}
      >
        <Text style={[styles.sectionHeader, { color: theme.textSecondary }]}>
          {label}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.rowWrapper}>
      <Animated.View style={[styles.deleteAction, revealStyle]}>
        <Text style={styles.deleteButtonText}>delete?</Text>
      </Animated.View>
      <GestureDetector gesture={pan}>
        <Animated.View
          style={[
            styles.sectionHeaderRow,
            { borderBottomColor: theme.separator },
            foregroundStyle,
          ]}
        >
          <Text style={[styles.sectionHeader, { color: theme.textSecondary }]}>
            {label}
          </Text>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

// Title stays a fixed size and is clipped (not shrunk) when it's too long to
// fit - swiping left plays the full title past the clip, holds briefly,
// then slides it back, instead of ellipsizing it. Swiping right instead
// (like WordRow's delete swipe) reveals a delete affordance for the whole
// book - two different gestures on the same row, told apart by direction in
// one combined Pan (rightward live-follows the finger; leftward is a
// threshold-triggered, fire-and-forget animation, not finger-tracked).
// onLongPressDrag (only passed in category sort mode - see CollectionScreen's
// DraggableFlatList) is react-native-draggable-flatlist's own `drag`
// callback, wired straight into the existing Pressable's onLongPress rather
// than a separate gesture - the library owns the actual drag/reflow
// mechanics entirely, this row just has to tell it when to start.
function BookRow({
  book,
  borderColor,
  onPressRating,
  onLongPressDrag,
  isActive,
}: {
  book: CollectionBook;
  borderColor: string;
  onPressRating: (book: CollectionBook) => void;
  onLongPressDrag?: () => void;
  isActive?: boolean;
}) {
  const theme = useTheme();
  const { removeBook, bookReviews } = useCollection();
  // The circle shows the average of every review for this book, not just
  // the latest one - null (rendered as "?") only when there are none yet.
  const averageRating = useMemo(
    () => averageBookRating(book.id, bookReviews),
    [bookReviews, book.id],
  );
  const [containerWidth, setContainerWidth] = useState(0);
  // Which display mode bookTitleClip shows - the character-truncated
  // string (rest) or the full, sliding title (mid-reveal). Plain state, not
  // a shared value, since switching which Text renders is a real content
  // change, not something a worklet-driven style alone can do.
  const [revealed, setRevealed] = useState(false);
  const titleTranslateX = useSharedValue(0);
  const rowTranslateX = useSharedValue(0);
  const startX = useSharedValue(0);
  const confirmed = useSharedValue(false);
  const estimatedTextWidth = useMemo(
    () => estimateTextWidth(book.title),
    [book.title],
  );
  const truncatedTitle = useMemo(
    () => truncateTitle(book.title, containerWidth),
    [book.title, containerWidth],
  );

  const revealTitle = () => {
    if (revealed) return; // already mid-animation - ignore a swipe until it resets
    const overflow = estimatedTextWidth - containerWidth;
    if (overflow <= 0) return; // already fully visible - nothing to reveal
    const revealDuration = (overflow / TITLE_REVEAL_PIXELS_PER_SECOND) * 1000;
    setRevealed(true);
    titleTranslateX.value = withSequence(
      withTiming(-overflow, {
        duration: revealDuration,
        easing: Easing.linear,
      }),
      withDelay(
        TITLE_REVEAL_PAUSE,
        withTiming(
          0,
          { duration: TITLE_HIDE_DURATION, easing: Easing.linear },
          (finished) => {
            if (finished) runOnJS(setRevealed)(false);
          },
        ),
      ),
    );
  };

  const pan = Gesture.Pan()
    .activeOffsetX([-10, 10])
    .failOffsetY([-10, 10])
    .onStart(() => {
      startX.value = rowTranslateX.value;
    })
    .onUpdate((e) => {
      // Only the rightward direction follows the finger - leftward is
      // handled entirely in onEnd below as a triggered animation, not a
      // drag-tracked one.
      rowTranslateX.value = Math.max(0, startX.value + e.translationX);
    })
    .onEnd((e) => {
      const shouldDelete =
        rowTranslateX.value > DELETE_THRESHOLD ||
        e.velocityX > SWIPE_VELOCITY_THRESHOLD;
      if (shouldDelete) {
        confirmed.value = true;
        // Fixed-duration, not spring - see WordRow's identical comment above
        // for why (the confirmed-delete case, unlike cancel/snap-back below,
        // gates an actual removal on "finished," so it needs a prompt,
        // predictable completion rather than a spring's long settle tail).
        rowTranslateX.value = withTiming(
          SLIDE_OFF_DISTANCE,
          { duration: 280 },
          (finished) => {
            if (finished) runOnJS(removeBook)(book.id);
          },
        );
      } else {
        rowTranslateX.value = withSpring(0, {
          ...SWIPE_SPRING,
          velocity: e.velocityX,
        });
        if (e.translationX < -TITLE_SWIPE_THRESHOLD) runOnJS(revealTitle)();
      }
    });

  const revealStyle = useAnimatedStyle(() => ({
    backgroundColor: theme.backgroundSelected,
    opacity: interpolate(
      rowTranslateX.value,
      [0, 30, DELETE_THRESHOLD],
      [0, 1, 1],
      Extrapolation.CLAMP,
    ),
  }));

  const foregroundStyle = useAnimatedStyle(() => ({
    backgroundColor: confirmed.value
      ? theme.backgroundSelected
      : theme.background,
    transform: [{ translateX: rowTranslateX.value }],
  }));

  const titleStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: titleTranslateX.value }],
  }));

  return (
    <View style={styles.rowWrapper}>
      <Animated.View style={[styles.deleteAction, revealStyle]}>
        <Text style={styles.deleteButtonText}>delete?</Text>
      </Animated.View>
      {/* Gesture wraps the whole row (not just the title/author area) since
          the entire row is now a single tap target for opening the rating
          prompt - the pan's activeOffsetX threshold already keeps a plain
          tap from being swallowed as a drag, same as WordRow above. */}
      <GestureDetector gesture={pan}>
        <Animated.View
          style={[
            styles.bookRow,
            { borderBottomColor: borderColor },
            foregroundStyle,
          ]}
        >
          <Pressable
            style={({ pressed }) => [
              styles.bookRowPressable,
              pressed && { backgroundColor: theme.backgroundElement },
            ]}
            onPress={() => onPressRating(book)}
            onLongPress={onLongPressDrag}
            disabled={isActive}
          >
            <View style={styles.bookRowContent}>
              <View
                style={styles.bookTitleClip}
                onLayout={(e) => {
                  setContainerWidth(e.nativeEvent.layout.width);
                }}
              >
                {revealed ? (
                  <Animated.Text
                    style={[
                      styles.bookTitle,
                      { color: theme.text },
                      titleStyle,
                    ]}
                  >
                    {book.title}
                  </Animated.Text>
                ) : (
                  <Text
                    style={[styles.bookTitleTruncated, { color: theme.text }]}
                    numberOfLines={1}
                  >
                    {truncatedTitle}
                  </Text>
                )}
              </View>
              {book.author && (
                <Text
                  style={[styles.bookAuthor, { color: theme.textSecondary }]}
                  numberOfLines={1}
                >
                  {book.author}
                </Text>
              )}
            </View>
            <View
              style={[
                styles.ratingCircle,
                { backgroundColor: theme.backgroundElement },
              ]}
            >
              <Text style={[styles.ratingCircleText, { color: theme.text }]}>
                {averageRating !== null ? averageRating.toFixed(1) : "?"}
              </Text>
            </View>
          </Pressable>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

// How wide a strip along the left edge starts the swipe-to-dismiss gesture -
// narrow enough that it doesn't swallow taps on "log out"/"delete account".
const SWIPE_EDGE_WIDTH = 24;

// Full-screen overlay (not a real route) - swiped away from a thin strip at
// the left edge, same drag-then-release-or-snap-back mechanics as WordRow's
// swipe-to-delete above, just triggered from a fixed edge zone instead of
// anywhere on the row.
function SettingsScreen({
  onDismiss,
  onModifyColorTheme,
  onLogout,
  onDeleteAccount,
}: {
  onDismiss: () => void;
  onModifyColorTheme: () => void;
  onLogout: () => void;
  onDeleteAccount: () => void;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  // Starts off-screen right (mirroring exactly where dismiss ends up) and
  // slides in on mount - see the entrance effect below - rather than
  // starting at 0 and just popping into frame already in place.
  const translateX = useSharedValue(SLIDE_OFF_DISTANCE);

  const containerStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  // Entrance animation - same spring physics as the exit/snap-back (see
  // SWIPE_SPRING's own comment), just run once on mount instead of from a
  // gesture, so opening settings and dismissing it feel like mirror images
  // of the same motion rather than "slides out, but just appears going in."
  useEffect(() => {
    translateX.value = withSpring(0, SWIPE_SPRING);
  }, []);

  // Deferred by a tick rather than calling onDismiss directly - unmounting
  // this view (which is what onDismiss triggers, via settingsVisible) is the
  // same view the edge-swipe gesture is still attached to. Doing that
  // synchronously from within the gesture's own completion callback can
  // crash native gesture-handler on iOS, since React removes the view before
  // the native recognizer has finished tearing itself down. setTimeout(0)
  // pushes the unmount to a fresh JS tick, after that teardown settles.
  const deferredDismiss = () => setTimeout(onDismiss, 0);

  // Always runs on the JS thread, never called directly from a worklet - the
  // back button already calls this as a plain JS function. The gesture path
  // below goes through runOnJS specifically so it hits this exact same
  // JS-thread codepath instead of Reanimated compiling a separate
  // worklet/UI-thread version of the same function for the gesture call
  // site - that dual compilation (one function, two different execution
  // contexts) is what was crashing native gesture-handler on swipe while the
  // button (JS-thread only) worked fine.
  //
  // velocityX defaults to 0 for the back button's own tap-triggered call,
  // which has no real gesture velocity to seed the spring with - it still
  // animates, just without an initial-speed kick.
  const dismiss = (velocityX = 0) => {
    translateX.value = withSpring(
      SLIDE_OFF_DISTANCE,
      { ...SWIPE_SPRING, velocity: velocityX },
      (finished) => {
        if (finished) runOnJS(deferredDismiss)();
      },
    );
  };

  const edgeSwipe = Gesture.Pan()
    .activeOffsetX(10)
    .failOffsetY([-10, 10])
    .onUpdate((e) => {
      translateX.value = Math.max(0, e.translationX);
    })
    .onEnd((e) => {
      const shouldComplete =
        translateX.value > COMPLETE_THRESHOLD ||
        e.velocityX > SWIPE_VELOCITY_THRESHOLD;
      if (shouldComplete) {
        runOnJS(dismiss)(e.velocityX);
      } else {
        translateX.value = withSpring(0, {
          ...SWIPE_SPRING,
          velocity: e.velocityX,
        });
      }
    });

  return (
    <Animated.View
      style={[
        styles.settingsScreen,
        {
          backgroundColor: theme.background,
          paddingTop: insets.top + Spacing.four,
        },
        containerStyle,
      ]}
    >
      <GestureDetector gesture={edgeSwipe}>
        <View style={styles.settingsEdge} />
      </GestureDetector>

      <Pressable
        style={({ pressed }) => [
          styles.backButton,
          pressed && { backgroundColor: theme.backgroundElement },
        ]}
        onPress={() => dismiss()}
      >
        <Ionicons name="arrow-back" size={22} color={theme.text} />
      </Pressable>

      <View style={styles.settingsOptions}>
        <View
          style={[styles.settingsDivider, { backgroundColor: theme.separator }]}
        />
        <Pressable
          style={({ pressed }) => [
            styles.settingsOption,
            pressed && { backgroundColor: theme.backgroundElement },
          ]}
          onPress={onModifyColorTheme}
        >
          <Text style={[styles.settingsOptionText, { color: theme.text }]}>
            modify color theme
          </Text>
        </Pressable>
        <View
          style={[styles.settingsDivider, { backgroundColor: theme.separator }]}
        />
        <Pressable
          style={({ pressed }) => [
            styles.settingsOption,
            pressed && { backgroundColor: theme.backgroundElement },
          ]}
          onPress={onLogout}
        >
          <Text style={[styles.settingsOptionText, { color: theme.text }]}>
            log out
          </Text>
        </Pressable>
        <View
          style={[styles.settingsDivider, { backgroundColor: theme.separator }]}
        />
        <Pressable
          style={({ pressed }) => [
            styles.settingsOption,
            pressed && { backgroundColor: theme.backgroundElement },
          ]}
          onPress={onDeleteAccount}
        >
          <Text style={[styles.settingsOptionText, { color: theme.text }]}>
            delete account
          </Text>
        </Pressable>
        <View
          style={[styles.settingsDivider, { backgroundColor: theme.separator }]}
        />
      </View>
    </Animated.View>
  );
}

// Same backdrop-card modal shape as BookPrompt - picking a color updates
// (and persists) the theme live, and tapping the backdrop is the only way
// to close it since there's nothing to separately "confirm".
function ColorThemeModal({ onDismiss }: { onDismiss: () => void }) {
  const theme = useTheme();
  const { hue, saturation, setColor, moodImmutable, setMoodImmutable } =
    useThemeContext();

  return (
    <View style={styles.colorModalBackdrop}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onDismiss} />
      <View
        style={[styles.colorModalCard, { backgroundColor: theme.background }]}
      >
        <ColorWheel hue={hue} saturation={saturation} onChange={setColor} />
        {/* Manually picking a color via the wheel above always still works
            regardless of this - it only blocks the automatic mood-driven
            shifts (see context/theme.tsx's shiftMoodFromText). */}
        <Pressable
          style={styles.moodImmutableRow}
          onPress={() => setMoodImmutable(!moodImmutable)}
        >
          <Ionicons
            name={moodImmutable ? "checkbox" : "square-outline"}
            size={20}
            color={theme.text}
          />
          <Text style={[styles.moodImmutableLabel, { color: theme.text }]}>
            set immutable?
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const RATING_MAX = 10;
const SLIDER_THUMB_SIZE = 24;
const SLIDER_TRACK_HEIGHT = 6;
const REVIEW_MAX_LENGTH = 1000;

// Drag-anywhere-on-the-track slider, same gesture-driven approach as
// ColorWheel (tap or drag, .onBegin covers the tap case) rather than a
// picker library - nothing else in this app pulls one in either. Only
// commits (calls onChangeEnd) once per gesture, on release, not on every
// frame of the drag - the thumb/fill still track the finger live via shared
// values with no state round-trip needed for that part.
function RatingSlider({
  value,
  onChangeEnd,
}: {
  value: number;
  onChangeEnd: (value: number) => void;
}) {
  const theme = useTheme();
  const trackWidth = useSharedValue(0);
  const dragValue = useSharedValue(value);
  const [displayValue, setDisplayValue] = useState(value);

  useEffect(() => {
    dragValue.value = value;
    setDisplayValue(value);
  }, [value, dragValue]);

  const updateFromX = (x: number) => {
    if (trackWidth.value <= 0) return;
    const ratio = Math.max(0, Math.min(1, x / trackWidth.value));
    const next = Math.round(ratio * RATING_MAX * 10) / 10;
    dragValue.value = next;
    setDisplayValue(next);
  };

  const commit = () => {
    onChangeEnd(dragValue.value);
  };

  const pan = Gesture.Pan()
    .onBegin((e) => runOnJS(updateFromX)(e.x))
    .onUpdate((e) => runOnJS(updateFromX)(e.x))
    .onEnd(() => runOnJS(commit)());

  // Inset by the thumb's own size so it travels fully within the track's
  // rendered bounds - at ratio 0 its left edge lands exactly at the
  // track's left edge (not centered on it, which would poke half the
  // thumb out past the edge), and at ratio 1 its right edge lands exactly
  // at the track's right edge.
  const fillStyle = useAnimatedStyle(() => {
    const usableWidth = Math.max(0, trackWidth.value - SLIDER_THUMB_SIZE);
    const ratio = dragValue.value / RATING_MAX;
    return { width: ratio * usableWidth + SLIDER_THUMB_SIZE / 2 };
  });
  const thumbStyle = useAnimatedStyle(() => {
    const usableWidth = Math.max(0, trackWidth.value - SLIDER_THUMB_SIZE);
    const ratio = dragValue.value / RATING_MAX;
    return { transform: [{ translateX: ratio * usableWidth }] };
  });

  return (
    <View style={styles.sliderRow}>
      <GestureDetector gesture={pan}>
        <View
          style={styles.sliderTrackWrapper}
          onLayout={(e) => {
            trackWidth.value = e.nativeEvent.layout.width;
          }}
        >
          <View
            style={[
              styles.sliderTrack,
              { backgroundColor: theme.backgroundElement },
            ]}
          />
          <Animated.View
            style={[
              styles.sliderFill,
              { backgroundColor: theme.backgroundSelected },
              fillStyle,
            ]}
          />
          <Animated.View
            style={[
              styles.sliderThumb,
              { backgroundColor: theme.text },
              thumbStyle,
            ]}
          />
        </View>
      </GestureDetector>
      <Text style={[styles.sliderValue, { color: theme.text }]}>
        {displayValue.toFixed(1)}
      </Text>
    </View>
  );
}


function RatingPrompt({
  book,
  onDismiss,
}: {
  book: CollectionBook;
  onDismiss: () => void;
}) {
  const theme = useTheme();
  const { bookReviews, addBookReview } = useCollection();
  // Newest first (see context/collection.tsx's refresh()) - shown read-only
  // above the editable form below. A book can have any number of these now,
  // unlike the old single mutable rating/review, so past ones are always
  // visible rather than the prompt locking up after the first save.
  const pastReviews = useMemo(
    () => bookReviews.filter((r) => r.bookId === book.id),
    [bookReviews, book.id],
  );
  // Local/uncommitted until save - the circle on the book row reads the
  // latest of bookReviews from context, which nothing here touches until
  // handleSave runs, so it can't reflect this edit early. Tapping the
  // backdrop (onDismiss, below) never calls addBookReview at all, so it
  // discards whatever was entered here.
  const [rating, setRating] = useState(0);
  const [review, setReview] = useState("");
  // Books with existing reviews open straight into the read-only summary
  // (no scrollbar, no inputs, no save button) with a "+" button in place of
  // save - tapping it swaps in the original editable form
  // (slider, text box, scrollable summary, save button). A book with no
  // reviews yet has nothing to summarize, so it skips straight to editing.
  const [reviewingAgain, setReviewingAgain] = useState(
    pastReviews.length === 0,
  );
  // Applied directly as paddingBottom on colorModalBackdrop below (not a
  // separate wrapper) - that view already does the centering, so shrinking
  // its own content box by the keyboard's height is enough for
  // justifyContent:center to re-center the card in what's left above it.
  //
  // iOS only - Android (with the default softwareKeyboardLayoutMode, which
  // this app doesn't override) already resizes the whole window when the
  // keyboard opens, so absoluteFillObject views there already reflect the
  // shrunk screen automatically. Adding this padding on top of that too
  // would double-count the keyboard's height.
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    if (Platform.OS !== "ios") return;
    const showSub = Keyboard.addListener("keyboardWillShow", (e) => {
      setKeyboardHeight(e.endCoordinates.height);
    });
    const hideSub = Keyboard.addListener("keyboardWillHide", () => {
      setKeyboardHeight(0);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  // Row markup for the resting view-only mode's past-review list (see below
  // - reviewingAgain mode shows just the slider/text box, no past reviews).
  const pastReviewRows = pastReviews.map((r, i) => (
    <View
      key={r.id}
      style={[
        styles.pastReviewEntry,
        i > 0 && {
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: theme.separator,
          paddingTop: Spacing.three,
        },
      ]}
    >
      <View style={styles.reviewSummaryMeta}>
        <View
          style={[
            styles.reviewSummaryScorePill,
            { backgroundColor: theme.backgroundElement },
          ]}
        >
          <Text style={[styles.reviewSummaryScore, { color: theme.text }]}>
            {r.rating.toFixed(1)}
          </Text>
        </View>
        <Text
          style={[styles.reviewSummaryDate, { color: theme.textSecondary }]}
        >
          on {formatReviewDate(r.addedAt)}
        </Text>
      </View>
      <ExpandableReviewText text={r.review} />
    </View>
  ));

  const handleSave = () => {
    addBookReview(book.id, rating, review);
    onDismiss();
  };

  return (
    <View
      style={[
        styles.colorModalBackdrop,
        { paddingBottom: keyboardHeight * 0.6 },
      ]}
    >
      <Pressable style={StyleSheet.absoluteFill} onPress={onDismiss} />
      {/* Not Pressable at this level, unlike the editable section below -
          keyboard-dismiss-on-tap is scoped to just that section instead,
          since it's the only part with a TextInput to dismiss for. */}
      <View
        style={[styles.ratingModalCard, { backgroundColor: theme.background }]}
      >
        <View style={styles.ratingModalHeader}>
          <AutoMarqueeTitle title={book.title} color={theme.text} />
          <Pressable
            style={[
              styles.ratingSaveButton,
              { backgroundColor: theme.backgroundElement },
            ]}
            onPress={reviewingAgain ? handleSave : () => setReviewingAgain(true)}
          >
            {reviewingAgain ? (
              <Text
                style={[styles.ratingSaveButtonText, { color: theme.text }]}
              >
                save
              </Text>
            ) : (
              <Ionicons name="add" size={18} color={theme.text} />
            )}
          </Pressable>
        </View>
        {/* Only in the resting view-only state - reviewingAgain shows just
            the slider/text box below, not the past reviews. Capped at
            reviewSummaryScroll's maxHeight and scrollable past that, same
            as addBookResults below, so a handful of long reviews doesn't
            grow the card past the screen. */}
        {pastReviews.length > 0 && !reviewingAgain && (
          <ScrollView
            style={styles.reviewSummaryScroll}
            contentContainerStyle={styles.reviewSummaryContentFlush}
          >
            {pastReviewRows}
          </ScrollView>
        )}
        {reviewingAgain && (
          <Pressable
            style={styles.ratingEditableSection}
            onPress={Keyboard.dismiss}
          >
            <RatingSlider value={rating} onChangeEnd={setRating} />
            {/* The scroll indicator hugs the TextInput's own straight edge,
                which looked wrong against reviewInputWrapper's rounded
                corners - the wrapper's small paddingVertical is what keeps
                the indicator inset from that curve instead of running right
                into it. */}
            <View
              style={[
                styles.reviewInputWrapper,
                { backgroundColor: theme.backgroundElement },
              ]}
            >
              <TextInput
                style={[styles.reviewInput, { color: theme.text }]}
                placeholder="review"
                placeholderTextColor={theme.textSecondary}
                value={review}
                onChangeText={setReview}
                maxLength={REVIEW_MAX_LENGTH}
                multiline
                scrollEnabled
              />
            </View>
          </Pressable>
        )}
      </View>
    </View>
  );
}

// Separate from components/book-prompt.tsx's BookPrompt (used when adding a
// word) rather than reusing it - that component's own backdrop has no
// zIndex, so mounting it here (declared earlier in this file's JSX than the
// books list further down) let the books list render/receive touches on top
// of it instead of the modal blocking them, and it also carries a "from a
// book?" title that doesn't fit this standalone "+" entry point. This reuses
// the same search behavior (searchBooks, from book-prompt.tsx) but its own
// JSX/styling, built on the same colorModalBackdrop/ratingModalCard patterns
// already proven correct elsewhere in this file.
type AddBookMode = "book" | "category" | "words";

// Same swipe-to-reveal behavior as book-prompt.tsx's BookResultRow, mirrored
// here rather than shared since this list uses its own addBookResult*
// styles (see AddBookPrompt's own comment above for why this whole search
// UI is a separate implementation).
const ADD_BOOK_RESULT_TITLE_SWIPE_THRESHOLD = 24;
const ADD_BOOK_RESULT_TITLE_REVEAL_PIXELS_PER_SECOND = 55;
const ADD_BOOK_RESULT_TITLE_HIDE_DURATION = 350;
const ADD_BOOK_RESULT_TITLE_REVEAL_PAUSE = 900;
const ADD_BOOK_RESULT_TITLE_BOX_WIDTH = 2000;
const ADD_BOOK_RESULT_MONO_CHAR_WIDTH = 16 * 0.62; // styles.addBookResultTitle's fontSize

function estimateAddBookResultTitleWidth(text: string): number {
  return text.length * ADD_BOOK_RESULT_MONO_CHAR_WIDTH;
}

function AddBookResultRow({
  book,
  onPress,
  isLast,
}: {
  book: BookResult;
  onPress: () => void;
  isLast: boolean;
}) {
  const theme = useTheme();
  const [containerWidth, setContainerWidth] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const titleTranslateX = useSharedValue(0);
  const estimatedTextWidth = useMemo(
    () => estimateAddBookResultTitleWidth(book.title),
    [book.title],
  );

  const revealTitle = () => {
    if (revealed) return; // already mid-animation - ignore a swipe until it resets
    const overflow = estimatedTextWidth - containerWidth;
    if (overflow <= 0) return; // already fully visible - nothing to reveal
    const revealDuration =
      (overflow / ADD_BOOK_RESULT_TITLE_REVEAL_PIXELS_PER_SECOND) * 1000;
    setRevealed(true);
    titleTranslateX.value = withSequence(
      withTiming(-overflow, {
        duration: revealDuration,
        easing: Easing.linear,
      }),
      withDelay(
        ADD_BOOK_RESULT_TITLE_REVEAL_PAUSE,
        withTiming(
          0,
          {
            duration: ADD_BOOK_RESULT_TITLE_HIDE_DURATION,
            easing: Easing.linear,
          },
          (finished) => {
            if (finished) runOnJS(setRevealed)(false);
          },
        ),
      ),
    );
  };

  const pan = Gesture.Pan()
    .activeOffsetX([-10, 10])
    .failOffsetY([-10, 10])
    .onEnd((e) => {
      if (e.translationX < -ADD_BOOK_RESULT_TITLE_SWIPE_THRESHOLD) {
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
            styles.addBookResultRow,
            { borderTopColor: theme.separator },
            isLast && {
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderBottomColor: theme.separator,
            },
            pressed && { backgroundColor: theme.backgroundElement },
          ]}
          onPress={onPress}
        >
          <View
            style={styles.addBookResultTitleClip}
            onLayout={(e) => setContainerWidth(e.nativeEvent.layout.width)}
          >
            {revealed ? (
              <Animated.Text
                style={[
                  styles.addBookResultTitle,
                  styles.addBookResultTitleRevealed,
                  { color: theme.text },
                  titleStyle,
                ]}
              >
                {book.title}
              </Animated.Text>
            ) : (
              <Text
                style={[styles.addBookResultTitle, { color: theme.text }]}
                numberOfLines={1}
              >
                {book.title}
              </Text>
            )}
          </View>
          <Text
            style={[
              styles.addBookResultAuthor,
              { color: theme.textSecondary },
              !book.author && styles.addBookResultAuthorHidden,
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

function AddBookPrompt({
  onDismiss,
  onSelectBook,
}: {
  onDismiss: () => void;
  onSelectBook: (book: BookResult) => void;
}) {
  const theme = useTheme();
  const { add, addCategory } = useCollection();
  const [mode, setModeState] = useState<AddBookMode>("book");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<BookResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const [numFound, setNumFound] = useState(0);
  // While the words-mode submit is checking each word against the
  // dictionary API - disables the submit button so a slow batch (several
  // words, each its own request) can't be tapped twice.
  const [wordsSubmitting, setWordsSubmitting] = useState(false);
  // Set only for a genuine connectivity failure (see book-prompt.tsx's
  // searchBooksOnce - the same "network error" throw) - shown where results
  // would otherwise populate, since there's nothing useful to search with no
  // connection.
  const [searchError, setSearchError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);
  // Same manual-tracking approach as RatingPrompt above, not
  // KeyboardAvoidingView - see the comment on RatingPrompt's own
  // keyboardHeight state for why.
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  // Same shake used for a wrong password on auth-screen.tsx - shown when
  // submitting a category name that already exists, no error text.
  const shakeX = useSharedValue(0);
  const shakeStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: shakeX.value }],
  }));
  const shake = () => {
    shakeX.value = withSequence(
      withTiming(-10, { duration: 45 }),
      withTiming(10, { duration: 45 }),
      withTiming(-8, { duration: 45 }),
      withTiming(8, { duration: 45 }),
      withTiming(0, { duration: 45 }),
    );
  };

  // Switching modes clears whatever the other mode had going - a stale
  // Google Books result list showing while typing a category name (or vice
  // versa) would be confusing, and neither mode's state means anything to
  // the other.
  const setMode = (next: AddBookMode) => {
    setModeState(next);
    setQuery("");
    setResults([]);
    setNumFound(0);
    setOffset(0);
    setSearchError(null);
  };

  useEffect(() => {
    if (Platform.OS !== "ios") return;
    const showSub = Keyboard.addListener("keyboardWillShow", (e) => {
      setKeyboardHeight(e.endCoordinates.height);
    });
    const hideSub = Keyboard.addListener("keyboardWillHide", () => {
      setKeyboardHeight(0);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

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
        }
      } catch (error) {
        console.error("[add-book-prompt] search failed", error);
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

  // No fallback/suggestion list, unlike BookPrompt's recent-books default -
  // this flow is specifically for adding a book that isn't in the
  // collection yet, so surfacing already-added books here is exactly the
  // opposite of useful. Empty until a real search actually returns matches.
  const displayBooks = results;
  const hasQuery = query.trim().length >= MIN_QUERY_LENGTH;

  useEffect(() => {
    if (mode !== "book") return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setNumFound(0);
      setOffset(0);
      setLoading(false);
      setSearchError(null);
      return;
    }
    debounceRef.current = setTimeout(() => runSearch(trimmed, 0), DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [mode, query, runSearch]);

  const handleReload = () => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH || loading) return;
    const nextOffset =
      offset + RESULT_LIMIT >= numFound ? 0 : offset + RESULT_LIMIT;
    runSearch(trimmed, nextOffset);
  };

  // Explicit empty-check since, unlike the submit button below (which has
  // its own `disabled`), onSubmitEditing (the keyboard return key) isn't
  // gated by anything. A duplicate name just shakes and leaves the typed
  // text in place to edit/retry - no error message, same UX as a wrong
  // password on auth-screen.tsx.
  const handleSubmitCategory = async () => {
    const name = query.trim();
    if (!name) return;
    const created = await addCategory(name);
    if (created) onDismiss();
    else shake();
  };

  // Splits on whitespace (including newlines, so pasting/typing one word per
  // line works too), commas, and semicolons - whichever mix the user typed.
  // Deduplicated so "cat cat dog" doesn't fire the same lookup twice.
  // dictionaryapi.dev only ever takes one word per request (no batch
  // endpoint), so this fires one fetchDefinition per word and waits for all
  // of them - Promise.allSettled rather than Promise.all since a bad word in
  // the middle of the list shouldn't stop the good ones from still getting
  // added. Only shakes (like a wrong password) if literally none of them
  // resolved; otherwise whatever did resolve gets added, silently skipping
  // the rest - same "no error text" spirit as handleSubmitCategory above.
  const handleSubmitWords = async () => {
    const words = Array.from(
      new Set(
        query
          .split(/[\s,;]+/)
          .map((w) => w.trim())
          .filter((w) => w.length > 0),
      ),
    );
    if (words.length === 0 || wordsSubmitting) return;
    setWordsSubmitting(true);
    try {
      const results = await Promise.allSettled(words.map(fetchDefinition));
      const valid = results.filter(
        (r): r is PromiseFulfilledResult<Entry> => r.status === "fulfilled",
      );
      if (valid.length === 0) {
        shake();
        return;
      }
      for (const r of valid) add(r.value, null);
      onDismiss();
    } finally {
      setWordsSubmitting(false);
    }
  };

  return (
    <View
      style={[
        styles.colorModalBackdrop,
        { paddingBottom: keyboardHeight * 0.6 },
      ]}
    >
      <Pressable style={StyleSheet.absoluteFill} onPress={onDismiss} />
      {/* Plain View, not Pressable, unlike RatingPrompt's editable card - a
          Pressable ancestor would claim the touch responder for its own
          press-state tracking and starve the results ScrollView below of
          the drag gesture it needs to scroll (same issue fixed earlier for
          RatingPrompt's read-only review box). Nothing here needed
          tap-anywhere-to-dismiss-keyboard badly enough to be worth that
          tradeoff - submitting the search, picking a result, or tapping the
          backdrop all already resolve the prompt one way or another. */}
      <Animated.View
        style={[
          styles.ratingModalCard,
          { backgroundColor: theme.background },
          shakeStyle,
        ]}
      >
        <View
          style={[
            styles.viewModeToggle,
            styles.addBookModeToggle,
            { backgroundColor: theme.backgroundElement },
          ]}
        >
          <Pressable
            style={[
              styles.viewModeSegment,
              mode === "book" && { backgroundColor: theme.backgroundSelected },
            ]}
            onPress={() => setMode("book")}
          >
            <Text style={[styles.viewModeSegmentText, { color: theme.text }]}>
              book
            </Text>
          </Pressable>
          <Pressable
            style={[
              styles.viewModeSegment,
              mode === "category" && {
                backgroundColor: theme.backgroundSelected,
              },
            ]}
            onPress={() => setMode("category")}
          >
            <Text style={[styles.viewModeSegmentText, { color: theme.text }]}>
              category
            </Text>
          </Pressable>
          <Pressable
            style={[
              styles.viewModeSegment,
              mode === "words" && {
                backgroundColor: theme.backgroundSelected,
              },
            ]}
            onPress={() => setMode("words")}
          >
            <Text style={[styles.viewModeSegmentText, { color: theme.text }]}>
              words
            </Text>
          </Pressable>
        </View>

        <View style={styles.addBookSearchRow}>
          <TextInput
            style={[
              mode === "words"
                ? styles.addBookWordsInput
                : styles.addBookSearchInput,
              { backgroundColor: theme.backgroundElement, color: theme.text },
            ]}
            placeholderTextColor={theme.textSecondary}
            placeholder={
              mode === "book"
                ? "search for a book"
                : mode === "category"
                  ? "category"
                  : "add a word, or a bunch!"
            }
            value={query}
            onChangeText={setQuery}
            maxLength={
              mode === "category"
                ? 42
                : mode === "words"
                  ? REVIEW_MAX_LENGTH
                  : undefined
            }
            multiline={mode === "words"}
            textAlignVertical={mode === "words" ? "top" : undefined}
            autoCapitalize="none"
            autoCorrect={mode === "words"}
            returnKeyType={
              mode === "book" ? "search" : mode === "category" ? "done" : "default"
            }
            onSubmitEditing={
              mode === "book"
                ? Keyboard.dismiss
                : mode === "category"
                  ? handleSubmitCategory
                  : undefined // words mode: return key just inserts a newline
            }
          />
          {mode === "book" ? (
            <PressableScale
              style={styles.addBookReloadButton}
              onPress={handleReload}
              disabled={!hasQuery || loading || numFound <= RESULT_LIMIT}
            >
              {loading ? (
                <ActivityIndicator size="small" color={theme.textSecondary} />
              ) : (
                <Ionicons
                  name="arrow-down"
                  size={18}
                  color={
                    !hasQuery || numFound <= RESULT_LIMIT
                      ? theme.textSecondary
                      : theme.text
                  }
                />
              )}
            </PressableScale>
          ) : mode === "category" ? (
            <Pressable
              style={styles.addBookReloadButton}
              onPress={handleSubmitCategory}
              disabled={query.trim().length === 0}
            >
              <Ionicons
                name="return-down-back"
                size={18}
                color={
                  query.trim().length === 0 ? theme.textSecondary : theme.text
                }
              />
            </Pressable>
          ) : (
            <PressableScale
              style={styles.addBookReloadButton}
              onPress={handleSubmitWords}
              disabled={query.trim().length === 0 || wordsSubmitting}
            >
              {wordsSubmitting ? (
                <ActivityIndicator size="small" color={theme.textSecondary} />
              ) : (
                <Ionicons
                  name="return-down-back"
                  size={18}
                  color={
                    query.trim().length === 0
                      ? theme.textSecondary
                      : theme.text
                  }
                />
              )}
            </PressableScale>
          )}
        </View>

        {mode === "book" && searchError && (
          <View style={styles.addBookSearchErrorBlock}>
            <Text
              style={[
                styles.addBookSearchErrorText,
                { color: theme.textSecondary },
              ]}
            >
              {searchError}
            </Text>
          </View>
        )}

        {mode === "book" && !searchError && displayBooks.length > 0 && (
          <ScrollView
            style={styles.addBookResults}
            keyboardShouldPersistTaps="handled"
          >
            {displayBooks.map((book, i) => (
              <AddBookResultRow
                key={`${book.title}-${i}`}
                book={book}
                onPress={() => onSelectBook(book)}
                isLast={i === displayBooks.length - 1}
              />
            ))}
          </ScrollView>
        )}
      </Animated.View>
    </View>
  );
}

function AddBookFab({ onPress }: { onPress: () => void }) {
  const theme = useTheme();
  return (
    <PressableScale
      onPress={onPress}
      style={[
        styles.addBookFab,
        {
          borderColor: theme.separator,
          backgroundColor: theme.backgroundElement,
        },
      ]}
    >
      <Ionicons name="add" size={26} color={theme.text} />
    </PressableScale>
  );
}

export default function CollectionScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const {
    entries,
    books,
    bookReviews,
    categories,
    streak,
    addBook,
    assignBookCategory,
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
  } = useCollection();
  const { user, logout, deleteAccount } = useAuth();

  const rawUsername = user?.username ?? "";
  const displayUsername =
    rawUsername.length > MAX_USERNAME_LENGTH
      ? `${rawUsername.slice(0, MAX_USERNAME_LENGTH)}..`
      : rawUsername;

  const [settingsVisible, setSettingsVisible] = useState(false);
  const [colorThemeVisible, setColorThemeVisible] = useState(false);
  const [ratingBook, setRatingBook] = useState<CollectionBook | null>(null);
  const [addBookPromptVisible, setAddBookPromptVisible] = useState(false);

  // Settings is a local overlay (settingsVisible), not a real route, so
  // React Navigation has no idea it's open - tapping the collection tab
  // while it's showing would otherwise just no-op, since this screen was
  // already focused. tabPress fires on this screen any time its own tab
  // button is pressed, focused or not, which is exactly "collection tab
  // tapped while already here" - close the overlay the same way the
  // settings screen's own back-swipe does.
  // Typed as the bottom-tabs navigation prop specifically (not the generic
  // one useNavigation() infers by default) - "tabPress" only exists on
  // BottomTabNavigationEventMap, the generic core event map doesn't know
  // about it.
  const navigation =
    useNavigation<BottomTabNavigationProp<ParamListBase>>();
  useEffect(() => {
    const unsubscribe = navigation.addListener("tabPress", () => {
      setSettingsVisible(false);
    });
    return unsubscribe;
  }, [navigation]);

  // Closes whatever modal/prompt is open (settings, color picker, a rating
  // editor, an in-progress add-book search) whenever the app's been
  // backgrounded long enough to count as freshly reopened - see
  // resetGeneration's own comment in context/collection.tsx. Skipped on the
  // very first render (resetGeneration starts at 0, nothing to clear yet).
  const isFirstResetRef = useRef(true);
  useEffect(() => {
    if (isFirstResetRef.current) {
      isFirstResetRef.current = false;
      return;
    }
    setSettingsVisible(false);
    setColorThemeVisible(false);
    setRatingBook(null);
    setAddBookPromptVisible(false);
  }, [resetGeneration]);

  const bookAuthorKeyFor = useCallback(
    (b: CollectionBook) => b.author ?? NO_AUTHOR_LABEL,
    [],
  );

  // date sorts by latestBookActivity (the book's own addedAt, or a later
  // review's addedAt, whichever's more recent - see that function's
  // comment) rather than plain addedAt, so re-reviewing an old book brings
  // it back toward the top. author is grouped-then-alphabetical: the author
  // name sorts a-z/z-a per the direction toggle, but books with no author at
  // all always sink to the very bottom regardless of direction (same
  // treatment rating gives unrated books - see below), and books sharing
  // the same author are always most-recent-first via latestBookActivity,
  // fixed regardless of direction - only which author comes first flips,
  // same "fixed secondary sort" shape orderedEntries below uses for its own
  // book/author modes. rating always sinks unrated books to the very
  // bottom regardless of direction (not just "wherever lowest lands," which
  // asc would otherwise do), and ties (same rating, or unrated vs. unrated)
  // are always most-recent-first via latestBookActivity, fixed regardless
  // of direction - only the primary rating order flips. category isn't
  // handled here at all - see categorySections below, which needs to show
  // empty categories too (nothing to derive from a flat book list alone)
  // and ranks groups by book count rather than sorting individual books.
  const orderedBooks = useMemo(() => {
    const sign = bookSortDirection === "asc" ? 1 : -1;
    switch (bookSortMode) {
      case "date":
        return [...books].sort(
          (a, b) =>
            sign *
            latestBookActivity(a, bookReviews).localeCompare(
              latestBookActivity(b, bookReviews),
            ),
        );
      case "title":
        return [...books].sort(
          (a, b) => sign * a.title.localeCompare(b.title),
        );
      case "rating": {
        const ratingFor = (b: CollectionBook) =>
          averageBookRating(b.id, bookReviews);
        const recentFor = (b: CollectionBook) =>
          latestBookActivity(b, bookReviews);
        return [...books].sort((a, b) => {
          const ra = ratingFor(a);
          const rb = ratingFor(b);
          // Unrated books always sink to the very bottom, regardless of
          // direction - not just "wherever lowest lands," which asc would
          // otherwise put at the top.
          if (ra === null && rb === null) {
            return recentFor(b).localeCompare(recentFor(a));
          }
          if (ra === null) return 1;
          if (rb === null) return -1;
          // Same rating: always most-recent-first, fixed regardless of
          // direction - only the primary rating order flips, same "fixed
          // secondary sort" shape used elsewhere in this file (eg. author
          // mode's title tiebreak, category mode's within-group order).
          return (
            sign * (ra - rb) || recentFor(b).localeCompare(recentFor(a))
          );
        });
      }
      case "author": {
        const recentFor = (b: CollectionBook) =>
          latestBookActivity(b, bookReviews);
        return [...books].sort((a, b) => {
          const aHasAuthor = a.author !== null;
          const bHasAuthor = b.author !== null;
          // No-author books always sink to the very bottom, regardless of
          // direction - same treatment as unrated books in rating mode.
          if (!aHasAuthor && !bHasAuthor) {
            return recentFor(b).localeCompare(recentFor(a));
          }
          if (!aHasAuthor) return 1;
          if (!bHasAuthor) return -1;
          // Same author: always most-recent-first, fixed regardless of
          // direction - only the primary author order flips, same "fixed
          // secondary sort" shape used elsewhere in this file.
          return (
            sign * bookAuthorKeyFor(a).localeCompare(bookAuthorKeyFor(b)) ||
            recentFor(b).localeCompare(recentFor(a))
          );
        });
      }
      case "category":
        return books; // unused for rendering - see categorySections below
    }
  }, [books, bookReviews, bookSortMode, bookSortDirection, bookAuthorKeyFor]);

  // Section headers for date (month) and author. rating/title stay a flat
  // list, and category has its own dedicated categorySections below (null
  // tells the JSX below "no headers from this computation for this mode").
  const bookSections = useMemo(() => {
    switch (bookSortMode) {
      case "date":
        return groupConsecutive(orderedBooks, (b) =>
          monthGroup(latestBookActivity(b, bookReviews)),
        );
      case "author":
        return groupConsecutive(orderedBooks, bookAuthorKeyFor);
      default:
        return null;
    }
  }, [bookSortMode, orderedBooks, bookReviews, bookAuthorKeyFor]);

  // Category mode's own section list - unlike bookSections above, this is
  // built from the full categories list (not just names that happen to
  // appear on a book), so a category with zero books still gets a header,
  // and carries each section's real category id (categoryId: null for the
  // uncategorized bucket), needed to target a drop when dragging a row onto
  // a header. Ranked by how many books are in each category, per the
  // direction toggle - "n/a" is always pinned last regardless of direction,
  // since it isn't really "a category" to rank alongside the others. Books
  // within a category are always most-recent-first (latestBookActivity, see
  // its own comment) and never flip with the direction toggle either - that
  // toggle only ever controls which category comes first, same "fixed
  // secondary sort" shape orderedBooks above uses for its own author mode.
  //
  const categorySections = useMemo(() => {
    if (bookSortMode !== "category") return null;
    const categoryIdByName = new Map(categories.map((c) => [c.name, c.id]));
    const booksByCategoryId = new Map<string, CollectionBook[]>();
    const uncategorized: CollectionBook[] = [];
    for (const b of books) {
      const categoryId = b.genre ? categoryIdByName.get(b.genre) : undefined;
      if (categoryId) {
        const list = booksByCategoryId.get(categoryId) ?? [];
        list.push(b);
        booksByCategoryId.set(categoryId, list);
      } else {
        uncategorized.push(b);
      }
    }
    const byRecent = (list: CollectionBook[]) =>
      [...list].sort(
        (a, b) =>
          latestBookActivity(b, bookReviews).localeCompare(
            latestBookActivity(a, bookReviews),
          ),
      );
    const sign = bookSortDirection === "asc" ? 1 : -1;
    const namedSections = categories
      .map((c) => ({
        categoryId: c.id as string | null,
        header: c.name,
        items: byRecent(booksByCategoryId.get(c.id) ?? []),
      }))
      .sort(
        (a, b) =>
          // Tiebreak deliberately NOT scaled by sign - categories with the
          // same book count always sort a-z among themselves regardless of
          // direction; only which count-tier comes first flips.
          sign * (a.items.length - b.items.length) ||
          a.header.localeCompare(b.header),
      );
    return [
      ...namedSections,
      {
        categoryId: null as string | null,
        header: NO_CATEGORY_LABEL,
        items: byRecent(uncategorized),
      },
    ];
  }, [bookSortMode, books, bookReviews, categories, bookSortDirection]);

  // The #1-ranked category (by book count) - rendered as a fixed element
  // above the draggable list (see the render below) rather than a row
  // inside it, specifically so a book can never be dragged above it: with
  // this excluded from flatRows below, there's no row at the very top of
  // `data` for one to land ahead of.
  const topCategorySection = categorySections?.[0] ?? null;

  // Flattened (headers + their books, in real render order), recomputed
  // whenever the real, persisted data changes. Not fed directly into
  // DraggableFlatList's `data` (see draggableData below) - the library
  // expects onDragEnd's caller to set local state to *exactly* the array it
  // just reported (its own README example does `setData(data)`); handing it
  // a *different* order immediately afterward (like the real, recency-
  // sorted order, which can very much differ from wherever a book was
  // manually dropped) fights its own internal drag-completion bookkeeping -
  // that mismatch, not a rendering quirk, is what was causing rows to
  // desync or vanish after a within-category reorder.
  const flatRows: FlatRow[] = useMemo(() => {
    if (!categorySections || categorySections.length === 0) return [];
    const [topSection, ...restSections] = categorySections;
    const topBooks = topSection.items.map((book) => ({
      key: `book:${book.id}`,
      type: "book" as const,
      book,
    }));
    const restRows = restSections.flatMap((section) => {
      const categoryKey = section.categoryId ?? UNCATEGORIZED_DRAG_KEY;
      return [
        {
          key: `header:${categoryKey}`,
          type: "header" as const,
          categoryId: section.categoryId,
          label: section.header,
        },
        ...section.items.map((book) => ({
          key: `book:${book.id}`,
          type: "book" as const,
          book,
        })),
      ];
    });
    return [...topBooks, ...restRows];
  }, [categorySections]);

  // What DraggableFlatList's `data` actually is - starts matching flatRows,
  // but during/right after a drag it holds exactly what the library itself
  // reported (see handleCategoryDragEnd), so the library's own internal
  // state always agrees with what's on screen. The effect below is what
  // lets the *real* sort catch up afterward: once assignBookCategory's
  // state change flows through and flatRows updates to the real order, this
  // re-syncs to it - a completely ordinary prop update at that point, not
  // something arriving in the same beat as the drag's own completion.
  // useLayoutEffect, not useEffect - the real order is already computed
  // (flatRows is a plain useMemo, not itself deferred) by the time this
  // runs, so doing the re-sync before the browser/native paints means the
  // screen only ever shows the corrected order, never a flash of the raw
  // dropped order first. Most noticeable for a cross-category move where
  // the category's own book count (and so its rank against the others)
  // changes - without this, that category's header would briefly render at
  // its old rank before visibly jumping to its new one a frame later.
  const [draggableData, setDraggableData] = useState<FlatRow[]>(flatRows);
  useLayoutEffect(() => {
    // Tells the native side to animate whatever layout changes come out of
    // the state update right below - the actual repositioning still has to
    // happen synchronously before paint (see the comment above), this just
    // makes the native layer tween the resulting position change instead of
    // snapping it. Deliberately plain LayoutAnimation (native, not
    // Reanimated) - react-native-draggable-flatlist's own Reanimated-based
    // itemLayoutAnimation crashed the app, so this sidesteps it entirely.
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setDraggableData(flatRows);
  }, [flatRows]);

  // dataWithFooter is what's actually passed to DraggableFlatList - see
  // CATEGORY_FOOTER_ROW's own comment for why the trailing reserve is a
  // real appended row rather than inflated onto whatever the last real row
  // happens to be. draggableData itself (and flatRows/onDragEnd) stays
  // footer-free - it's stripped back out in handleCategoryDragEnd before
  // being fed into the reorder/category-assignment logic below, since that
  // logic has no notion of a non-header, non-book row.
  const dataWithFooter = useMemo(
    () => [...draggableData, CATEGORY_FOOTER_ROW],
    [draggableData],
  );

  // Cumulative offset/length per row, from the fixed HEADER_ROW_HEIGHT/
  // BOOK_ROW_HEIGHT above (or the trailing reserve, for the footer row) -
  // see getCategoryRowLayout below for what this feeds into.
  const categoryRowLayouts = useMemo(() => {
    const layouts: { length: number; offset: number }[] = [];
    let offset = 0;
    for (const row of dataWithFooter) {
      const length =
        row.type === "header"
          ? HEADER_ROW_HEIGHT
          : row.type === "footer"
            ? insets.bottom + Spacing.two
            : BOOK_ROW_HEIGHT;
      layouts.push({ length, offset });
      offset += length;
    }
    return layouts;
  }, [dataWithFooter, insets.bottom]);

  const getCategoryRowLayout = useCallback(
    (_data: ArrayLike<FlatRow> | null | undefined, index: number) => {
      const layout = categoryRowLayouts[index] ?? {
        length: BOOK_ROW_HEIGHT,
        offset: BOOK_ROW_HEIGHT * index,
      };
      return { ...layout, index };
    },
    [categoryRowLayouts],
  );

  // DraggableFlatList's onDragEnd - first mirrors the library's own
  // reported order into draggableData (matching its expected
  // onDragEnd={({data}) => setData(data)} pattern exactly), then separately
  // resolves the dropped book's new index into a category (see
  // categoryForDropIndex) and calls assignBookCategory, even when that
  // category turns out to be the same one the book already had. That's
  // deliberate, not an oversight: a book's position *within* a category is
  // never manually persisted (see categorySections' own byRecent sort
  // above), so a same-category drop has nothing real to persist beyond
  // forcing flatRows to refresh - which, via the effect above, is what
  // brings the list back to its real sorted order instead of just leaving
  // the book wherever it was dropped.
  const handleCategoryDragEnd = useCallback(
    ({ data: rawData, to: rawTo }: { data: FlatRow[]; to: number }) => {
      // rawData/rawTo come from dataWithFooter (see its own comment) - the
      // footer row (never itself draggable, no drag handle wired to it) can
      // only ever end up at the very end, so dropping "on" it is just
      // dropping at the end of the real rows.
      const footerIndex = rawData.findIndex((r) => r.type === "footer");
      const data =
        footerIndex === -1
          ? rawData
          : rawData.filter((r) => r.type !== "footer");
      const to =
        footerIndex === -1 ? rawTo : Math.min(rawTo, data.length - 1);
      setDraggableData(data);
      const droppedRow = data[to];
      if (!droppedRow || droppedRow.type !== "book") return;
      assignBookCategory(
        droppedRow.book.id,
        categoryForDropIndex(
          data,
          to,
          topCategorySection?.categoryId ?? null,
        ),
      );
    },
    [assignBookCategory, topCategorySection],
  );

  const bookKeyFor = useCallback(
    (e: CollectionEntry) => e.book?.title ?? NO_BOOK_LABEL,
    [],
  );
  const authorKeyFor = useCallback(
    (e: CollectionEntry) => e.book?.author ?? NO_AUTHOR_LABEL,
    [],
  );

  const bookCounts = useMemo(() => countBy(entries, bookKeyFor), [entries]);
  const authorCounts = useMemo(() => countBy(entries, authorKeyFor), [entries]);

  // entries is date-descending by default. For date mode, flipping direction
  // just reverses the list. For every other mode, toggling direction should
  // only flip which group comes first (eg. not-learned vs. mastered, or
  // most- vs. least-used book) - entries within a group should always stay
  // most-recently-added first, so we sort fresh with the group key as the
  // primary sort and addedAt-descending as a fixed tiebreak, instead of
  // reversing the whole array.
  const orderedEntries = useMemo(() => {
    if (sortMode === "date") {
      return sortDirection === "desc" ? entries : [...entries].reverse();
    }
    if (sortMode === "mastery") {
      const sign = sortDirection === "asc" ? 1 : -1;
      return [...entries].sort(
        (a, b) =>
          sign * ((a.mastery ?? 0) - (b.mastery ?? 0)) ||
          b.addedAt.localeCompare(a.addedAt),
      );
    }
    if (sortMode === "az") {
      const sign = sortDirection === "asc" ? 1 : -1;
      return [...entries].sort(
        (a, b) => sign * a.word.localeCompare(b.word),
      );
    }
    // book/author: ranked by # words in that group (ties broken by which
    // group was most recently added to), not by the raw group name. The
    // "n/a" group (no book/author at all) always sinks to the very bottom
    // regardless of direction, same treatment the books list gives
    // unrated/no-author books.
    const keyFor = sortMode === "book" ? bookKeyFor : authorKeyFor;
    const counts = sortMode === "book" ? bookCounts : authorCounts;
    const noneLabel = sortMode === "book" ? NO_BOOK_LABEL : NO_AUTHOR_LABEL;
    const sign = sortDirection === "asc" ? 1 : -1;
    return [...entries].sort((a, b) => {
      const ka = keyFor(a);
      const kb = keyFor(b);
      const aIsNone = ka === noneLabel;
      const bIsNone = kb === noneLabel;
      if (aIsNone && bIsNone) return b.addedAt.localeCompare(a.addedAt);
      if (aIsNone) return 1;
      if (bIsNone) return -1;
      const ga = counts.get(ka)!;
      const gb = counts.get(kb)!;
      return (
        sign * (ga.count - gb.count) ||
        gb.mostRecent.localeCompare(ga.mostRecent) ||
        b.addedAt.localeCompare(a.addedAt)
      );
    });
  }, [
    sortMode,
    sortDirection,
    entries,
    bookCounts,
    authorCounts,
    bookKeyFor,
    authorKeyFor,
  ]);

  const sections = useMemo(() => {
    switch (sortMode) {
      case "date":
        return groupConsecutive(orderedEntries, (e) => monthGroup(e.addedAt));
      case "mastery":
        return groupConsecutive(orderedEntries, (e) => masteryGroup(e.mastery));
      case "book":
        return groupConsecutive(orderedEntries, bookKeyFor);
      case "author":
        return groupConsecutive(orderedEntries, authorKeyFor);
      case "az":
        return groupConsecutive(orderedEntries, (e) =>
          e.word[0]?.toLowerCase() ?? "",
        );
    }
  }, [sortMode, orderedEntries, bookKeyFor, authorKeyFor]);

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      {/* profile header */}
      <View
        style={[
          styles.profileHeader,
          {
            paddingTop: insets.top + Spacing.four,
            borderBottomColor: theme.separator,
          },
        ]}
      >
        <View style={styles.profileRow}>
          <View style={styles.usernameRow}>
            <Text
              style={[styles.username, { color: theme.text }]}
              numberOfLines={1}
            >
              @{displayUsername}
            </Text>
            {streak >= STREAK_MIN_TO_SHOW && (
              <View style={styles.streakRow}>
                <Text
                  style={[styles.streakText, { color: theme.text }]}
                  numberOfLines={1}
                >
                  {streak}
                </Text>
                <Ionicons name="flame" size={16} color={theme.text} />
              </View>
            )}
          </View>
          <PressableScale
            onPress={() => setSettingsVisible(true)}
            style={[
              styles.settingsButton,
              { backgroundColor: theme.backgroundElement },
            ]}
          >
            <Text style={[styles.settingsIcon, { color: theme.text }]}>⋯</Text>
          </PressableScale>
        </View>
      </View>

      {settingsVisible && (
        <SettingsScreen
          onDismiss={() => setSettingsVisible(false)}
          onModifyColorTheme={() => setColorThemeVisible(true)}
          onLogout={logout}
          onDeleteAccount={() => {
            Alert.alert("r u sure ??", undefined, [
              { text: "no", style: "cancel" },
              {
                text: "yes",
                style: "destructive",
                onPress: () => {
                  deleteAccount().catch((error) => {
                    console.error("[account] delete failed", error);
                    Alert.alert("something went wrong", "please try again.");
                  });
                },
              },
            ]);
          }}
        />
      )}

      {colorThemeVisible && (
        <ColorThemeModal onDismiss={() => setColorThemeVisible(false)} />
      )}

      {ratingBook && (
        <RatingPrompt book={ratingBook} onDismiss={() => setRatingBook(null)} />
      )}

      {addBookPromptVisible && (
        <AddBookPrompt
          onDismiss={() => setAddBookPromptVisible(false)}
          onSelectBook={(book: BookResult) => {
            addBook(book);
            setAddBookPromptVisible(false);
          }}
        />
      )}

      <View style={[styles.sortRow, { borderBottomColor: theme.separator }]}>
        <View
          style={[
            styles.viewModeToggle,
            { backgroundColor: theme.backgroundElement },
          ]}
        >
          <Pressable
            style={[
              styles.viewModeSegment,
              viewMode === "books" && {
                backgroundColor: theme.backgroundSelected,
              },
            ]}
            onPress={() => setViewMode("books")}
          >
            <Text style={[styles.viewModeSegmentText, { color: theme.text }]}>
              books
            </Text>
          </Pressable>
          <Pressable
            style={[
              styles.viewModeSegment,
              viewMode === "words" && {
                backgroundColor: theme.backgroundSelected,
              },
            ]}
            onPress={() => setViewMode("words")}
          >
            <Text style={[styles.viewModeSegmentText, { color: theme.text }]}>
              words
            </Text>
          </Pressable>
        </View>
        {viewMode === "words" && entries.length > 0 && (
          <View style={styles.sortControls}>
            <PressableScale
              style={[
                styles.sortButton,
                { backgroundColor: theme.backgroundElement },
              ]}
              onPress={() =>
                setSortMode(
                  (m) =>
                    SORT_MODES[(SORT_MODES.indexOf(m) + 1) % SORT_MODES.length],
                )
              }
            >
              <Text style={[styles.sortButtonText, { color: theme.text }]}>
                {SORT_MODE_LABELS[sortMode]}
              </Text>
            </PressableScale>
            <PressableScale
              style={[
                styles.directionButton,
                { backgroundColor: theme.backgroundElement },
              ]}
              onPress={() =>
                setSortDirection((d) => (d === "asc" ? "desc" : "asc"))
              }
            >
              <Text style={[styles.directionButtonText, { color: theme.text }]}>
                {sortDirection === "asc" ? "▲" : "▼"}
              </Text>
            </PressableScale>
          </View>
        )}
        {viewMode === "books" && books.length > 0 && (
          <View style={styles.sortControls}>
            <PressableScale
              style={[
                styles.sortButton,
                { backgroundColor: theme.backgroundElement },
              ]}
              onPress={() =>
                setBookSortMode(
                  (m) =>
                    BOOK_SORT_MODES[
                      (BOOK_SORT_MODES.indexOf(m) + 1) % BOOK_SORT_MODES.length
                    ],
                )
              }
            >
              <Text style={[styles.sortButtonText, { color: theme.text }]}>
                {BOOK_SORT_MODE_LABELS[bookSortMode]}
              </Text>
            </PressableScale>
            <PressableScale
              style={[
                styles.directionButton,
                { backgroundColor: theme.backgroundElement },
              ]}
              onPress={() =>
                setBookSortDirection((d) => (d === "asc" ? "desc" : "asc"))
              }
            >
              <Text style={[styles.directionButtonText, { color: theme.text }]}>
                {bookSortDirection === "asc" ? "▲" : "▼"}
              </Text>
            </PressableScale>
          </View>
        )}
      </View>

      {viewMode === "books" ? (
        // Category mode still has something to show (empty category
        // headers) even with zero books, as long as at least one category
        // exists - only the true "nothing at all" case falls back to the
        // empty-state message.
        books.length === 0 &&
        (bookSortMode !== "category" || categories.length === 0) ? (
          <View style={styles.empty}>
            <Text style={[styles.emptyText, { color: theme.textSecondary }]}>
              no books saved yet
            </Text>
          </View>
        ) : categorySections ? (
          <View style={styles.categoryListWrapper}>
            {/* Fixed above the draggable list, not a row inside it - see
                topCategorySection's own comment for why: it's what actually
                keeps a book from ever being dragged above the #1 category.
                Keyed by categoryId (unlike a row inside DraggableFlatList,
                which already gets this for free from keyExtractor) so
                deleting the top category forces a fresh mount for whichever
                category becomes #1 next, instead of React reusing this same
                instance and carrying over its mid-delete Reanimated shared
                values (rowTranslateX stuck off-screen, confirmed still
                true) onto a category that was never actually deleted. */}
            {topCategorySection && (
              <CategoryHeaderRow
                key={topCategorySection.categoryId}
                categoryId={topCategorySection.categoryId}
                label={topCategorySection.header}
              />
            )}
            {/* flatRows already interleaves the *remaining* headers and
                books in the order to render; the library owns all of the
                actual drag/reflow animation from here. */}
            <DraggableFlatList
              data={dataWithFooter}
              keyExtractor={(row) => row.key}
              onDragEnd={handleCategoryDragEnd}
              getItemLayout={getCategoryRowLayout}
              autoscrollThreshold={AUTO_SCROLL_EDGE}
              // Explicit, rather than implicitly relying on this sizing
              // itself against topCategorySection's sibling space above it -
              // without it, this list's own internal scroll math treated
              // its viewport as the full wrapper height rather than the
              // true, topCategorySection-reduced remainder it actually
              // renders within, so it stopped scrolling short of the real
              // end.
              containerStyle={{ flex: 1 }}
              // onDragEnd (and so assignBookCategory, and the real resort it
              // triggers) only fires once this settle animation finishes -
              // the default spring is soft enough that there's a visible
              // pause between letting go and the list actually resorting.
              // Snappier spring here shortens that gap.
              animationConfig={{ damping: 20, stiffness: 400 }}
              contentContainerStyle={styles.list}
              renderItem={({ item, drag, isActive }) =>
                item.type === "header" ? (
                  <CategoryHeaderRow
                    categoryId={item.categoryId}
                    label={item.label}
                  />
                ) : item.type === "book" ? (
                  <ScaleDecorator activeScale={1.03}>
                    <BookRow
                      book={item.book}
                      borderColor={theme.separator}
                      onPressRating={setRatingBook}
                      onLongPressDrag={drag}
                      isActive={isActive}
                    />
                  </ScaleDecorator>
                ) : (
                  // Trailing reserve - see CATEGORY_FOOTER_ROW's own
                  // comment. No drag handle wired up, so there's no way for
                  // a user to actually grab/reorder this one.
                  <View style={{ height: insets.bottom + Spacing.two }} />
                )
              }
            />
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={styles.list}
            contentInsetAdjustmentBehavior="never"
          >
            {bookSections ? (
              bookSections.map((section) => (
                <View key={section.header}>
                  <View
                    style={[
                      styles.sectionHeaderRow,
                      {
                        borderBottomColor: theme.separator,
                        backgroundColor: theme.backgroundElement,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.sectionHeader,
                        { color: theme.textSecondary },
                      ]}
                    >
                      {section.header}
                    </Text>
                  </View>
                  {section.items.map((book) => (
                    <BookRow
                      key={book.id}
                      book={book}
                      borderColor={theme.separator}
                      onPressRating={setRatingBook}
                    />
                  ))}
                </View>
              ))
            ) : (
              orderedBooks.map((book) => (
                <BookRow
                  key={book.id}
                  book={book}
                  borderColor={theme.separator}
                  onPressRating={setRatingBook}
                />
              ))
            )}
            <View style={{ height: insets.bottom + Spacing.two }} />
          </ScrollView>
        )
      ) : entries.length === 0 ? (
        <View style={styles.empty}>
          <Text style={[styles.emptyText, { color: theme.textSecondary }]}>
            no words saved yet
          </Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.list}
          contentInsetAdjustmentBehavior="never"
        >
          {sections.map((section) => (
            <View key={section.header}>
              {/* a-z is a single continuous alphabet, not discrete groups
                  like every other sort mode here - a header per letter (or
                  worse, one per word once entries thin out) is just noise,
                  not a useful landmark. */}
              {sortMode !== "az" && (
                <View
                  style={[
                    styles.sectionHeaderRow,
                    {
                      borderBottomColor: theme.separator,
                      backgroundColor: theme.backgroundElement,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.sectionHeader,
                      { color: theme.textSecondary },
                    ]}
                  >
                    {section.header}
                  </Text>
                </View>
              )}
              {section.items.map((entry) => (
                <WordRow key={entry.word} entry={entry} />
              ))}
            </View>
          ))}
          <View style={{ height: insets.bottom + Spacing.two }} />
        </ScrollView>
      )}

      {/* Floating over the whole screen, not tucked into the toolbar row -
          centered horizontally near the bottom. pointerEvents="box-none" on
          the wrapper keeps the rest of this row transparent to touches
          outside the button itself. Shown in both books and words mode now -
          AddBookPrompt's own book/category/words segmented control covers
          adding a word from here too, not just a book. */}
      <View
        style={[
          styles.addBookFabOverlay,
          { bottom: insets.bottom - Spacing.three },
        ]}
        pointerEvents="box-none"
      >
        <AddBookFab onPress={() => setAddBookPromptVisible(true)} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  categoryListWrapper: {
    flex: 1,
  },
  profileHeader: {
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.four,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: Spacing.three,
  },
  profileRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  usernameRow: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.three,
    marginRight: Spacing.two,
  },
  username: {
    fontSize: 22,
    fontWeight: "600",
    fontFamily: Fonts?.mono,
    flexShrink: 1,
  },
  streakRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.half,
    flexShrink: 0,
  },
  streakText: {
    fontSize: 16,
    fontWeight: "600",
    fontFamily: Fonts?.mono,
  },
  settingsButton: {
    flexShrink: 0,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
    borderRadius: Spacing.four,
  },
  settingsIcon: {
    fontSize: 16,
    fontWeight: "600",
  },
  settingsScreen: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 10,
    paddingHorizontal: Spacing.four,
  },
  settingsEdge: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: SWIPE_EDGE_WIDTH,
  },
  backButton: {
    alignSelf: "flex-start",
    padding: Spacing.two,
    marginLeft: -Spacing.two,
    borderRadius: Spacing.four,
  },
  settingsOptions: {
    flex: 1,
    justifyContent: "center",
    paddingBottom: Spacing.six,
  },
  // Negative margin cancels out settingsScreen's paddingHorizontal, so the
  // bar spans the full screen width instead of stopping at that padding.
  settingsDivider: {
    height: StyleSheet.hairlineWidth,
    marginHorizontal: -Spacing.four,
  },
  // Same full-bleed trick as settingsDivider - the negative margin cancels
  // settingsScreen's padding so the press-down background reaches the
  // screen edges, then the matching padding keeps the text in the same
  // inset spot as before.
  settingsOption: {
    paddingVertical: Spacing.three,
    marginHorizontal: -Spacing.four,
    paddingHorizontal: Spacing.four,
    alignItems: "center",
  },
  settingsOptionText: {
    fontSize: 16,
    fontFamily: Fonts?.mono,
    textAlign: "center",
  },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyText: {
    fontSize: 20,
    fontFamily: Fonts?.mono,
  },
  sortRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.two,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  // Two Pressables in a padded pill track, the active one filled - reads as
  // a slide toggle even though switching is click-only, no drag/animation.
  viewModeToggle: {
    flexDirection: "row",
    borderRadius: Spacing.four,
    padding: 2,
  },
  viewModeSegment: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
    borderRadius: Spacing.four,
  },
  viewModeSegmentText: {
    fontSize: 13,
    fontFamily: Fonts?.mono,
  },
  sortControls: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.three,
  },
  sortButton: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
    borderRadius: Spacing.four,
  },
  // Covers the row's full width so alignItems can center the button
  // horizontally regardless of screen size - `bottom` is set inline (needs
  // insets.bottom).
  addBookFabOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
  },
  addBookFab: {
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  sortButtonText: {
    fontSize: 13,
    fontFamily: Fonts?.mono,
  },
  directionButton: {
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
    borderRadius: Spacing.four,
  },
  directionButtonText: {
    fontSize: 11,
  },
  list: {},
  colorModalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.4)",
    paddingHorizontal: Spacing.five + Spacing.one,
  },
  colorModalCard: {
    width: "100%",
    borderRadius: Spacing.four,
    paddingVertical: Spacing.four,
    paddingHorizontal: Spacing.four,
    alignItems: "center",
    gap: Spacing.four,
  },
  moodImmutableRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.two,
  },
  moodImmutableLabel: {
    fontSize: 14,
    fontFamily: Fonts?.mono,
  },
  ratingModalCard: {
    width: "100%",
    borderRadius: Spacing.four,
    paddingVertical: Spacing.four,
    paddingHorizontal: Spacing.four,
    gap: Spacing.four,
  },
  ratingModalHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.two,
  },
  // flex:1 lives here (not on ratingModalTitle) - this is what
  // AutoMarqueeTitle measures against and clips to, same relationship as
  // bookRowContent/bookTitleClip below.
  ratingModalTitleClip: {
    flex: 1,
    overflow: "hidden",
  },
  ratingModalTitle: {
    fontSize: 18,
    fontWeight: "600",
    fontFamily: Fonts?.mono,
  },
  // Only for the revealed (full-text, sliding) state - see bookTitle's
  // comment above for why a wide fixed width instead of intrinsic sizing.
  ratingModalTitleFull: {
    width: TITLE_BOX_WIDTH,
  },
  ratingSaveButton: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
    borderRadius: Spacing.four,
  },
  ratingSaveButtonText: {
    fontSize: 14,
    fontFamily: Fonts?.mono,
  },
  sliderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.three,
  },
  // Fixed width, wide enough for "10.0" - without this, the track
  // (flex:1 in the same row) visibly shrinks whenever the value gains a
  // digit (eg. "9.0" -> "10.0"), since this text's own natural width would
  // otherwise grow and eat into the track's space.
  sliderValue: {
    width: 44,
    textAlign: "right",
    fontSize: 16,
    fontWeight: "600",
    fontFamily: Fonts?.mono,
  },
  // Extra vertical room around the track itself - a bigger touch target
  // than the track's own thin height.
  sliderTrackWrapper: {
    flex: 1,
    height: 40,
    justifyContent: "center",
  },
  sliderTrack: {
    height: SLIDER_TRACK_HEIGHT,
    borderRadius: SLIDER_TRACK_HEIGHT / 2,
  },
  sliderFill: {
    position: "absolute",
    left: 0,
    height: SLIDER_TRACK_HEIGHT,
    borderRadius: SLIDER_TRACK_HEIGHT / 2,
  },
  // left (the animated %) positions this thumb's own left edge, so the
  // fixed negative margins here re-center it on that point instead of
  // offsetting it to the right by its own size.
  // left:0 (not centered via a negative marginLeft) since thumbStyle's
  // translateX is already the thumb's own left-edge position, inset to
  // stay within the track - see thumbStyle's comment.
  sliderThumb: {
    position: "absolute",
    left: 0,
    top: "50%",
    width: SLIDER_THUMB_SIZE,
    height: SLIDER_THUMB_SIZE,
    borderRadius: SLIDER_THUMB_SIZE / 2,
    marginTop: -SLIDER_THUMB_SIZE / 2,
  },
  // Fixed height (not minHeight) so it never grows past this - long text
  // scrolls inside instead, same as any other fixed-size multiline input.
  // overflow:hidden + a little vertical padding is what keeps the
  // TextInput's own scroll indicator inset from these rounded corners
  // rather than running flush into the curve.
  reviewInputWrapper: {
    height: 260,
    // Matches learn.tsx's multiline input (the sentence-writing box), not
    // the Spacing.three used elsewhere in this modal.
    borderRadius: Spacing.two,
    overflow: "hidden",
    paddingVertical: Spacing.one,
  },
  reviewInput: {
    flex: 1,
    paddingHorizontal: Spacing.three,
    fontSize: 15,
    textAlignVertical: "top",
  },
  // viewModeToggle has no explicit width, so as a direct child of
  // ratingModalCard (a column-flex container, default alignItems:stretch)
  // it stretches to the card's full width - leaving unused track space
  // after "category" instead of hugging just the two segments. The
  // top-level books/words toggle doesn't have this problem since its
  // parent (sortRow) is row-direction, where width isn't the stretched
  // axis. alignSelf:center overrides just this instance back to
  // content-sized, and centers it in the process.
  addBookModeToggle: {
    alignSelf: "center",
  },
  addBookSearchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.two,
    // Pulls the row out past ratingModalCard's own paddingHorizontal
    // (Spacing.four) so the input/button sit closer to the card's edges
    // than the rest of the card's content does, rather than matching it.
    marginHorizontal: -Spacing.two,
    // ratingModalCard's own `gap` (Spacing.four) spaces every direct child
    // evenly, which put too much air between the toggle above and this row
    // - pulls just that one gap in without touching any other spacing.
    marginTop: -Spacing.three,
  },
  addBookSearchInput: {
    flex: 1,
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + Spacing.half,
    fontSize: 16,
  },
  // Same as addBookSearchInput, just this tall - fontSize 16's line height
  // times 8, plus the same vertical padding - instead of one line, since
  // this is meant for pasting/typing several words at once. Fixed height,
  // not minHeight - past 8 lines the box stops growing and scrolls
  // internally instead (TextInput's own default multiline behavior once
  // height is constrained rather than left to grow).
  addBookWordsInput: {
    flex: 1,
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + Spacing.half,
    fontSize: 16,
    height: 208,
  },
  addBookReloadButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  addBookResults: {
    maxHeight: 220,
  },
  addBookSearchErrorBlock: {
    paddingVertical: Spacing.three,
    alignItems: "center",
  },
  addBookSearchErrorText: {
    fontSize: 14,
    fontFamily: Fonts?.mono,
    textAlign: "center",
  },
  addBookResultRow: {
    paddingVertical: Spacing.two,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  // Fixed height + overflow:hidden is what actually crops the title at
  // rest, and gives onLayout a real width to measure the reveal/clip
  // against - no explicit width, so it stretches to the row's full width
  // via the default column alignItems:stretch.
  addBookResultTitleClip: {
    height: 20,
    overflow: "hidden",
  },
  addBookResultTitle: {
    fontSize: 16,
    fontFamily: Fonts?.mono,
  },
  // Only used for the revealed (full-text) state - explicit, generous,
  // fixed width so it never wraps and simply extends past
  // addBookResultTitleClip's edge for the swipe/translateX to reveal.
  addBookResultTitleRevealed: {
    width: ADD_BOOK_RESULT_TITLE_BOX_WIDTH,
  },
  addBookResultAuthor: {
    fontSize: 13,
    marginTop: 2,
  },
  addBookResultAuthorHidden: {
    opacity: 0,
  },
  reviewSummaryMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.two,
  },
  reviewSummaryScorePill: {
    paddingHorizontal: Spacing.two,
    paddingVertical: 2,
    // Large enough to stay fully rounded (a pill) regardless of the text's
    // actual line height, rather than tracking it exactly. A View (not a
    // nested Text-in-Text) is what makes this actually render rounded -
    // background/borderRadius on a nested Text only paints per glyph-run,
    // not as a real box, so it came out as a rectangle.
    borderRadius: 999,
  },
  reviewSummaryScore: {
    fontSize: 14,
    fontWeight: "700",
    fontFamily: Fonts?.mono,
  },
  reviewSummaryDate: {
    fontSize: 14,
    fontFamily: Fonts?.mono,
  },
  // Well past addBookResults' cap below - past reviews can run longer than
  // a search-results list, so it gets more room before it starts scrolling.
  reviewSummaryScroll: {
    maxHeight: 520,
  },
  // flexGrow:1 makes the content container fill the scroll area whenever
  // the reviews don't reach reviewSummaryScroll's maxHeight, so a short
  // list centers vertically instead of sitting pinned to the top with a
  // lot of empty space below it. Once there's enough content to exceed
  // maxHeight, this has no effect and it scrolls normally. paddingRight
  // keeps the text from butting right up against the scroll indicator,
  // which otherwise sits flush against it.
  reviewSummaryContentFlush: {
    paddingRight: Spacing.three,
    flexGrow: 1,
    justifyContent: "center",
  },
  // Space between each past review's own meta+text pair, and between that
  // pair and the next review below it.
  pastReviewEntry: {
    gap: Spacing.one,
    marginBottom: Spacing.three,
  },
  // Just the slider+textbox, not the whole card - wrapped in its own
  // Pressable (see the comment where this is used) so tapping empty space
  // here dismisses the keyboard without blocking the past-reviews
  // ScrollView above it, which sits outside this Pressable entirely.
  ratingEditableSection: {
    gap: Spacing.four,
  },
  sectionHeaderRow: {
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.two,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  // Explicit lineHeight, same reasoning as bookAuthor's own comment below -
  // makes this row's total height (paddingTop + paddingBottom + this) fully
  // deterministic for getItemLayout.
  sectionHeader: {
    fontSize: 12,
    fontWeight: "700",
    fontFamily: Fonts?.mono,
    textTransform: "uppercase",
    letterSpacing: 1,
    lineHeight: 15,
  },
  rowWrapper: {
    position: "relative",
    overflow: "hidden",
  },
  deleteAction: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: "flex-start",
    justifyContent: "center",
    paddingLeft: Spacing.four,
  },
  deleteButtonText: {
    color: "#000000",
    fontSize: 14,
    fontWeight: "700",
    fontFamily: Fonts?.mono,
  },
  row: {
    paddingTop: Spacing.two,
    paddingBottom: Spacing.two,
    paddingHorizontal: Spacing.four,
    gap: Spacing.half,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  word: {
    fontSize: 18,
    fontFamily: Fonts?.mono,
  },
  snippet: {
    fontSize: 13,
    lineHeight: 18,
  },
  // Just the border now - the row's own layout (padding, flex row) lives on
  // bookRowPressable below, since that's the actual tap target and needs the
  // padding inside it for the press highlight to cover the full row.
  bookRow: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  // The whole row is one Pressable: title/author stack on the left
  // (bookRowContent, flex:1) and the rating circle trailing on the right.
  bookRowPressable: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 56,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.two,
    paddingHorizontal: Spacing.three,
    gap: Spacing.two,
  },
  // No minHeight/justifyContent of its own - bookRowPressable's
  // alignItems:center already centers this block (title-only or
  // title+author) vertically within the row's fixed minHeight, same as it
  // does for the rating circle next to it.
  bookRowContent: {
    flex: 1,
    gap: Spacing.half,
  },
  // No explicit width - stretches to bookRowContent's full width via the
  // parent's default column alignItems:stretch, giving onLayout a real
  // measurement to clip/reveal against. overflow:hidden is what actually
  // crops the title at rest.
  bookTitleClip: {
    height: 22,
    overflow: "hidden",
  },
  // Only used for the revealed (full-text) state - explicit, generous,
  // fixed width, not auto/intrinsic (see estimateTextWidth's comment for
  // why), so it never wraps and simply extends past bookTitleClip's edge
  // for the swipe/translateX to reveal.
  bookTitle: {
    width: TITLE_BOX_WIDTH,
    fontSize: TITLE_FONT_SIZE,
    fontFamily: Fonts?.mono,
  },
  // The resting (character-truncated, already includes "..") display - a
  // plain single-line Text, no special width/positioning needed since the
  // string itself is already sized to fit.
  bookTitleTruncated: {
    fontSize: TITLE_FONT_SIZE,
    fontFamily: Fonts?.mono,
  },
  // Explicit lineHeight (not just left to the font's natural one) - keeps
  // this row's total height fully deterministic (title clip 22 + gap 2 +
  // this = 40, plus bookRowPressable's own 16px of padding = exactly its
  // minHeight of 56) for getItemLayout below, which needs to know every
  // row's real height up front rather than estimating it.
  bookAuthor: {
    fontSize: 13,
    lineHeight: 16,
  },
  ratingCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  ratingCircleText: {
    fontSize: 15,
    fontFamily: Fonts?.mono,
    fontWeight: "600",
  },
});
