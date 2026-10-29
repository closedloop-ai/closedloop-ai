"use client";

import type { DocumentType } from "@repo/api/src/types/document";
import {
  ActivityArtifactKind,
  ActivityCard,
  ActivityCardLayout,
  ActivityCommentCard,
} from "@repo/app/documents/components/feed-sidebar/sources/activity-card";
import type { ActivityLinkLookups } from "@repo/app/documents/components/feed-sidebar/sources/activity-formatting";
import type { ActivityFeedItem } from "@repo/app/documents/components/feed-sidebar/sources/activity-types";
import { ListReadErrorAlert } from "@repo/app/shared/components/list-read-error-alert";
import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { cn } from "@repo/design-system/lib/utils";
import { History } from "lucide-react";
import { ActivityEntryRow } from "./activity-entry";

/**
 * What an empty feed promises, per artifact (Nerys, 2026-10-06).
 *
 * The Session and Branch strings promise changes only, which predates
 * ISS-11004 projecting comments into both of those feeds. The copy is a human's
 * to change, not this module's, so it stands as approved and the mismatch is
 * reported rather than edited (root `AGENTS.md` -> Human Provenance).
 */
const EMPTY_DESCRIPTION: Readonly<Record<ActivityArtifactKind, string>> = {
  [ActivityArtifactKind.Document]:
    "Edits and comments on this artifact will appear here.",
  [ActivityArtifactKind.Branch]: "Changes to this branch will appear here.",
  [ActivityArtifactKind.Session]: "Changes to this session will appear here.",
};

/** Placeholder rows while the first page loads; enough to read as a feed. */
const LOADING_ROW_KEYS = ["row-1", "row-2", "row-3", "row-4"] as const;

export const ActivityTimelineRowKind = {
  /** A row from `GET /documents/[id]/activity`. */
  Activity: "activity",
  /** A comment, shown as a read-only pointer to the comment. */
  Comment: "comment",
} as const;

export type ActivityTimelineRow =
  | { kind: typeof ActivityTimelineRowKind.Activity; item: ActivityFeedItem }
  | {
      kind: typeof ActivityTimelineRowKind.Comment;
      id: string;
      authorId: string;
      createdAt: Date;
      /** Where the comment lives (the comments rail, deep-linked to it). */
      href: string;
      /** The comment's text, when the host has it; clamped to three lines. */
      body?: string | null;
      /** The comment was deleted or can no longer be read. */
      unavailable?: boolean;
    };

/**
 * The Activity tab body (ISS-10843 V1, reworked for ISS-12117 and ISS-12330):
 * one continuous timeline read as who, what, when — the actor's avatar on a
 * 2px line, the name, the action, then the time (Nerys, 2026-10-09).
 *
 * Each row is the production `ActivityCard` in its `timeline` look; the
 * Document comments rail renders the SAME container in its `rail` look, so the
 * two word and resolve every event identically.
 *
 * Per the 2026-09-25 review: one action per row, no filters, no sort control,
 * no grouping, and comments are read-only boxes that link to the comment.
 * Repeated rows from the same person are expected in V1. Newest first (Nerys,
 * 2026-10-07, matching the read API): the host passes rows newest first and
 * "Load more" at the END appends older rows.
 */
