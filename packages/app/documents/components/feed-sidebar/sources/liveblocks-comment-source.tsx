"use client";

import type { ThreadData } from "@liveblocks/client";
import { useThreads } from "@liveblocks/react/suspense";
import { MessageSquare } from "lucide-react";
import { useMemo } from "react";
import { deriveAnchorStatus } from "../anchor-status";
import { useFeedFilter } from "../feed-filter-context";
import { FeedItemKind } from "../feed-item";
import type { FeedSource, FeedSourceUseItemsResult } from "../feed-source";
import {
  DEFAULT_LIVEBLOCKS_FILTER_STATE,
  isLiveblocksFilterActive,
  type LiveblocksFilterState,
  type LiveblocksItemClassification,
  passesLiveblocksFilter,
} from "./apply-liveblocks-filter";
import { LiveblocksCommentCard } from "./liveblocks-comment-card";
import { LiveblocksComposer } from "./liveblocks-composer";
import { LiveblocksFilterControl } from "./liveblocks-filter-control";
import { LiveblocksMissingThreadBanner } from "./liveblocks-missing-thread-banner";
import { useLiveblocksSourceContext } from "./liveblocks-source-provider";

export const LIVEBLOCKS_COMMENT_SOURCE_ID = "liveblocks-comment";

export type LiveblocksCommentItem = {
  id: string;
  kind: typeof FeedItemKind.LiveblocksComment;
  sourceId: typeof LIVEBLOCKS_COMMENT_SOURCE_ID;
  createdAt: Date;
  thread: ThreadData;
  anchorPreview: string | null;
  /** Pre-computed display badge (e.g. "from v1"); undefined when current. */
  versionLabel: string | undefined;
  /** Classification consumed by `passesLiveblocksFilter`. */
  classification: LiveblocksItemClassification;
};

function useLiveblocksItems(): FeedSourceUseItemsResult<LiveblocksCommentItem> {
  const { threads } = useThreads();
  const { latestVersion } = useLiveblocksSourceContext();
  const items = useMemo<readonly LiveblocksCommentItem[]>(
    () =>
      threads.map((thread) => {
        const threadVersion = thread.metadata.version;
        const anchorStatus = deriveAnchorStatus(thread);
        return {
          id: thread.id,
          kind: FeedItemKind.LiveblocksComment,
          sourceId: LIVEBLOCKS_COMMENT_SOURCE_ID,
          createdAt: thread.createdAt,
          thread,
          anchorPreview: thread.metadata.anchorPreview ?? null,
          versionLabel: deriveVersionLabel(threadVersion, latestVersion),
          classification: {
            threadVersion,
            isCurrentVersion:
              threadVersion !== undefined && threadVersion >= latestVersion,
            anchorStatus,
          },
        };
      }),
    [threads, latestVersion]
  );
  // Memoize the result object: SourceItemsProvider uses this return
  // value in a Map-building useMemo dep list, so a fresh object literal
  // on every render would rebuild the registry and double-render every
  // consumer (filter bar, stream) on any unrelated state change.
  return useMemo(
    () => ({ items, isLoading: false, isError: false }) as const,
    [items]
  );
}

function applyFilter(
  items: readonly LiveblocksCommentItem[],
  filterState: LiveblocksFilterState
): readonly LiveblocksCommentItem[] {
  if (!isLiveblocksFilterActive(filterState)) {
    return items;
  }
  return items.filter((it) =>
    passesLiveblocksFilter(it.classification, filterState)
  );
}

function LiveblocksItemCardWrapper({
  item,
}: Readonly<{ item: LiveblocksCommentItem }>) {
  const { onCommentClick } = useLiveblocksSourceContext();
  return (
    <LiveblocksCommentCard
      anchorPreview={item.anchorPreview}
      onCommentClick={
        onCommentClick ? () => onCommentClick(item.thread) : undefined
      }
      thread={item.thread}
      versionLabel={item.versionLabel}
    />
  );
}

function LiveblocksComposerSlot() {
  const { getSourceState } = useFeedFilter();
  const state = getSourceState<LiveblocksFilterState>(
    LIVEBLOCKS_COMMENT_SOURCE_ID
  );
  if (state?.versionFilter !== undefined) {
    return null;
  }
  return <LiveblocksComposer />;
}

export const liveblocksCommentSource: FeedSource<
  LiveblocksCommentItem,
  LiveblocksFilterState
> = {
  id: LIVEBLOCKS_COMMENT_SOURCE_ID,
  kind: FeedItemKind.LiveblocksComment,
  label: "Comments",
  Icon: MessageSquare,
  useItems: useLiveblocksItems,
  defaultFilterState: DEFAULT_LIVEBLOCKS_FILTER_STATE,
  applyFilter,
  isFiltered: isLiveblocksFilterActive,
  FilterControl: LiveblocksFilterControl,
  Composer: LiveblocksComposerSlot,
  StatusBanner: LiveblocksMissingThreadBanner,
  renderItem: (item) => <LiveblocksItemCardWrapper item={item} />,
};

/**
 * Returns the version-attribution badge text for a thread, or undefined
 * when no badge should render. Behavior mirrors the pre-refactor
 * `deriveVersionLabel` in `comment-stream.tsx`.
 */
function deriveVersionLabel(
  version: number | undefined,
  latestVersion: number
): string | undefined {
  if (version === undefined) {
    return latestVersion > 1 ? "from a prior version" : undefined;
  }
  if (version < latestVersion) {
    return `from v${version}`;
  }
  return undefined;
}
