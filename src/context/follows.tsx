import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import { API_BASE_URL } from "@/constants/api";
import { useCollection } from "@/context/collection";
import { reportError } from "@/lib/report-error";

export type FollowUser = { username: string; followedAt: string };

export type ReviewEntry = {
  kind: "review";
  id: string;
  rating: number;
  review: string;
  addedAt: string;
  username: string;
  avatar: string | null;
  title: string;
  author: string | null;
};

// A book's own added_at doubling as its "started reading" moment - there's
// no separate started/finished status column, see api/reviews+api.ts.
export type StartedReadingEntry = {
  kind: "started";
  id: string;
  addedAt: string;
  username: string;
  avatar: string | null;
  title: string;
  author: string | null;
};

export type FeedEntry = ReviewEntry | StartedReadingEntry;

type FollowsContextValue = {
  followers: FollowUser[];
  following: FollowUser[];
  feed: FeedEntry[];
  refreshFollows: () => Promise<void>;
  refreshFeed: () => Promise<void>;
  unfollow: (username: string) => void;
  removeFollower: (username: string) => void;
  followBack: (username: string) => void;
};

const FollowsContext = createContext<FollowsContextValue | null>(null);

// Fetched once here, at the same level as CollectionProvider (see
// _layout.tsx), rather than lazily inside the explore screen itself - the
// explore tab is lazy-mounted (expo-router's default tab behavior), so a
// screen-owned fetch only started the moment it was first visited, flashing
// 0 before the real counts landed. Provider-level fetching means this is
// already in flight (often already resolved) by the time anyone actually
// taps into the explore tab.
export function FollowsProvider({
  token,
  children,
}: {
  token: string;
  children: React.ReactNode;
}) {
  const [followers, setFollowers] = useState<FollowUser[]>([]);
  const [following, setFollowing] = useState<FollowUser[]>([]);
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const { resetGeneration } = useCollection();

  // Split from the feed on purpose - explore.tsx's own tab-focus effect
  // wants to keep follower/following counts fresh on every visit without
  // also silently re-fetching (and reordering/resetting the scroll position
  // under) the feed every time you switch back to the tab. The feed instead
  // only refreshes on its own two explicit triggers - see refreshFeed below.
  const refreshFollows = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/follow`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setFollowers(Array.isArray(data.followers) ? data.followers : []);
        setFollowing(Array.isArray(data.following) ? data.following : []);
      }
    } catch (error) {
      reportError("[follows] failed to load followers/following", error);
    }
  }, [token]);

  // Deliberately explicit-trigger-only (mount, background reset - see
  // below - and explore.tsx's own re-tap-the-tab/pull-to-refresh) rather
  // than tied to ordinary tab focus, so switching to another tab and back
  // doesn't reshuffle whatever you were scrolled through.
  const refreshFeed = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/reviews`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setFeed(Array.isArray(data.feed) ? data.feed : []);
      }
    } catch (error) {
      reportError("[follows] failed to load feed", error);
    }
  }, [token]);

  useEffect(() => {
    refreshFollows();
    refreshFeed();
  }, [refreshFollows, refreshFeed]);

  // Also refetch whenever the app's been backgrounded long enough to count
  // as freshly reopened (5 minutes - see BACKGROUND_RESET_MS in
  // context/collection.tsx) - someone could've followed/unfollowed you (or
  // posted something new) while your phone was locked. Both follows *and*
  // the feed refresh here, unlike ordinary tab focus - collection.tsx's own
  // AppState listener already force-navigates away to the discover tab on
  // this same trigger, so there's no in-place scroll position on explore to
  // preserve, and it's a rare enough event that a fresh feed is worth more
  // than avoiding a reshuffle nobody's looking at yet.
  // Skipped on the very first render (resetGeneration starts at 0, and the
  // mount effect above already covers the initial fetch).
  const isFirstResetRef = useRef(true);
  useEffect(() => {
    if (isFirstResetRef.current) {
      isFirstResetRef.current = false;
      return;
    }
    refreshFollows();
    refreshFeed();
  }, [resetGeneration, refreshFollows, refreshFeed]);

  // Optimistic, same pattern as CollectionProvider's own remove()/
  // removeBook() - the local list drops the row immediately (matching the
  // swipe animation's own "slide off and it's gone" feel) while the delete
  // fires in the background. No rollback on failure: a follow relationship
  // is low-stakes enough, and the next refreshFollows() call (tab focus,
  // background reset) would just re-add it if the request somehow didn't
  // land.
  const deleteFollow = useCallback(
    (username: string, direction: "following" | "followers") => {
      if (direction === "following") {
        setFollowing((prev) => prev.filter((u) => u.username !== username));
        // The feed is server-filtered to only people you follow, but that
        // filter only gets re-applied on the next refreshFeed() call - since
        // that's no longer tied to ordinary tab focus (see refreshFeed's own
        // comment), this local filter is what actually keeps an unfollowed
        // person's posts from lingering in the feed until you next reload
        // it (re-tap the tab, pull-to-refresh, or a background reset).
        setFeed((prev) => prev.filter((e) => e.username !== username));
      } else {
        setFollowers((prev) => prev.filter((u) => u.username !== username));
      }
      fetch(`${API_BASE_URL}/api/follow`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ username, direction }),
      })
        .then((res) => {
          if (!res.ok) {
            reportError(
              `[follows] server rejected removing ${direction}`,
              res.status,
            );
          }
        })
        .catch((error) => {
          reportError(`[follows] failed to remove ${direction}`, error);
        });
    },
    [token],
  );

  const unfollow = useCallback(
    (username: string) => deleteFollow(username, "following"),
    [deleteFollow],
  );
  const removeFollower = useCallback(
    (username: string) => deleteFollow(username, "followers"),
    [deleteFollow],
  );

  // Optimistic add, mirror of deleteFollow above - the row switches from
  // "follow back" to no button immediately, POST fires in the background. No
  // rollback for the same low-stakes reasoning as deleteFollow; a failed
  // request just gets corrected on the next refetch.
  const followBack = useCallback(
    (username: string) => {
      setFollowing((prev) =>
        prev.some((u) => u.username === username)
          ? prev
          : [...prev, { username, followedAt: new Date().toISOString() }],
      );
      fetch(`${API_BASE_URL}/api/follow`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ username }),
      })
        .then((res) => {
          if (!res.ok) {
            reportError("[follows] server rejected follow back", res.status);
          }
        })
        .catch((error) => {
          reportError("[follows] failed to follow back", error);
        });
    },
    [token],
  );

  return (
    <FollowsContext
      value={{
        followers,
        following,
        feed,
        refreshFollows,
        refreshFeed,
        unfollow,
        removeFollower,
        followBack,
      }}
    >
      {children}
    </FollowsContext>
  );
}

export function useFollows() {
  const ctx = useContext(FollowsContext);
  if (!ctx) throw new Error("useFollows must be used within FollowsProvider");
  return ctx;
}