export function ActivityTimeline({
  rows,
  loading = false,
  error = false,
  onRetry,
  hasMore = false,
  onLoadMore,
  loadingMore = false,
  loadMoreError = false,
  documentType,
  artifactKind = ActivityArtifactKind.Document,
  links,
  now,
  className,
}: Readonly<{
  rows: readonly ActivityTimelineRow[];
  /** First load in flight; shows skeleton cards instead of rows. */
  loading?: boolean;
  /**
   * The first load failed. Shown as an error with retry, never as an empty
   * history: "nothing happened" and "we could not look" are different claims.
   */
  error?: boolean;
  /** Re-runs the failed first load. */
  onRetry?: () => void;
  /** The read API returned a `nextCursor`: older activity exists. */
  hasMore?: boolean;
  /** Fetches the next page (ISS-10844). */
  onLoadMore?: () => void;
  /** The next page is in flight. */
  loadingMore?: boolean;
  /**
   * Partial: the loaded rows are real, but the next page failed. The rows stay
   * and the failure sits where the next page would be, with its own retry.
   */
  loadMoreError?: boolean;
  /** The artifact's subtype, for its status vocabulary. */
  documentType?: DocumentType;
  /**
   * Which artifact's feed this is. A Session labels its status rows with the
   * Session vocabulary; Documents and Branches use the Document one.
   */
  artifactKind?: ActivityArtifactKind;
  /**
   * Where versions, runs, reports and related artifacts live. Optional: rows
   * that need a link the host cannot give say what happened and name nothing.
   */
  links?: ActivityLinkLookups;
  /**
   * The clock relative times are measured against. Omit it in the app (the
   * real clock); stories pin it so "3 days ago" stays "3 days ago".
   */
  now?: Date | number;
  className?: string;
}>) {
  if (loading) {
    return (
      <div
        aria-busy="true"
        aria-label="Loading activity"
        className={cn(TIMELINE_LIST_CLASS, className)}
        role="status"
      >
        {LOADING_ROW_KEYS.map((key) => (
          <div className={TIMELINE_ROW_CLASS} key={key}>
            <SkeletonEntry />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className={className}>
        <ListReadErrorAlert
          action={
            onRetry ? (
              <Button
                onClick={onRetry}
                size="sm"
                type="button"
                variant="outline"
              >
                Retry
              </Button>
            ) : null
          }
          description="Something went wrong loading this artifact's activity."
          title="Couldn't load activity"
        />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        className={className}
        description={EMPTY_DESCRIPTION[artifactKind]}
        icon={History}
        size="compact"
        title="No activity yet"
      />
    );
  }

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <ol aria-label="Activity" className={TIMELINE_LIST_CLASS}>
        {rows.map((row) =>
          row.kind === ActivityTimelineRowKind.Activity ? (
            <li className={TIMELINE_ROW_CLASS} key={row.item.id}>
              <ActivityCard
                artifactKind={artifactKind}
                documentType={documentType}
                item={row.item}
                layout={ActivityCardLayout.Timeline}
                links={links}
                now={now}
              />
            </li>
          ) : (
            <li className={TIMELINE_ROW_CLASS} key={row.id}>
              <ActivityCommentCard
                authorId={row.authorId}
                body={row.body}
                createdAt={row.createdAt}
                href={row.href}
                layout={ActivityCardLayout.Timeline}
                now={now}
                unavailable={row.unavailable}
              />
            </li>
          )
        )}
      </ol>
      <ActivityTimelineFooter
        hasMore={hasMore}
        loadingMore={loadingMore}
        loadMoreError={loadMoreError}
        onLoadMore={onLoadMore}
      />
    </div>
  );
}

/**
 * The end of the loaded rows: the next page in flight, a failed next page with
 * its own retry (the partial state), or "Load more" while older pages exist.
 * Nothing at all once the history is complete.
 */
function ActivityTimelineFooter({
  hasMore,
  loadingMore,
  loadMoreError,
  onLoadMore,
}: Readonly<{
  hasMore: boolean;
  loadingMore: boolean;
  loadMoreError: boolean;
  onLoadMore?: () => void;
}>) {
  if (loadingMore) {
    return (
      <div
        aria-busy="true"
        aria-label="Loading more activity"
        className="group/entry"
        role="status"
      >
        <SkeletonEntry />
      </div>
    );
  }
  if (loadMoreError) {
    return (
      <ListReadErrorAlert
        action={
          onLoadMore ? (
            <Button
              onClick={onLoadMore}
              size="sm"
              type="button"
              variant="outline"
            >
              Retry
            </Button>
          ) : null
        }
        description="The activity above loaded; the rest did not."
        title="Couldn't load more activity"
      />
    );
  }
  if (hasMore && onLoadMore) {
    return (
      <Button
        // Under the names: the 24px avatar column and the row's 12px gap.
        className="ml-9 self-start"
        onClick={onLoadMore}
        size="sm"
        type="button"
        variant="outline"
      >
        Load more
      </Button>
    );
  }
  return null;
}

/**
 * Each row is a `group/entry`, so its line (`ActivityEntryRow`) can leave out
 * the part above the first avatar and below the last: the line runs from the
 * first row's avatar to the last one's.
 */
const TIMELINE_LIST_CLASS = "flex flex-col";
const TIMELINE_ROW_CLASS = "group/entry";

/** A row's geometry while it loads: an avatar, a name, a line of text, a time. */
function SkeletonEntry() {
  return (
    <ActivityEntryRow
      actor={<Skeleton className="mt-1 h-4 w-24" />}
      avatar={<Skeleton className="size-6 rounded-full" />}
      time={<Skeleton className="mt-1 h-4 w-20" />}
    >
      <Skeleton className="mt-1 h-4 w-64 max-w-full" />
    </ActivityEntryRow>
  );
}
