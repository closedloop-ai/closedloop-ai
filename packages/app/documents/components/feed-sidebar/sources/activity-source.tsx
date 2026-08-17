"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Activity as ActivityIcon, LoaderCircleIcon } from "lucide-react";
import { useMemo } from "react";
import { useArtifactActivityFeed } from "../../../hooks/use-artifact-activity-feed";
import { FeedItemKind } from "../feed-item";
import type { FeedSource, FeedSourceUseItemsResult } from "../feed-source";
import { ActivityCard } from "./activity-card";
import { ActivityFilterControl } from "./activity-filter-control";
import { useActivitySourceContext } from "./activity-source-provider";
import {
  ACTIVITY_SOURCE_ID,
  type ActivityFeedItem,
  type ActivityFilterState,
  DEFAULT_ACTIVITY_FILTER_STATE,
  isActivityFiltered,
  passesActivityFilter,
} from "./activity-types";

function useActivityItems(): FeedSourceUseItemsResult<ActivityFeedItem> {
  const { documentId } = useActivitySourceContext();
  const query = useArtifactActivityFeed(documentId);

  const items = useMemo<readonly ActivityFeedItem[]>(
    () =>
      (query.data ?? []).map((event) => ({
        id: event.id,
        kind: FeedItemKind.Activity,
        sourceId: ACTIVITY_SOURCE_ID,
        createdAt: event.createdAt,
        event,
      })),
    [query.data]
  );

  return useMemo(
    () =>
      ({
        items,
        // Only the FIRST page load blocks the stream; subsequent "load more"
        // fetches keep the already-rendered rows in place (handled by the
        // Footer's own control).
        isLoading: query.isPending,
        isError: query.isError,
      }) as const,
    [items, query.isPending, query.isError]
  );
}

function applyFilter(
  items: readonly ActivityFeedItem[],
  state: ActivityFilterState
): readonly ActivityFeedItem[] {
  if (!isActivityFiltered(state)) {
    return items;
  }
  return items.filter((item) => passesActivityFilter(item, state));
}

/**
 * "Load earlier activity" control, rendered in the source's `Footer` slot
 * (below the merged stream). Under the default newest-first sort the older rows
 * it fetches sort in below the existing ones, so the button and its result sit
 * at the same end of the stream — no scroll away from the affordance. Reads the
 * SAME infinite query as `useItems` — TanStack Query dedupes by `queryKey`, so
 * mounting the hook here shares the cached pages rather than issuing a second
 * fetch. Renders nothing when there is no next page.
 */
function ActivityLoadMoreFooter() {
  const { documentId } = useActivitySourceContext();
  const query = useArtifactActivityFeed(documentId);
  if (!query.hasNextPage) {
    return null;
  }
  return (
    <div className="px-3 pt-3">
      <Button
        className="w-full gap-2 text-muted-foreground text-xs"
        disabled={query.isFetchingNextPage}
        onClick={() => {
          if (query.hasNextPage && !query.isFetchingNextPage) {
            query.fetchNextPage();
          }
        }}
        size="sm"
        variant="outline"
      >
        {query.isFetchingNextPage ? (
          <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
        ) : null}
        Load earlier activity
      </Button>
    </div>
  );
}

/**
 * Activity `FeedSource` (FEA-3875 / FEA-3535 Slice 4). Reads the merged,
 * actor-normalized, cursor-paginated timeline from `GET /documents/[id]/
 * activity` and renders Asana-style rows (actor + human/agent/system badge,
 * action headline, before→after, timestamp). Registered into the document feed
 * rail alongside the Liveblocks comment source; the two do not double-count
 * because the aggregate endpoint deliberately omits comments (they are already
 * delivered by the Liveblocks source).
 */
export const activitySource: FeedSource<ActivityFeedItem, ActivityFilterState> =
  {
    id: ACTIVITY_SOURCE_ID,
    kind: FeedItemKind.Activity,
    label: "Activity",
    Icon: ActivityIcon,
    useItems: useActivityItems,
    defaultFilterState: DEFAULT_ACTIVITY_FILTER_STATE,
    applyFilter,
    isFiltered: isActivityFiltered,
    FilterControl: ActivityFilterControl,
    Footer: ActivityLoadMoreFooter,
    renderItem: (item) => <ActivityCard item={item} />,
  };
