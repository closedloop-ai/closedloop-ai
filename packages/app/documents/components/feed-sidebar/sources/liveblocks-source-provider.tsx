"use client";

import type { ThreadData } from "@liveblocks/client";
import { createContext, type ReactNode, useContext } from "react";

export type LiveblocksSourceContextValue = {
  /**
   * The artifact's current `latestVersion`. Used by version-attribution
   * badges, the artifact-level composer's `ThreadMetadata.version`
   * stamp, and the version-of-origin filter "current vs prior" cutoff.
   */
  latestVersion: number;
  /**
   * Click handler for comment cards. Doc-side scaffold uses this to
   * scroll the document editor to the thread's anchor for anchored
   * threads. No-op when omitted. (Permalink-URL building stays in
   * `CommentPermalinkProvider` — the card reads it via
   * `useCommentPermalink()`.)
   */
  onCommentClick?: (thread: ThreadData) => void;
};

const NOOP_VALUE: LiveblocksSourceContextValue = {
  latestVersion: 1,
};

const LiveblocksSourceContext =
  createContext<LiveblocksSourceContextValue>(NOOP_VALUE);

export type LiveblocksSourceProviderProps = {
  value: LiveblocksSourceContextValue;
  children: ReactNode;
};

/**
 * Single owner of Liveblocks-source per-caller config. Mounted by the
 * doc editor scaffold around `<FeedSidebar>` so the source's
 * `renderItem`, `Composer`, and `FilterControl` can read `latestVersion`,
 * the permalink builder, and the anchor-scroll click handler without
 * threading them through the generic `FeedSidebar` prop surface.
 */
export function LiveblocksSourceProvider({
  value,
  children,
}: Readonly<LiveblocksSourceProviderProps>) {
  return (
    <LiveblocksSourceContext.Provider value={value}>
      {children}
    </LiveblocksSourceContext.Provider>
  );
}

export function useLiveblocksSourceContext(): LiveblocksSourceContextValue {
  return useContext(LiveblocksSourceContext);
}
