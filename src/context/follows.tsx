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

export type FollowUser = { username: string; followedAt: string };

export type ReviewEntry = {
  kind: "review";
  id: string;
  rating: number;
  review: string;
  addedAt: string;
  username: string;
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
  title: string;
  author: string | null;
};

export type FeedEntry = ReviewEntry | StartedReadingEntry;

type FollowsContextValue = {
  followers: FollowUser[];
  following: FollowUser[];
  feed: FeedEntry[];
  refreshFollows: () => Promise<void>;
  unfollow: (username: string) => void;
  removeFollower: (username: string) => void;
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

  // Fetches follow lists and the activity feed together - same triggers
  // apply to both (mount, background reset, explore tab focus), so there's
  // no reason to split them into two separately-triggered fetches.
  const refreshFollows = useCallback(async () => {
    try {
      const [followsRes, feedRes] = await Promise.all([
        fetch(`${API_BASE_URL}/api/follow`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch(`${API_BASE_URL}/api/reviews`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      ]);
      if (followsRes.ok) {
        const data = await followsRes.json();
        setFollowers(Array.isArray(data.followers) ? data.followers : []);
        setFollowing(Array.isArray(data.following) ? data.following : []);
      }
      if (feedRes.ok) {
        const data = await feedRes.json();
        setFeed(Array.isArray(data.feed) ? data.feed : []);
      }
    } catch (error) {
      console.error("[follows] failed to load followers/following/feed", error);
    }
  }, [token]);

  useEffect(() => {
    refreshFollows();
  }, [refreshFollows]);

  // Also refetch whenever the app's been backgrounded long enough to count
  // as freshly reopened (5 minutes - see BACKGROUND_RESET_MS in
  // context/collection.tsx) - someone could've followed/unfollowed you
  // while your phone was locked, same reasoning as every other screen's own
  // resetGeneration effect, just here instead of tied to a specific screen.
  // Skipped on the very first render (resetGeneration starts at 0, and the
  // mount effect above already covers the initial fetch).
  const isFirstResetRef = useRef(true);
  useEffect(() => {
    if (isFirstResetRef.current) {
      isFirstResetRef.current = false;
      return;
    }
    refreshFollows();
  }, [resetGeneration, refreshFollows]);

  // Optimistic, same pattern as CollectionProvider's own remove()/
  // removeBook() - the local list drops the row immediately (matching the
  // swipe animation's own "slide off and it's gone" feel) while the delete
  // fires in the background. No rollback on failure: a follow relationship
  // is low-stakes enough, and the next refetch (tab focus, background
  // reset) would just re-add it if the request somehow didn't land.
  const deleteFollow = useCallback(
    (username: string, direction: "following" | "followers") => {
      if (direction === "following") {
        setFollowing((prev) => prev.filter((u) => u.username !== username));
        // The feed is server-filtered to only people you follow, but that
        // filter only gets re-applied on the next fetch - without this, an
        // unfollowed person's posts kept showing until the explore tab lost
        // and regained focus (the only other thing that refetches).
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
            console.error(
              `[follows] server rejected removing ${direction}`,
              res.status,
            );
          }
        })
        .catch((error) => {
          console.error(`[follows] failed to remove ${direction}`, error);
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

  return (
    <FollowsContext
      value={{
        followers,
        following,
        feed,
        refreshFollows,
        unfollow,
        removeFollower,
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
