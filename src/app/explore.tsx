import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Dimensions,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect } from "@react-navigation/native";
import type { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import type { ParamListBase } from "@react-navigation/native";
import { useNavigation } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";

import {
  ExpandableReviewText,
  formatReviewDate,
} from "@/components/expandable-review-text";
import { FlyingHeart } from "@/components/flying-heart";
import { PressableScale } from "@/components/pressable-scale";
import { AvatarThumbnail } from "@/components/profile-picture-modal";
import { API_BASE_URL } from "@/constants/api";
import { Fonts, Spacing } from "@/constants/theme";
import { useAuth } from "@/context/auth";
import type {
  BookReview,
  BookSortMode,
  Category,
  CollectionBook,
  SortDirection,
} from "@/context/collection";
import {
  type FeedEntry,
  type FollowUser,
  type ReviewEntry,
  type StartedReadingEntry,
  useFollows,
} from "@/context/follows";
import { useTheme } from "@/hooks/use-theme";
import { hasReacted, markReacted } from "@/lib/reaction-cache";

// Same swipe-left-to-reveal-title behavior as collection.tsx's BookRow and
// book-prompt.tsx's BookResultRow - constant px/sec reveal speed (not a
// fixed duration) so a long username doesn't slide any faster/slower than a
// barely-clipped one, same reasoning as those. See either of those files'
// own comments for the full rationale.
const USERNAME_SWIPE_THRESHOLD = 24;
const USERNAME_REVEAL_PIXELS_PER_SECOND = 55;
const USERNAME_HIDE_DURATION = 350;
const USERNAME_REVEAL_PAUSE = 900;
const USERNAME_BOX_WIDTH = 2000;
const USERNAME_FONT_SIZE = 14; // matches listRowText's fontSize
const USERNAME_MONO_CHAR_WIDTH = USERNAME_FONT_SIZE * 0.62;

function estimateUsernameWidth(text: string): number {
  return text.length * USERNAME_MONO_CHAR_WIDTH;
}

// Height of the trailing unfollow/follow-back button.
const ROW_ACTION_HEIGHT = 24;

// Fixed (not min) row height for every followers/following row, button or
// not - listRow used to just pad around its content, which meant a row with
// the (taller) action button ended up visibly bigger than a plain
// already-mutual row with no button (see FollowUserRow) sized only around
// its username text. A shared fixed height makes both converge on the same
// size instead of one merely clearing a floor the other already exceeds.
const ROW_HEIGHT = 46;

// A concrete pixel cap on the list ScrollView itself, not just listCard's
// own percentage maxHeight - needed for the list to actually cap its size
// and clip cleanly (confirmed via screenshot) rather than growing past its
// intended bound. Not, it turned out, what was blocking scrolling itself -
// see ExploreScreen's own comment on why its root is a View, not a
// Pressable, for that actual cause.
const LIST_SCROLL_MAX_HEIGHT = Dimensions.get("window").height * 0.55;

// UserBooksScreen's own slide-in/edge-swipe-to-dismiss mechanics - same
// constants/values as collection.tsx's SettingsScreen (see that file's own
// comments for the reasoning on each), duplicated rather than shared since
// there's no existing cross-screen module for them, same as every other
// swipe/reveal constant this file already carries its own copy of (eg.
// USERNAME_SWIPE_THRESHOLD above vs. BookRow's TITLE_SWIPE_THRESHOLD).
const SWIPE_EDGE_WIDTH = 24;
const COMPLETE_THRESHOLD = Dimensions.get("window").width * 0.38;
const SLIDE_OFF_DISTANCE = Dimensions.get("window").width + 100;
const SWIPE_VELOCITY_THRESHOLD = 950;
const SWIPE_SPRING = { damping: 28, stiffness: 260, mass: 0.6 };

// ExploreScreen's own feed reload (see handleFeedReload's own comment for
// the full choreography this paces out - triggered by re-tapping the
// already-focused explore tab).
const FEED_RELOAD_ROW_HEIGHT = 40;
const FEED_RELOAD_ROW_ANIM_MS = 220;
// However fast the actual fetch comes back, the loading row stays open at
// least this long once it's fully visible - a fetch that resolves near-
// instantly (comfortably possible against Neon) would otherwise flash the
// spinner open and shut so fast it barely reads as a reload at all.
const FEED_RELOAD_MIN_VISIBLE_MS = 500;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// UserBooksScreen's book list - same sort modes/labels/grouping logic as
// collection.tsx's own books tab (see that file's BOOK_SORT_MODES and
// orderedBooks/bookSections/categorySections), duplicated here for the same
// reason as the swipe constants above. Kept to exactly this subset - no
// "words" view at all (this screen never shows another user's vocabulary,
// only their books), so there's no SORT_MODES/viewMode toggle to mirror.
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
const NO_AUTHOR_LABEL = "n/a";
const NO_CATEGORY_LABEL = "n/a";

type BookSection = { header: string; items: CollectionBook[] };

// Sort key for the profile view's "author" mode - last name, not the raw
// "First Last" string, so a-z lands the way a library catalog would ("F.
// Scott Fitzgerald" files under F(itzgerald), not F(.)). Same simplified
// last-whitespace-token heuristic as collection.tsx's own
// authorLastNameKey (duplicated rather than shared - see this file's
// orderedBooks comment on why the whole sort block is already duplicated).
function authorLastNameKey(author: string): string {
  const parts = author.trim().split(/\s+/);
  return parts[parts.length - 1];
}

function monthGroup(addedAt: string): string {
  const d = new Date(addedAt);
  const month = d.toLocaleDateString("en-US", { month: "long" }).toLowerCase();
  const year = String(d.getFullYear() % 100).padStart(2, "0");
  return `${month} ${year}`;
}

function groupConsecutive(
  items: CollectionBook[],
  keyFor: (item: CollectionBook) => string,
): BookSection[] {
  const sections: BookSection[] = [];
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

function latestBookActivity(
  book: CollectionBook,
  reviews: BookReview[],
): string {
  let latest = book.addedAt;
  for (const r of reviews) {
    if (r.bookId === book.id && r.addedAt > latest) latest = r.addedAt;
  }
  return latest;
}

// Swipe left on the username to reveal it in full if it's clipped (same
// behavior as collection.tsx's BookRow). The trailing action button depends
// on which list this row is in: "following" rows get an explicit "unfollow"
// label (it's an action taken on someone else's behalf, worth spelling
// out); "followers" rows get a "follow back" button instead, unless you
// already follow that person back - then there's nothing left to do from
// this row, so no button at all.
function FollowUserRow({
  user,
  isLast,
  direction,
  onDelete,
  isFollowingBack,
  onFollowBack,
  onPressUsername,
}: {
  user: FollowUser;
  isLast: boolean;
  direction: "following" | "followers";
  onDelete: (username: string) => void;
  isFollowingBack?: boolean;
  onFollowBack?: (username: string) => void;
  onPressUsername: (username: string) => void;
}) {
  const theme = useTheme();
  const [containerWidth, setContainerWidth] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const titleTranslateX = useSharedValue(0);
  const estimatedTextWidth = useMemo(
    () => estimateUsernameWidth(user.username),
    [user.username],
  );

  const revealUsername = () => {
    if (revealed) return; // already mid-animation - ignore a swipe until it resets
    const overflow = estimatedTextWidth - containerWidth;
    if (overflow <= 0) return; // already fully visible - nothing to reveal
    const revealDuration =
      (overflow / USERNAME_REVEAL_PIXELS_PER_SECOND) * 1000;
    setRevealed(true);
    titleTranslateX.value = withSequence(
      withTiming(-overflow, {
        duration: revealDuration,
        easing: Easing.linear,
      }),
      withDelay(
        USERNAME_REVEAL_PAUSE,
        withTiming(
          0,
          { duration: USERNAME_HIDE_DURATION, easing: Easing.linear },
          (finished) => {
            if (finished) runOnJS(setRevealed)(false);
          },
        ),
      ),
    );
  };

  // Threshold-triggered, fire-and-forget - same as BookResultRow's own
  // title-reveal swipe, not a delete gesture, so no live-tracking/onUpdate
  // needed here.
  const pan = Gesture.Pan()
    .activeOffsetX([-10, 10])
    .failOffsetY([-10, 10])
    .onEnd((e) => {
      if (e.translationX < -USERNAME_SWIPE_THRESHOLD) {
        runOnJS(revealUsername)();
      }
    });

  const titleStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: titleTranslateX.value }],
  }));

  return (
    <View
      style={[
        styles.listRow,
        {
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: theme.separator,
        },
        isLast && {
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: theme.separator,
        },
      ]}
    >
      <GestureDetector gesture={pan}>
        <Pressable
          style={({ pressed }) => [
            styles.usernameClip,
            pressed && styles.usernamePressed,
          ]}
          onLayout={(e) => setContainerWidth(e.nativeEvent.layout.width)}
          onPress={() => onPressUsername(user.username)}
        >
          {revealed ? (
            <Animated.Text
              style={[
                styles.listRowText,
                styles.usernameRevealed,
                { color: theme.text },
                titleStyle,
              ]}
            >
              {user.username}
            </Animated.Text>
          ) : (
            <Text
              style={[styles.listRowText, { color: theme.text }]}
              numberOfLines={1}
            >
              {user.username}
            </Text>
          )}
        </Pressable>
      </GestureDetector>
      {direction === "following" ? (
        <PressableScale
          style={[
            styles.unfollowButton,
            { backgroundColor: theme.backgroundElement },
          ]}
          onPress={() => onDelete(user.username)}
        >
          <Text style={[styles.unfollowButtonText, { color: theme.text }]}>
            unfollow
          </Text>
        </PressableScale>
      ) : (
        !isFollowingBack && (
          <PressableScale
            style={[
              styles.unfollowButton,
              { backgroundColor: theme.backgroundElement },
            ]}
            onPress={() => onFollowBack?.(user.username)}
          >
            <Text style={[styles.unfollowButtonText, { color: theme.text }]}>
              follow back
            </Text>
          </PressableScale>
        )
      )}
    </View>
  );
}

