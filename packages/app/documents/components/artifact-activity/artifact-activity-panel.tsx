"use client";

import type { ArtifactActivityFeedItem } from "@repo/api/src/types/artifact-activity-feed";
import { useMemo } from "react";
import type { ActivityArtifactKind } from "../feed-sidebar/sources/activity-card";
import { ActivityTimeline } from "./activity-timeline";
import {
  type ArtifactCommentAddress,
  toArtifactActivityRows,
} from "./artifact-activity-rows";

/**
 * The slice of an artifact Activity feed query the panel reads. Both
 * `useSessionActivityFeed` and `useBranchActivityFeed` return it: an infinite
 * query over feed items plus `supported`, false for a source that serves no
 * activity.
 */
export type ArtifactActivityPanelFeed = {
  data: ArtifactActivityFeedItem[] | undefined;
  fetchNextPage: () => Promise<unknown>;
  hasNextPage: boolean;
  isError: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  isPending: boolean;
  isRefetchError: boolean;
  refetch: () => Promise<unknown>;
  supported: boolean;
};

/**
 * One artifact's Activity tab body (PR #8601 review): the Session and Branch
 * tabs both render this, so the loading, empty, partial, and error states are
 * decided in one place. Only the feed, the artifact kind, and the comment link
 * builder differ per host. The host frames and scrolls it (the canvas card,
 * ISS-12412).
 */
export function ArtifactActivityPanel({
  artifactKind,
  buildCommentHref,
  feed,
}: Readonly<{
  artifactKind: ActivityArtifactKind;
  buildCommentHref: (address: ArtifactCommentAddress) => string;
  feed: ArtifactActivityPanelFeed;
}>) {
  const rows = useMemo(
    () => toArtifactActivityRows({ buildCommentHref, events: feed.data ?? [] }),
    [buildCommentHref, feed.data]
  );
  const retry = () => {
    feed.refetch().catch(() => undefined);
  };

  return (
    <div className="flex flex-col gap-2">
      {feed.isRefetchError && rows.length > 0 ? (
        <ActivityTimeline error onRetry={retry} rows={[]} />
      ) : null}
      <ActivityTimeline
        artifactKind={artifactKind}
        error={feed.isError && rows.length === 0}
        hasMore={feed.hasNextPage}
        loading={feed.supported && feed.isPending}
        loadingMore={feed.isFetchingNextPage}
        loadMoreError={feed.isFetchNextPageError}
        onLoadMore={() => {
          feed.fetchNextPage().catch(() => undefined);
        }}
        onRetry={retry}
        rows={rows}
      />
    </div>
  );
}
