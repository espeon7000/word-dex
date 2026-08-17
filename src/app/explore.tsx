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
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
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

import {
  ExpandableReviewText,
  formatReviewDate,
} from "@/components/expandable-review-text";
import { FlyingHeart } from "@/components/flying-heart";
import { PressableScale } from "@/components/pressable-scale";
import { API_BASE_URL } from "@/constants/api";
import { Fonts, Spacing } from "@/constants/theme";
import { useAuth } from "@/context/auth";
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

// A concrete pixel cap on the list ScrollView itself, not just listCard's
// own percentage maxHeight - needed for the list to actually cap its size
// and clip cleanly (confirmed via screenshot) rather than growing past its
// intended bound. Not, it turned out, what was blocking scrolling itself -
// see ExploreScreen's own comment on why its root is a View, not a
// Pressable, for that actual cause.
const LIST_SCROLL_MAX_HEIGHT = Dimensions.get("window").height * 0.55;

// Swipe right to unfollow (from the "following" list) or remove a follower
// (from the "followers" list) - onDelete already knows which, passed down
// as either FollowsContext's unfollow or removeFollower. Swipe left on the
// username to reveal it in full if it's clipped (same behavior as
// collection.tsx's BookRow); tap the minus button to actually remove them,
// no swipe-to-delete.
function FollowUserRow({
  user,
  isLast,
  onDelete,
}: {
  user: FollowUser;
  isLast: boolean;
  onDelete: (username: string) => void;
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
        <View
          style={styles.usernameClip}
          onLayout={(e) => setContainerWidth(e.nativeEvent.layout.width)}
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
        </View>
      </GestureDetector>
      <PressableScale
        style={[
          styles.minusButton,
          { backgroundColor: theme.backgroundElement },
        ]}
        onPress={() => onDelete(user.username)}
      >
        <Ionicons name="remove" size={16} color={theme.text} />
      </PressableScale>
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
// of taking over the whole screen. Tapping a row does nothing (no profile
// page yet); swiping it right unfollows/removes them.
function FollowListPrompt({
  title,
  users,
  direction,
  onDismiss,
}: {
  title: string;
  users: FollowUser[];
  direction: "following" | "followers";
  onDismiss: () => void;
}) {
  const theme = useTheme();
  const { unfollow, removeFollower, refreshFollows } = useFollows();
  const onDelete = direction === "following" ? unfollow : removeFollower;

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
        <ScrollView style={styles.listScroll}>
          {users.map((user, i) => (
            <FollowUserRow
              key={user.username}
              user={user}
              isLast={i === users.length - 1}
              onDelete={onDelete}
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
// so it can't get stuck. Coexists fine with a nested Text onPress (eg.
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

// One entry in the explore feed - book reviews from everyone the current
// user follows, newest first (already sorted server-side, see
// api/reviews+api.ts). Reuses the exact same collapsible-text component
// RatingPrompt's own past-review list uses in collection.tsx.
//
// The double-tap-to-react Pressable wraps the whole card, review body
// included - see useDoubleTap's own comment for why this coexists fine
// with ExpandableReviewText's nested "see more"/"see less" Text onPress.
function ReviewCard({
  entry,
  onReact,
}: {
  entry: ReviewEntry;
  onReact: (x: number, y: number) => void;
}) {
  const theme = useTheme();
  const handlePress = useDoubleTap((x, y) => onReact(x, y));
  return (
    <Pressable
      onPress={handlePress}
      style={[styles.reviewCard, { borderBottomColor: theme.separator }]}
    >
      <View style={styles.reviewMeta}>
        <Text
          style={[styles.reviewUsername, { color: theme.text }]}
          numberOfLines={1}
        >
          {entry.username}
        </Text>
        <Text style={[styles.reviewDate, { color: theme.textSecondary }]}>
          {formatReviewDate(entry.addedAt)}
        </Text>
        <View style={styles.reviewMetaSpacer} />
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
      <ExpandableReviewText text={entry.review} textStyle={{ paddingLeft: 0 }} />
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
}: {
  entry: StartedReadingEntry;
  onReact: (x: number, y: number) => void;
}) {
  const theme = useTheme();
  const handlePress = useDoubleTap((x, y) => onReact(x, y));
  return (
    <Pressable
      onPress={handlePress}
      style={[styles.startedCard, { borderBottomColor: theme.separator }]}
    >
      <View style={styles.startedMeta}>
        <Text
          style={[styles.startedUsername, { color: theme.text }]}
          numberOfLines={1}
        >
          {entry.username}
        </Text>
        <Text style={[styles.startedDate, { color: theme.textSecondary }]}>
          {formatReviewDate(entry.addedAt)}
        </Text>
      </View>
      <Text style={[styles.startedText, { color: theme.textSecondary }]}>
        {"started reading "}
        <Text style={[styles.startedBook, { color: theme.text }]}>
          {entry.title}
        </Text>
        {entry.author ? ` by ${entry.author}` : ""}
      </Text>
    </Pressable>
  );
}

export default function ExploreScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { token } = useAuth();
  const { followers, following, feed, refreshFollows } = useFollows();
  const [addingFollow, setAddingFollow] = useState(false);
  const [openList, setOpenList] = useState<"followers" | "following" | null>(
    null,
  );
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

  // Refetches every time this tab gains focus (switching back to it from
  // another tab), on top of FollowsProvider's own mount-time and
  // background-reset-triggered fetches - catches "I switched away, someone
  // followed me, I switched back" without needing a full app close.
  useFocusEffect(
    useCallback(() => {
      refreshFollows();
    }, [refreshFollows]),
  );

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

        <ScrollView
          style={styles.feed}
          contentContainerStyle={styles.feedContent}
          showsVerticalScrollIndicator={false}
        >
          {feed.length > 0 ? (
            feed.map((entry) =>
              entry.kind === "review" ? (
                <ReviewCard
                  key={`review-${entry.id}`}
                  entry={entry}
                  onReact={(x, y) => handleReact(entry, x, y)}
                />
              ) : (
                <StartedReadingCard
                  key={`started-${entry.id}`}
                  entry={entry}
                  onReact={(x, y) => handleReact(entry, x, y)}
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
  title: {
    fontSize: 28,
    fontFamily: Fonts?.mono,
    fontWeight: "600",
    paddingHorizontal: Spacing.five,
  },
  // flex:1 is what actually pins the footer to the bottom - it fills all
  // the space between the fixed-height title above and footer below,
  // scrolling internally once the feed is taller than what's left.
  feed: {
    flex: 1,
    marginTop: Spacing.four,
  },
  // Narrower horizontal inset than the title/footer above and below it -
  // review rows hug the screen edges more closely than the rest of the
  // page.
  feedContent: {
    gap: Spacing.four,
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
  reviewMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.two,
  },
  reviewUsername: {
    fontSize: 15,
    fontFamily: Fonts?.mono,
    fontWeight: "600",
    flexShrink: 1,
  },
  reviewDate: {
    fontSize: 13,
    fontFamily: Fonts?.mono,
  },
  reviewMetaSpacer: {
    flex: 1,
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
  startedMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.two,
  },
  startedUsername: {
    fontSize: 15,
    fontFamily: Fonts?.mono,
    fontWeight: "600",
    flexShrink: 1,
  },
  startedDate: {
    fontSize: 13,
    fontFamily: Fonts?.mono,
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
  listRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.two,
    paddingVertical: Spacing.two + Spacing.one,
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
  // Only used for the revealed (full-text) state - explicit, generous,
  // fixed width so it never wraps and simply extends past usernameClip's
  // edge for the swipe/translateX to reveal.
  usernameRevealed: {
    width: USERNAME_BOX_WIDTH,
  },
  minusButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
});