// Same backdrop/centered-card shape as book-prompt.tsx's BookPrompt -
// dims the rest of the screen, dismissible by tapping outside, single
// TextInput + enter button rather than a search-as-you-type list since
// following requires the exact username (see api/follow+api.ts).
function FollowPrompt({
  onDismiss,
  onFollowed,
}: {
  onDismiss: () => void;
  onFollowed: () => void;
}) {
  const theme = useTheme();
  const { token } = useAuth();
  const [username, setUsername] = useState("");
  const [loading, setLoading] = useState(false);

  // Same shake used for a wrong password on auth-screen.tsx - no error
  // text, just a jiggle, for both an empty submit and a username that
  // doesn't exist.
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

  const submit = async () => {
    const trimmed = username.trim();
    if (!trimmed || loading) {
      if (!trimmed) shake();
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/follow`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ username: trimmed }),
      });
      if (!res.ok) {
        shake();
        return;
      }
      onFollowed();
      onDismiss();
    } catch (error) {
      console.error("[explore] follow failed", error);
      shake();
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.backdrop}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onDismiss} />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "position" : undefined}
        style={styles.avoidingWrap}
      >
        <Animated.View
          style={[
            styles.card,
            { backgroundColor: theme.background },
            shakeStyle,
          ]}
        >
          <View style={styles.followInputRow}>
            <TextInput
              style={[
                styles.followInput,
                {
                  backgroundColor: theme.backgroundElement,
                  color: theme.text,
                },
              ]}
              placeholder="username"
              placeholderTextColor={theme.textSecondary}
              value={username}
              onChangeText={setUsername}
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="none"
              autoComplete="off"
              returnKeyType="done"
              onSubmitEditing={submit}
              autoFocus
              editable={!loading}
            />
            <PressableScale
              style={styles.enterButton}
              onPress={submit}
              disabled={loading}
            >
              {loading ? (
                <ActivityIndicator size="small" color={theme.textSecondary} />
              ) : (
                <Ionicons
                  name="return-down-back"
                  size={18}
                  color={theme.text}
                />
              )}
            </PressableScale>
          </View>
        </Animated.View>
      </KeyboardAvoidingView>
    </View>
  );
}

// Same backdrop shape as FollowPrompt above, but a scrollable list instead
// of an input - min size is just whatever one row naturally takes (no
// forced floor beyond that), capped well short of the full screen
// (maxHeight:'70%' on the card itself, against the backdrop's full-screen
// bounds) so a heavily-followed account's list scrolls internally instead
// of taking over the whole screen. Tapping a row opens that user's books
// (onPressUsername, wired to ExploreScreen's own viewingUsername below -
// this modal dismisses itself first, see that callsite's own comment for
// why); swiping it right unfollows them (from the "following" list) or
// follows back (from the "followers" list, if not already mutual).
function FollowListPrompt({
  title,
  users,
  direction,
  onDismiss,
  onPressUsername,
}: {
  title: string;
  users: FollowUser[];
  direction: "following" | "followers";
  onDismiss: () => void;
  onPressUsername: (username: string) => void;
}) {
  const theme = useTheme();
  const { following, unfollow, followBack, refreshFollows } = useFollows();
  // Only meaningful for the "followers" list - which of them are already
  // mutual, so their row gets no button instead of "follow back".
  const followingUsernames = useMemo(
    () => new Set(following.map((u) => u.username)),
    [following],
  );

  // Refetches every time this modal opens - it's only mounted while open
  // (see ExploreScreen's `{openList && <FollowListPrompt .../>}`), so this
  // fires once per open, on top of FollowsProvider's own mount/background-
  // reset triggers and the explore tab's own focus-triggered refetch. Tab
  // focus alone doesn't cover "opened this modal without leaving the tab in
  // between," which is exactly the gap this closes.
  useEffect(() => {
    refreshFollows();
  }, [refreshFollows]);

  return (
    <View style={styles.backdrop}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onDismiss} />
      <View style={[styles.listCard, { backgroundColor: theme.background }]}>
        <Text style={[styles.listTitle, { color: theme.text }]}>{title}</Text>
        <ScrollView style={styles.listScroll} showsVerticalScrollIndicator={false}>
          {users.map((user, i) => (
            <FollowUserRow
              key={user.username}
              user={user}
              isLast={i === users.length - 1}
              direction={direction}
              onDelete={unfollow}
              isFollowingBack={followingUsernames.has(user.username)}
              onFollowBack={followBack}
              onPressUsername={onPressUsername}
            />
          ))}
        </ScrollView>
      </View>
    </View>
  );
}

// One entry's key in the local reaction-dedup cache (see
// lib/reaction-cache.ts) and the same pair reactions+api.ts calls
// targetKind/targetId - "review" maps to user_book_reviews.id, "started" to
// user_books.id.
function reactionKey(entry: FeedEntry): string {
  return `${entry.kind}:${entry.id}`;
}

// How long between two taps still counts as a double-tap.
const DOUBLE_TAP_WINDOW_MS = 300;

// Manual double-tap detection via a plain Pressable + timestamp comparison,
// not react-native-gesture-handler's own Gesture.Tap().numberOfTaps(2) -
// that native recognizer has a known failure mode where its internal timing
// state goes stale after the app sits backgrounded for a while, silently
// swallowing the next double-tap attempt entirely (it takes a second,
// "throwaway" double-tap to start recognizing again). A Pressable's onPress
// plus a ref'd last-tap timestamp doesn't have that native-recognizer state
// to desync - it's just comparing Date.now() on each JS-thread press event,
// so it can't get stuck. Coexists fine with a nested Pressable (eg.
// ExpandableReviewText's "see more"/"see less") since that's RN's own
// built-in responder nesting, not a second competing gesture system.
function useDoubleTap(onDoubleTap: (x: number, y: number) => void) {
  const lastTapAt = useRef(0);
  return useCallback(
    (e: { nativeEvent: { pageX: number; pageY: number } }) => {
      const now = Date.now();
      const { pageX, pageY } = e.nativeEvent;
      if (now - lastTapAt.current < DOUBLE_TAP_WINDOW_MS) {
        lastTapAt.current = 0;
        onDoubleTap(pageX, pageY);
      } else {
        lastTapAt.current = now;
      }
    },
    [onDoubleTap],
  );
}

// Feed card avatar size - same slot on both ReviewCard and
// StartedReadingCard, sized against activityContent's own minHeight below so
// the top/bottom halves of the username+book text next to it roughly split
// across the avatar's own height.
const FEED_AVATAR_SIZE = 40;

// "3h"/"5d" instead of a calendar date - this is the feed's own relative
// clock, deliberately not reusing expandable-review-text.tsx's
// formatReviewDate (that one's exact-date format is still correct for a
// past-review list, where "which day" matters more than "how long ago").
// Feed entries are already capped to the past 3 months server-side (see
// api/reviews+api.ts), so days alone comfortably covers the whole range -
// no separate week/month unit needed.
function formatRelativeTime(addedAt: string): string {
  const minutes = Math.floor((Date.now() - new Date(addedAt).getTime()) / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 0)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

// One entry in the explore feed - book reviews from everyone the current
// user follows, newest first (already sorted server-side, see
// api/reviews+api.ts). Reuses the exact same collapsible-text component
// RatingPrompt's own past-review list uses in collection.tsx.
//
// The double-tap-to-react Pressable wraps the whole card, review body
// included - see useDoubleTap's own comment for why this coexists fine
// with ExpandableReviewText's nested "see more"/"see less" Pressable.
// The username is its own nested Pressable (onPressUsername) for the same
// reason - RN's responder nesting means tapping it is captured there
// instead of bubbling to the outer double-tap Pressable, so it opens that
// user's books rather than firing a reaction.
function ReviewCard({
  entry,
  onReact,
  onPressUsername,
}: {
  entry: ReviewEntry;
  onReact: (x: number, y: number) => void;
  onPressUsername: (username: string) => void;
}) {
  const theme = useTheme();
  const handlePress = useDoubleTap((x, y) => onReact(x, y));
  return (
    <Pressable
      onPress={handlePress}
      style={[styles.reviewCard, { borderBottomColor: theme.separator }]}
    >
      <View style={styles.activityRow}>
        <Pressable onPress={() => onPressUsername(entry.username)}>
          <AvatarThumbnail uri={entry.avatar} size={FEED_AVATAR_SIZE} />
        </Pressable>
        <View style={styles.activityContent}>
          <View style={styles.activityTopRow}>
            <Pressable
              style={({ pressed }) => [
                styles.activityUsernameWrap,
                pressed && styles.usernamePressed,
              ]}
              onPress={() => onPressUsername(entry.username)}
            >
              <Text
                style={[styles.reviewUsername, { color: theme.text }]}
                numberOfLines={1}
              >
                {entry.username}
              </Text>
            </Pressable>
            <Text style={[styles.activityTime, { color: theme.textSecondary }]}>
              {formatRelativeTime(entry.addedAt)}
            </Text>
            <View style={styles.activitySpacer} />
            <View
              style={[
                styles.reviewScorePill,
                { backgroundColor: theme.backgroundElement },
              ]}
            >
              <Text style={[styles.reviewScore, { color: theme.text }]}>
                {entry.rating.toFixed(1)}
              </Text>
            </View>
          </View>
          <Text
            style={[styles.reviewBook, { color: theme.textSecondary }]}
            numberOfLines={1}
          >
            {entry.title}
            {entry.author ? ` — ${entry.author}` : ""}
          </Text>
        </View>
      </View>
      <ExpandableReviewText
        text={entry.review}
        textStyle={{ paddingLeft: 0, fontSize: 14, lineHeight: 19 }}
      />
    </Pressable>
  );
}

// The feed's other entry kind - one per book someone you follow has added,
// firing off of user_books.added_at rather than a review (see
// api/reviews+api.ts's comment on why that column doubles as "started
// reading"). Deliberately lighter-weight than ReviewCard - no score pill, no
// expandable body text - since there's no rating or review text to show,
// only the fact that it happened. Same username/date meta row as
// ReviewCard, for a consistent feed rhythm, followed by a plain second line
// instead of a book title row + expandable review body.
function StartedReadingCard({
  entry,
  onReact,
  onPressUsername,
}: {
  entry: StartedReadingEntry;
  onReact: (x: number, y: number) => void;
  onPressUsername: (username: string) => void;
}) {
  const theme = useTheme();
  const handlePress = useDoubleTap((x, y) => onReact(x, y));
  return (
    <Pressable
      onPress={handlePress}
      style={[styles.startedCard, { borderBottomColor: theme.separator }]}
    >
      <View style={styles.activityRow}>
        <Pressable onPress={() => onPressUsername(entry.username)}>
          <AvatarThumbnail uri={entry.avatar} size={FEED_AVATAR_SIZE} />
        </Pressable>
        <View style={styles.activityContent}>
          <View style={styles.activityTopRow}>
            <Pressable
              style={({ pressed }) => [
                styles.activityUsernameWrap,
                pressed && styles.usernamePressed,
              ]}
              onPress={() => onPressUsername(entry.username)}
            >
              <Text
                style={[styles.startedUsername, { color: theme.text }]}
                numberOfLines={1}
              >
                {entry.username}
              </Text>
            </Pressable>
            <Text style={[styles.activityTime, { color: theme.textSecondary }]}>
              {formatRelativeTime(entry.addedAt)}
            </Text>
          </View>
          <Text style={[styles.startedText, { color: theme.textSecondary }]}>
            {"started reading "}
            <Text style={[styles.startedBook, { color: theme.text }]}>
              {entry.title}
            </Text>
            {entry.author ? ` by ${entry.author}` : ""}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

// Plain, non-interactive header - same markup as collection.tsx's own
// CategoryHeaderRow, but always its categoryId===null branch (no
// swipe-to-delete) since nothing here is ever deletable.
function ReadOnlySectionHeader({ label }: { label: string }) {
  const theme = useTheme();
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

// Read-only counterpart of collection.tsx's own BookRow - same rating
// circle/title/author layout, but no swipe-to-delete, no drag-to-recategorize,
// and no swipe-to-reveal-title marquee (a decorative flourish, not something
// this view-only screen needs) - a plain numberOfLines=1 title is enough.
// onPress only ever does something when the book has at least one review
// (gated by the caller, not here - see UserBooksScreen's handlePressBook).
function ReadOnlyBookRow({
  book,
  reviews,
  borderColor,
  onPress,
}: {
  book: CollectionBook;
  reviews: BookReview[];
  borderColor: string;
  onPress: (book: CollectionBook) => void;
}) {
  const theme = useTheme();
  const averageRating = useMemo(
    () => averageBookRating(book.id, reviews),
    [reviews, book.id],
  );
  return (
    <Pressable
      style={({ pressed }) => [
        styles.bookRowPressable,
        { borderBottomColor: borderColor },
        pressed && { backgroundColor: theme.backgroundElement },
      ]}
      onPress={() => onPress(book)}
    >
      <View style={styles.bookRowContent}>
        <Text
          style={[styles.bookTitleTruncated, { color: theme.text }]}
          numberOfLines={1}
        >
          {book.title}
        </Text>
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
        style={[styles.ratingCircle, { backgroundColor: theme.backgroundElement }]}
      >
        <Text style={[styles.ratingCircleText, { color: theme.text }]}>
          {averageRating !== null ? averageRating.toFixed(1) : "?"}
        </Text>
      </View>
    </Pressable>
  );
}

// Read-only counterpart of collection.tsx's RatingPrompt, stripped to just
// the past-reviews summary it shows in its own resting/view-only state - no
// rating slider, no review text box, no save/"+" button, since viewing
// another user's book can never add a review to it. Only ever opened for a
// book with at least one review (see UserBooksScreen's handlePressBook), so
// there's no "reviewingAgain" empty-state branch to handle here either.
function UserBookReviewsModal({
  book,
  reviews,
  onDismiss,
}: {
  book: CollectionBook;
  reviews: BookReview[];
  onDismiss: () => void;
}) {
  const theme = useTheme();
  const pastReviews = useMemo(
    () => reviews.filter((r) => r.bookId === book.id),
    [reviews, book.id],
  );
  return (
    <View style={styles.colorModalBackdrop}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onDismiss} />
      <View
        style={[styles.ratingModalCard, { backgroundColor: theme.background }]}
      >
        <Text
          style={[styles.ratingModalTitle, { color: theme.text }]}
          numberOfLines={1}
        >
          {book.title}
        </Text>
        <ScrollView
          style={styles.reviewSummaryScroll}
          contentContainerStyle={styles.reviewSummaryContentFlush}
        >
          {pastReviews.map((r, i) => (
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
                  <Text
                    style={[styles.reviewSummaryScore, { color: theme.text }]}
                  >
                    {r.rating.toFixed(1)}
                  </Text>
                </View>
                <Text
                  style={[
                    styles.reviewSummaryDate,
                    { color: theme.textSecondary },
                  ]}
                >
                  on {formatReviewDate(r.addedAt)}
                </Text>
              </View>
              <ExpandableReviewText text={r.review} />
            </View>
          ))}
        </ScrollView>
      </View>
    </View>
  );
}

// The full-screen "view this user's books" overlay - opened by tapping a
// username anywhere on the explore page (see ExploreScreen's own
// viewingUsername state below). Same local-overlay-not-a-real-route shape,
// slide-in-on-mount + edge-swipe-to-dismiss mechanics, and back button as
// collection.tsx's own SettingsScreen (see that component's comments for the
// full mechanical rationale) - this is the "slides like the options screen"
// transition, just carrying a books list instead of settings options.
function UserBooksScreen({
  username,
  dismissSignal,
  onDismiss,
}: {
  username: string;
  // Bumped by ExploreScreen's own tabPress handler to request a dismiss
  // from outside this component (tapping "explore" while a profile is
  // already open) - see the effect below for why a plain boolean/prop
  // change on onDismiss itself wouldn't do, and why this needs to ignore
  // whatever value it was mounted with.
  dismissSignal: number;
  onDismiss: () => void;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { token } = useAuth();
  const [avatar, setAvatar] = useState<string | null>(null);
  const [books, setBooks] = useState<CollectionBook[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [bookReviews, setBookReviews] = useState<BookReview[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [bookSortMode, setBookSortMode] = useState<BookSortMode>("rating");
  const [bookSortDirection, setBookSortDirection] =
    useState<SortDirection>("desc");
  const [reviewBook, setReviewBook] = useState<CollectionBook | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(
      `${API_BASE_URL}/api/user-books?username=${encodeURIComponent(username)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
      .then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
      .then((data) => {
        if (cancelled) return;
        setAvatar(data.avatar ?? null);
        setBooks(Array.isArray(data.books) ? data.books : []);
        setCategories(Array.isArray(data.categories) ? data.categories : []);
        setBookReviews(
          Array.isArray(data.bookReviews) ? data.bookReviews : [],
        );
        setLoaded(true);
      })
      .catch((error) => {
        console.error("[explore] failed to load user's books", error);
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [username, token]);

  // Same switch/sort/group logic as collection.tsx's own orderedBooks -
  // see BOOK_SORT_MODES' own comment above for why it's duplicated here
  // rather than shared.
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
        return [...books].sort((a, b) => sign * a.title.localeCompare(b.title));
      case "rating": {
        const ratingFor = (b: CollectionBook) =>
          averageBookRating(b.id, bookReviews);
        const recentFor = (b: CollectionBook) =>
          latestBookActivity(b, bookReviews);
        return [...books].sort((a, b) => {
          const ra = ratingFor(a);
          const rb = ratingFor(b);
          if (ra === null && rb === null) {
            return recentFor(b).localeCompare(recentFor(a));
          }
          if (ra === null) return 1;
          if (rb === null) return -1;
          return sign * (ra - rb) || recentFor(b).localeCompare(recentFor(a));
        });
      }
      case "author": {
        const recentFor = (b: CollectionBook) =>
          latestBookActivity(b, bookReviews);
        const authorKeyFor = (b: CollectionBook) => b.author ?? NO_AUTHOR_LABEL;
        return [...books].sort((a, b) => {
          const aHasAuthor = a.author !== null;
          const bHasAuthor = b.author !== null;
          if (!aHasAuthor && !bHasAuthor) {
            return recentFor(b).localeCompare(recentFor(a));
          }
          if (!aHasAuthor) return 1;
          if (!bHasAuthor) return -1;
          return (
            sign *
              authorLastNameKey(authorKeyFor(a)).localeCompare(
                authorLastNameKey(authorKeyFor(b)),
              ) || recentFor(b).localeCompare(recentFor(a))
          );
        });
      }
      case "category":
        return books;
    }
  }, [books, bookReviews, bookSortMode, bookSortDirection]);

  const bookSections = useMemo(() => {
    switch (bookSortMode) {
      case "date":
        return groupConsecutive(orderedBooks, (b) =>
          monthGroup(latestBookActivity(b, bookReviews)),
        );
      case "author":
        return groupConsecutive(
          orderedBooks,
          (b) => b.author ?? NO_AUTHOR_LABEL,
        );
      default:
        return null;
    }
  }, [bookSortMode, orderedBooks, bookReviews]);

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

  // A book with zero reviews has nothing to show - tapping it does nothing,
  // per this screen's whole reason for being read-only.
  const handlePressBook = (book: CollectionBook) => {
    if (bookReviews.some((r) => r.bookId === book.id)) setReviewBook(book);
  };

  const translateX = useSharedValue(SLIDE_OFF_DISTANCE);
  const containerStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  useEffect(() => {
    translateX.value = withSpring(0, SWIPE_SPRING);
  }, []);

  // Same setTimeout(0)-deferred unmount as SettingsScreen's own dismiss -
  // see that component's comment for why calling onDismiss synchronously
  // from within the gesture's completion callback can crash native
  // gesture-handler on iOS.
  const deferredDismiss = () => setTimeout(onDismiss, 0);
  const dismiss = (velocityX = 0) => {
    translateX.value = withSpring(
      SLIDE_OFF_DISTANCE,
      { ...SWIPE_SPRING, velocity: velocityX },
      (finished) => {
        if (finished) runOnJS(deferredDismiss)();
      },
    );
  };

  // Tapping "explore" while this screen is already open goes through
  // dismissSignal (bumped by ExploreScreen's own tabPress handler) rather
  // than onDismiss being called directly, so it slides back out the same
  // way a swipe does instead of vanishing instantly. mountedDismissSignal
  // captures whatever value this instance was mounted with (which can
  // already be >0 - the counter isn't reset when this component unmounts,
  // it just keeps counting up across every profile ever opened) so this
  // only reacts to a genuinely new bump that happened *after* this screen
  // opened, not the stale value it was mounted with.
  const mountedDismissSignal = useRef(dismissSignal);
  useEffect(() => {
    if (dismissSignal !== mountedDismissSignal.current) dismiss();
  }, [dismissSignal]);

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

  const hasAnythingToShow =
    books.length > 0 || (bookSortMode === "category" && categories.length > 0);

  return (
    <Animated.View
      style={[
        styles.userBooksScreen,
        { backgroundColor: theme.background },
        containerStyle,
      ]}
    >
      <View
        style={[
          styles.userBooksHeader,
          { paddingTop: insets.top + Spacing.four, borderBottomColor: theme.separator },
        ]}
      >
        <AvatarThumbnail uri={avatar} size={40} />
        <Text
          style={[styles.userBooksUsername, { color: theme.text }]}
          numberOfLines={1}
        >
          {username}
        </Text>
      </View>

      {loaded && books.length > 0 && (
        <View
          style={[styles.sortRow, { borderBottomColor: theme.separator }]}
        >
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

      {!loaded ? (
        <View style={styles.empty}>
          <ActivityIndicator color={theme.textSecondary} />
        </View>
      ) : !hasAnythingToShow ? (
        <View style={styles.empty}>
          <Text style={[styles.emptyText, { color: theme.textSecondary }]}>
            no books yet
          </Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.userBooksListContent}>
          {categorySections
            ? categorySections.map((section) => (
                <View key={section.header}>
                  <ReadOnlySectionHeader label={section.header} />
                  {section.items.map((book) => (
                    <ReadOnlyBookRow
                      key={book.id}
                      book={book}
                      reviews={bookReviews}
                      borderColor={theme.separator}
                      onPress={handlePressBook}
                    />
                  ))}
                </View>
              ))
            : bookSections
              ? bookSections.map((section) => (
                  <View key={section.header}>
                    <ReadOnlySectionHeader label={section.header} />
                    {section.items.map((book) => (
                      <ReadOnlyBookRow
                        key={book.id}
                        book={book}
                        reviews={bookReviews}
                        borderColor={theme.separator}
                        onPress={handlePressBook}
                      />
                    ))}
                  </View>
                ))
              : orderedBooks.map((book) => (
                  <ReadOnlyBookRow
                    key={book.id}
                    book={book}
                    reviews={bookReviews}
                    borderColor={theme.separator}
                    onPress={handlePressBook}
                  />
                ))}
        </ScrollView>
      )}

      {/* Rendered after (so stacked on top of) the header/sort row/book
          list above, not before them like SettingsScreen's own edge strip -
          collection.tsx's book rows never span all the way to the true
          screen edge (they sit inside a padded card), but ReadOnlyBookRow
          here is edge-to-edge, so it would otherwise sit on top of this
          zone and eat every touch that starts on a row before the gesture
          ever sees it, including ones starting within SWIPE_EDGE_WIDTH of
          the left edge. Being last in the tree wins that stacking fight. */}
      <GestureDetector gesture={edgeSwipe}>
        <View style={styles.settingsEdge} />
      </GestureDetector>

      {reviewBook && (
        <UserBookReviewsModal
          book={reviewBook}
          reviews={bookReviews}
          onDismiss={() => setReviewBook(null)}
        />
      )}
    </Animated.View>
  );
}

export default function ExploreScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { token } = useAuth();
  const { followers, following, feed, refreshFollows, refreshFeed } =
    useFollows();
  const [addingFollow, setAddingFollow] = useState(false);
  const [openList, setOpenList] = useState<"followers" | "following" | null>(
    null,
  );
  // The "view this user's books" overlay (UserBooksScreen) - a local
  // overlay, not a real route, same as collection.tsx's own settingsVisible.
  // Opened from any username on this screen (feed cards, follow lists).
  const [viewingUsername, setViewingUsername] = useState<string | null>(null);
  // Bumped (never reset) by the tabPress handler below to ask
  // UserBooksScreen to slide itself back out, the same way its own
  // edge-swipe does, instead of just vanishing via setViewingUsername(null)
  // directly - see UserBooksScreen's own dismissSignal prop comment.
  const [dismissSignal, setDismissSignal] = useState(0);
  // Tapping a username inside the followers/following modal opens
  // UserBooksScreen on top of it - closing the modal first (rather than
  // stacking both overlays) keeps only one full-screen overlay open at a
  // time, same as every other overlay on this screen.
  const openUserBooks = useCallback((username: string) => {
    setOpenList(null);
    setViewingUsername(username);
  }, []);
  // Active flying hearts, keyed by a one-off id (not the post's own id -
  // reacting to the same post twice, however unlikely, needs two
  // independently-animating hearts, not one replacing the other). Removed
  // via FlyingHeart's own onDone once its animation finishes.
  const [hearts, setHearts] = useState<{ id: number; x: number; y: number }[]>(
    [],
  );
  const nextHeartId = useRef(0);

  // Double-tap on a card - the flying heart spawns on *every* double-tap,
  // reacted-before or not, so repeat double-taps still feel responsive.
  // Only the actual reaction logic (marking the local dedup cache, POSTing
  // to the server) is gated behind hasReacted, and only runs once per entry
  // until lib/reaction-cache.ts's own TTL prunes it back out - see that
  // file's comment for why dedup is local-only rather than server-side. Not
  // awaited - same fire-and-forget-but-log-only-on-failure shape as
  // follows.tsx's unfollow/removeFollower, since nothing on screen depends
  // on the response (the heart's already flying, the cache is already
  // marked).
  const handleReact = useCallback(
    async (entry: FeedEntry, x: number, y: number) => {
      const id = nextHeartId.current++;
      setHearts((prev) => [...prev, { id, x, y }]);
      const key = reactionKey(entry);
      if (await hasReacted(key)) return;
      await markReacted(key);
      fetch(`${API_BASE_URL}/api/reactions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ targetKind: entry.kind, targetId: entry.id }),
      }).catch((error) => {
        console.error("[explore] reaction failed", error);
      });
    },
    [token],
  );

  const removeHeart = useCallback((id: number) => {
    setHearts((prev) => prev.filter((h) => h.id !== id));
  }, []);

  // The feed's one explicit refresh trigger: re-tapping the already-focused
  // explore tab (below) - no pull-to-refresh gesture, by design (that was
  // tried and pulled back out - fighting a ScrollView's own native
  // scroll/bounce gesture from JS turned out to be a deep well of platform-
  // specific jank, none of it worth it for what a tab retap already covers).
  // The loading indicator itself is this plain, declaratively animated-
  // height row - growing/shrinking in the normal layout flow (not an
  // overlay) means it always pushes the feed below it down, never overlaps
  // or intersects any entry.
  const feedTabReloadingHeight = useSharedValue(0);
  const feedTabReloadingRowStyle = useAnimatedStyle(() => ({
    height: feedTabReloadingHeight.value,
  }));
  const feedScrollRef = useRef<ScrollView>(null);
  // Only meaningful for skipping the scroll-to-top+wait below when there's
  // nothing to scroll (ie. re-tapping the tab while already at the top).
  const feedScrollYRef = useRef(0);
  // Reentry guard, a ref (not state) since it's read synchronously at the
  // very start of the same tick a second trigger could fire in - re-tapping
  // the tab again mid-reload would otherwise stack a second copy of the
  // whole choreography on top of the first.
  const feedReloadingRef = useRef(false);

  // The full choreography, in order: (1) start the fetch immediately - no
  // reason to make the network wait on any animation; (2) scroll to the top
  // (if not already there) and start growing the reload row in the same
  // instant, rather than waiting for the scroll to visually finish first -
  // that wait used to leave a several-hundred-ms stretch of nothing
  // visibly happening between tapping and any loading indicator showing up,
  // which read as a stall/lag rather than a responsive reload. Growing the
  // row while the feed's still sliding up underneath it reads fine in
  // practice; (3) wait for the row's own grow animation to finish, so the
  // spinner is fully visible (not still expanding) before its own
  // minimum-visible timer starts; (4) wait for whichever is longer of the
  // fetch or that minimum - this is what stops a fast Neon response from
  // flashing the row open and shut almost instantly; (5) shrink the row
  // closed and wait for that to finish. The feed's own content has already
  // been swapped in by step 4 - by the time the row is closing,
  // refreshFeed() is done.
  const handleFeedReload = useCallback(async () => {
    if (feedReloadingRef.current) return;
    feedReloadingRef.current = true;
    try {
      const fetchPromise = refreshFeed();
      if (feedScrollYRef.current > 0) {
        feedScrollRef.current?.scrollTo({ y: 0, animated: true });
      }
      feedTabReloadingHeight.value = withTiming(FEED_RELOAD_ROW_HEIGHT, {
        duration: FEED_RELOAD_ROW_ANIM_MS,
      });
      await wait(FEED_RELOAD_ROW_ANIM_MS);
      await Promise.all([fetchPromise, wait(FEED_RELOAD_MIN_VISIBLE_MS)]);
      feedTabReloadingHeight.value = withTiming(0, {
        duration: FEED_RELOAD_ROW_ANIM_MS,
      });
      await wait(FEED_RELOAD_ROW_ANIM_MS);
    } finally {
      feedReloadingRef.current = false;
    }
  }, [refreshFeed, feedTabReloadingHeight]);

  // Only meaningful for skipping the scroll-to-top+wait in handleFeedReload
  // when there's nothing to scroll - no pull-to-refresh gesture anymore
  // (see handleFeedReload's own comment), reload is tab-retap only now.
  const handleFeedScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      feedScrollYRef.current = e.nativeEvent.contentOffset.y;
    },
    [],
  );

  // Follower/following counts (not the feed - see refreshFeed's own comment
  // in context/follows.tsx) refetch every time this tab gains focus
  // (switching back to it from another tab), on top of FollowsProvider's
  // own mount-time and background-reset-triggered fetches - catches "I
  // switched away, someone followed me, I switched back" without needing a
  // full app close, and without reshuffling the feed you were scrolled
  // through just from switching tabs and back.
  useFocusEffect(
    useCallback(() => {
      refreshFollows();
    }, [refreshFollows]),
  );

  // UserBooksScreen is a local overlay (viewingUsername), not a real route,
  // so React Navigation has no idea it's open - tapping the explore tab
  // while it's showing would otherwise just no-op, since this screen was
  // already focused. Closing it goes through dismissSignal (see
  // UserBooksScreen's own prop comment) so it slides back out the same way
  // its edge-swipe does, rather than collection.tsx's own settingsVisible
  // tabPress handler, which just closes its settings panel instantly with
  // no matching animation - see the bottom-tabs-specific navigation type
  // comment on that handler for why this one needs it too.
  //
  // Gated on isFocused() - tabPress fires for *any* press of this tab's own
  // button, including the one that switches into this screen from a
  // different tab (eg. collection -> explore), which isFocused() still
  // reports false for at the moment this fires (the switch hasn't landed
  // yet). Only reset when this tab was already the active one - re-tapping
  // explore while already on it - so switching back from another tab
  // returns you to the profile you had open, not the plain feed.
  //
  // Re-tapping while already on the plain feed (not viewing a profile) also
  // refreshes it - this is the feed's only refresh trigger (there's no pull-
  // to-refresh - see handleFeedReload's own comment); ordinary tab focus
  // deliberately doesn't refresh it (see refreshFeed's own comment in
  // context/follows.tsx). Gated on viewingUsername specifically so
  // re-tapping while a profile is open just dismisses it, same as before,
  // without also reshuffling the feed
  // underneath before you've even seen it again.
  //
  // Scrolls to the top and reloads via the same handleFeedReload
  // pull-to-refresh itself uses (see that handler's own comment) rather
  // than silently swapping the feed out from wherever you'd scrolled to.
  const navigation = useNavigation<BottomTabNavigationProp<ParamListBase>>();
  useEffect(() => {
    const unsubscribe = navigation.addListener("tabPress", () => {
      if (navigation.isFocused()) {
        if (viewingUsername === null) {
          handleFeedReload();
        } else {
          // Slides the profile back out instead of just unmounting it -
          // UserBooksScreen's own onDismiss (which actually clears
          // viewingUsername) only fires once that animation finishes, same
          // as its edge-swipe.
          setDismissSignal((n) => n + 1);
        }
      }
    });
    return unsubscribe;
  }, [navigation, viewingUsername, handleFeedReload]);

  // Plain View, not Pressable - unlike most other screens' root, this one
  // never actually needed tap-to-dismiss-keyboard (FollowPrompt's TextInput
  // already dismisses via its own return key/backdrop tap). A Pressable
  // here was a real bug: a Pressable ancestor claims the touch responder
  // for its own press-state tracking, which starved FollowListPrompt's
  // nested ScrollView of the drag gesture it needed to scroll - same root
  // cause collection.tsx's AddBookPrompt card already has a comment about,
  // for the exact same reason.
  //
  // The reaction overlay is a sibling of the padded content below, not a
  // child of it - the padded View has paddingTop: insets.top + Spacing.four,
  // and an absolutely-positioned child measures from that padding edge, not
  // the true screen origin. Since each FlyingHeart positions itself from
  // event.absoluteX/absoluteY (real screen coordinates), the overlay has to
  // sit in an unpadded ancestor or every heart would render offset downward
  // by that padding, away from the finger that actually tapped it.
  return (
    <View style={styles.outer}>
      <View
        style={[
          styles.container,
          {
            backgroundColor: theme.background,
            paddingTop: insets.top + Spacing.four,
            paddingBottom: Spacing.three,
          },
        ]}
      >
        <Text style={[styles.title, { color: theme.text }]}>explore</Text>

        {/* Own row, not inside the ScrollView below - see handleFeedReload's
            own comment for why every trigger (tab retap, and the iOS pull
            gesture below) shares this instead of a native spinner. Always
            mounted (animates height 0<->FEED_RELOAD_ROW_HEIGHT rather than
            conditionally rendering) so growing/shrinking is an actual
            animation, not an instant pop - overflow:hidden keeps the
            indicator clipped away while collapsed. */}
        <Animated.View
          style={[styles.feedTabReloadingRow, feedTabReloadingRowStyle]}
        >
          <ActivityIndicator size="small" color={theme.textSecondary} />
        </Animated.View>

        <ScrollView
          ref={feedScrollRef}
          style={styles.feed}
          contentContainerStyle={styles.feedContent}
          showsVerticalScrollIndicator={false}
          onScroll={handleFeedScroll}
          scrollEventThrottle={16}
        >
          {feed.length > 0 ? (
            feed.map((entry) =>
              entry.kind === "review" ? (
                <ReviewCard
                  key={`review-${entry.id}`}
                  entry={entry}
                  onReact={(x, y) => handleReact(entry, x, y)}
                  onPressUsername={openUserBooks}
                />
              ) : (
                <StartedReadingCard
                  key={`started-${entry.id}`}
                  entry={entry}
                  onReact={(x, y) => handleReact(entry, x, y)}
                  onPressUsername={openUserBooks}
                />
              ),
            )
          ) : (
            <Text style={[styles.feedEmpty, { color: theme.textSecondary }]}>
              follow your friends and share your reading progress!
            </Text>
          )}
        </ScrollView>

        <View style={styles.footer}>
          <Pressable
            onPress={() => following.length > 0 && setOpenList("following")}
            disabled={following.length === 0}
          >
            <Text style={[styles.countText, { color: theme.text }]}>
              {following.length} following
            </Text>
          </Pressable>
          <View
            style={[styles.divider, { backgroundColor: theme.separator }]}
          />
          <Pressable
            onPress={() => followers.length > 0 && setOpenList("followers")}
            disabled={followers.length === 0}
          >
            <Text style={[styles.countText, { color: theme.text }]}>
              {followers.length} followers
            </Text>
          </Pressable>
          <View
            style={[styles.divider, { backgroundColor: theme.separator }]}
          />
          <PressableScale
            style={[
              styles.addButton,
              { backgroundColor: theme.backgroundElement },
            ]}
            onPress={() => setAddingFollow(true)}
          >
            <Ionicons name="add" size={18} color={theme.text} />
          </PressableScale>
        </View>

        {addingFollow && (
          <FollowPrompt
            onDismiss={() => setAddingFollow(false)}
            onFollowed={refreshFollows}
          />
        )}

        {openList && (
          <FollowListPrompt
            title={openList}
            users={openList === "followers" ? followers : following}
            direction={openList}
            onDismiss={() => setOpenList(null)}
            onPressUsername={openUserBooks}
          />
        )}

        {viewingUsername && (
          <UserBooksScreen
            username={viewingUsername}
            dismissSignal={dismissSignal}
            onDismiss={() => setViewingUsername(null)}
          />
        )}
      </View>

      <View style={styles.reactionOverlay} pointerEvents="none">
        {hearts.map((h) => (
          <FlyingHeart
            key={h.id}
            x={h.x}
            y={h.y}
            onDone={() => removeHeart(h.id)}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Unpadded ancestor of both the real (padded) screen content and the
  // reaction overlay - see ExploreScreen's own comment on why the overlay
  // can't be a child of the padded container below.
  outer: {
    flex: 1,
  },
  container: {
    flex: 1,
  },
  reactionOverlay: {
    ...StyleSheet.absoluteFillObject,
  },
  // Matches feedContent's own paddingHorizontal (Spacing.three) so "explore"
  // lines up with the username column in the feed below it, rather than the
  // wider Spacing.five the footer still uses.
  title: {
    fontSize: 28,
    fontFamily: Fonts?.mono,
    fontWeight: "600",
    paddingHorizontal: Spacing.three,
  },
  // Own slot between the title and the feed, not overlaid on top of either -
  // animates height (see feedTabReloadingRowStyle) between 0 and
  // FEED_RELOAD_ROW_HEIGHT rather than a fixed height, so it grows/shrinks
  // in place instead of popping. overflow:hidden keeps the ActivityIndicator
  // clipped away while collapsed instead of poking out above its 0-height
  // box.
  feedTabReloadingRow: {
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  // flex:1 is what actually pins the footer to the bottom - it fills all
  // the space between the fixed-height title above and footer below,
  // scrolling internally once the feed is taller than what's left.
  feed: {
    flex: 1,
    marginTop: Spacing.four,
  },
  // Narrower horizontal inset than the footer below it - review rows hug
  // the screen edges more closely than the footer's counts/add button.
  feedContent: {
    gap: Spacing.two,
    paddingBottom: Spacing.four,
    paddingHorizontal: Spacing.three,
  },
  feedEmpty: {
    fontSize: 14,
    fontFamily: Fonts?.mono,
    textAlign: "center",
    marginTop: Spacing.six,
  },
  reviewCard: {
    gap: Spacing.one,
    paddingBottom: Spacing.two,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  // Shared by both ReviewCard and StartedReadingCard - avatar on the left,
  // a two-line column on the right (activityTopRow up top, the book/
  // "started reading" line at the bottom). activityContent's own minHeight
  // matches FEED_AVATAR_SIZE so those two lines actually split across the
  // avatar's height instead of clumping toward its top.
  activityRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: Spacing.two,
  },
  activityContent: {
    flex: 1,
    minHeight: FEED_AVATAR_SIZE,
    justifyContent: "space-between",
    gap: Spacing.half,
  },
  activityTopRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.two,
  },
  activityTime: {
    fontSize: 13,
    fontFamily: Fonts?.mono,
  },
  activitySpacer: {
    flex: 1,
  },
  reviewUsername: {
    fontSize: 15,
    fontFamily: Fonts?.mono,
    fontWeight: "600",
    flexShrink: 1,
  },
  reviewScorePill: {
    paddingHorizontal: Spacing.two,
    paddingVertical: 2,
    borderRadius: 999,
  },
  reviewScore: {
    fontSize: 14,
    fontWeight: "700",
    fontFamily: Fonts?.mono,
  },
  reviewBook: {
    fontSize: 13,
    fontFamily: Fonts?.mono,
  },
  // Lighter-weight than reviewCard - just a meta row + one line, no score
  // pill or expandable body, and less bottom padding to match its lower
  // "weight" in the feed.
  startedCard: {
    gap: Spacing.one,
    paddingBottom: Spacing.three,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  startedUsername: {
    fontSize: 15,
    fontFamily: Fonts?.mono,
    fontWeight: "600",
    flexShrink: 1,
  },
  startedText: {
    fontSize: 13,
    fontFamily: Fonts?.mono,
  },
  startedBook: {
    fontStyle: "italic",
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: Spacing.three,
    paddingHorizontal: Spacing.five,
  },
  countText: {
    fontSize: 16,
    fontFamily: Fonts?.mono,
  },
  // Taller than the text next to it, vertically centered in the row (via
  // footer's own alignItems:center) alongside the counts and button.
  divider: {
    width: 1.5,
    height: 26,
  },
  addButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  // Same backdrop/card shape as book-prompt.tsx's BookPrompt.
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 20,
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
    paddingHorizontal: Spacing.four,
    gap: Spacing.three,
  },
  followInputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.one,
  },
  followInput: {
    flex: 1,
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two + Spacing.half,
    fontSize: 16,
  },
  enterButton: {
    width: 44,
    height: 44,
    borderRadius: Spacing.two,
    alignItems: "center",
    justifyContent: "center",
  },
  // No fixed height - sizes to its content (naturally a "min size" of just
  // one row for a single-user list), capped at 70% of the screen against
  // the backdrop's full-screen bounds so a long list scrolls instead of
  // growing past that.
  listCard: {
    width: "100%",
    maxHeight: "70%",
    borderRadius: Spacing.four,
    paddingVertical: Spacing.four,
    paddingHorizontal: Spacing.four,
    gap: Spacing.three,
  },
  // Concrete pixel maxHeight (LIST_SCROLL_MAX_HEIGHT), not a percentage or
  // flexShrink - this is what actually gives the ScrollView a bounded
  // viewport to compute as scrollable, confirmed by ruling out the swipe
  // gesture via isolation test first.
  listScroll: {
    maxHeight: LIST_SCROLL_MAX_HEIGHT,
  },
  listTitle: {
    fontSize: 16,
    fontFamily: Fonts?.mono,
    fontWeight: "600",
    textAlign: "center",
  },
  // paddingRight gives the trailing button clearance from the ScrollView's
  // own right edge, which is where the native scroll indicator draws -
  // without it the indicator sits flush against (and visually intersects)
  // the button.
  listRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.two,
    height: ROW_HEIGHT,
    paddingRight: Spacing.two,
  },
  listRowText: {
    fontSize: 14,
    fontFamily: Fonts?.mono,
  },
  // Fixed height + overflow:hidden is what actually crops the username at
  // rest, and gives onLayout a real width to measure the reveal/clip
  // against - flex:1 so it takes up the row's width other than the minus
  // button next to it.
  usernameClip: {
    flex: 1,
    height: 18,
    overflow: "hidden",
  },
  // Shared dim-on-press feedback for every tappable username on this screen
  // (feed cards + this list) - the tap still opens that user's books same as
  // before, this just makes the tap itself read as a real press instead of
  // an instant, feedback-less jump to the next screen.
  usernamePressed: {
    opacity: 0.5,
  },
  // The feed cards' username Pressable needs flexShrink:1 itself, not just
  // the Text inside it - RN's flex items default to flexShrink:0, so
  // without this the Pressable grew to fit the username's full untruncated
  // width regardless of the inner Text's own numberOfLines/flexShrink,
  // pushing the relative-time and rating pill off the edge of the card
  // instead of the username actually ellipsizing at a sane width.
  activityUsernameWrap: {
    flexShrink: 1,
  },
  // Only used for the revealed (full-text) state - explicit, generous,
  // fixed width so it never wraps and simply extends past usernameClip's
  // edge for the swipe/translateX to reveal.
  usernameRevealed: {
    width: USERNAME_BOX_WIDTH,
  },
  // Row-trailing slot, sized to its text label rather than a fixed circle -
  // shared by the "following" list's unfollow button and the "followers"
  // list's follow-back button (28 tall either way, so row height doesn't
  // shift between the two lists).
  unfollowButton: {
    height: ROW_ACTION_HEIGHT,
    borderRadius: 14,
    paddingHorizontal: Spacing.two,
    alignItems: "center",
    justifyContent: "center",
  },
  unfollowButtonText: {
    fontSize: 12,
    fontFamily: Fonts?.mono,
  },
  // UserBooksScreen and its children below - same shapes as
  // collection.tsx's SettingsScreen/BookRow/RatingPrompt styles (see each
  // component's own comment above for which one it mirrors).
  userBooksScreen: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 10,
  },
  settingsEdge: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: SWIPE_EDGE_WIDTH,
  },
  userBooksHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.two,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  userBooksUsername: {
    flex: 1,
    fontSize: 22,
    fontFamily: Fonts?.mono,
    fontWeight: "600",
  },
  sortRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.two,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sortButton: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
    borderRadius: Spacing.four,
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
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyText: {
    fontSize: 20,
    fontFamily: Fonts?.mono,
  },
  userBooksListContent: {
    paddingBottom: Spacing.four,
  },
  sectionHeaderRow: {
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.two,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sectionHeader: {
    fontSize: 12,
    fontWeight: "700",
    fontFamily: Fonts?.mono,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  bookRowPressable: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 56,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
    gap: Spacing.two,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  bookRowContent: {
    flex: 1,
    gap: Spacing.half,
  },
  bookTitleTruncated: {
    fontSize: 18,
    fontFamily: Fonts?.mono,
  },
  bookAuthor: {
    fontSize: 13,
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
  // Same backdrop/card shape as collection.tsx's own colorModalBackdrop/
  // ratingModalCard.
  colorModalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.4)",
    paddingHorizontal: Spacing.five + Spacing.one,
  },
  ratingModalCard: {
    width: "100%",
    borderRadius: Spacing.four,
    paddingVertical: Spacing.four,
    paddingHorizontal: Spacing.four,
    gap: Spacing.four,
  },
  ratingModalTitle: {
    fontSize: 18,
    fontWeight: "600",
    fontFamily: Fonts?.mono,
  },
  reviewSummaryScroll: {
    maxHeight: 520,
  },
  reviewSummaryContentFlush: {
    paddingRight: Spacing.three,
    flexGrow: 1,
    justifyContent: "center",
  },
  pastReviewEntry: {
    gap: Spacing.one,
    marginBottom: Spacing.three,
  },
  reviewSummaryMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.two,
  },
  reviewSummaryScorePill: {
    paddingHorizontal: Spacing.two,
    paddingVertical: 2,
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
});
