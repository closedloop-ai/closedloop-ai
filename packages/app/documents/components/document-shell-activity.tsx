"use client";

import type { DocumentDetail } from "@repo/api/src/types/document";
import { ARTIFACT_DETAIL_CONTENT_WIDTH_CLASS } from "@repo/app/shared/components/artifact-detail-shell/artifact-detail-shell";
import { UserLink } from "@repo/app/shared/components/user-link";
import { getUserDisplayName } from "@repo/app/shared/lib/user-utils";
import { cn } from "@repo/design-system/lib/utils";
import { useMemo } from "react";
import { useArtifactActivityFeed } from "../hooks/use-artifact-activity-feed";
import {
  ActivityTimeline,
  type ActivityTimelineRow,
  ActivityTimelineRowKind,
} from "./artifact-activity/activity-timeline";
import { DocumentActivitySection } from "./document-activity-section";
import { getDocumentActivityMetadata } from "./document-editor-details";
import { FeedItemKind } from "./feed-sidebar/feed-item";
import { ACTIVITY_SOURCE_ID } from "./feed-sidebar/sources/activity-types";

/** The shared Activity timeline over this document's existing paginated feed. */
export function DocumentShellActivity({
  document,
}: Readonly<{ document: DocumentDetail }>) {
  const activity = getDocumentActivityMetadata(document);
  const feed = useArtifactActivityFeed(document.id);
  const rows = useMemo<readonly ActivityTimelineRow[]>(
    () =>
      (feed.data ?? []).map((event) => ({
        kind: ActivityTimelineRowKind.Activity,
        item: {
          id: event.id,
          kind: FeedItemKind.Activity,
          sourceId: ACTIVITY_SOURCE_ID,
          createdAt: event.createdAt,
          event,
        },
      })),
    [feed.data]
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div
        className={cn(ARTIFACT_DETAIL_CONTENT_WIDTH_CLASS, "px-5 pt-4 pb-6")}
      >
        {feed.isRefetchError && rows.length > 0 ? (
          <ActivityTimeline
            error
            onRetry={() => {
              feed.refetch().catch(() => undefined);
            }}
            rows={[]}
          />
        ) : null}
        <ActivityTimeline
          documentType={document.type}
          error={feed.isError && rows.length === 0}
          hasMore={feed.hasNextPage}
          loading={feed.isPending}
          loadingMore={feed.isFetchingNextPage}
          loadMoreError={feed.isFetchNextPageError}
          onLoadMore={() => {
            feed.fetchNextPage().catch(() => undefined);
          }}
          onRetry={() => {
            feed.refetch().catch(() => undefined);
          }}
          rows={rows}
        />
        <DocumentActivitySection
          createdAt={activity.createdAt}
          createdByContent={
            activity.createdBy ? (
              <UserLink
                className="text-foreground hover:underline"
                userId={activity.createdBy.id}
              >
                {getUserDisplayName(activity.createdBy)}
              </UserLink>
            ) : undefined
          }
          updatedAt={activity.updatedAt}
        />
      </div>
    </div>
  );
}
