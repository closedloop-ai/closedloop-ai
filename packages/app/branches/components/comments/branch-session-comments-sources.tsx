"use client";

import type { CollectionCapabilities } from "@repo/api/src/types/comment-capabilities";
import type { CommentThreadDto } from "@repo/api/src/types/comment-thread-dto";
import type { CommentsDataSource } from "@repo/app/shared/comments/comments-data-source";
import type { ArtifactCommentWrites } from "@repo/app/shared/comments/use-artifact-comment-writes";
import { useArtifactComments } from "@repo/app/shared/comments/use-artifact-comments";
import { CommentsPaneLoadStatus } from "@repo/app/shared/components/comments/comments-pane-model";
import { useCallback, useEffect, useRef, useState } from "react";
import { BRANCH_COMMENTS_READ_CONCURRENCY } from "./branch-comments-collection-reader";

/** One rendered Session's comments, as its read reports them to the Branch pane. */
export type BranchSessionComments = {
  /** The Session's own source policy, which its threads answer to; null until read. */
  capabilities: CollectionCapabilities | null;
  threads: readonly CommentThreadDto[];
  status: CommentsPaneLoadStatus;
  pendingDraftKeys: readonly string[];
  retry: () => void;
  writes: ArtifactCommentWrites;
};

export type BranchSessionCommentsReports = ReadonlyMap<
  string,
  BranchSessionComments
>;

export type ReportBranchSessionComments = (
  sessionId: string,
  comments: BranchSessionComments | null
) => void;

export function useBranchSessionCommentsReports(): [
  BranchSessionCommentsReports,
  ReportBranchSessionComments,
] {
  const [reports, setReports] = useState<BranchSessionCommentsReports>(
    () => new Map()
  );
  const report = useCallback<ReportBranchSessionComments>(
    (sessionId, comments) =>
      setReports((current) => {
        if (
          comments === null
            ? !current.has(sessionId)
            : current.get(sessionId) === comments
        ) {
          return current;
        }
        const next = new Map(current);
        if (comments === null) {
          next.delete(sessionId);
        } else {
          next.set(sessionId, comments);
        }
        return next;
      }),
    []
  );
  return [reports, report];
}

/**
 * PLN-2162 decision 5, Sessions tab: one read per rendered Session's artifact,
 * each on its own comments channel, with at most today's
 * `BRANCH_COMMENTS_READ_CONCURRENCY` reads in flight at once.
 */
export function BranchSessionCommentsSources({
  dataSource,
  onReport,
  organizationId,
  reports,
  sessionIds,
}: {
  dataSource: CommentsDataSource;
  onReport: ReportBranchSessionComments;
  organizationId: string | null | undefined;
  reports: BranchSessionCommentsReports;
  sessionIds: readonly string[];
}) {
  const enabled = sessionReadsEnabled(sessionIds, reports);
  return sessionIds.map((sessionId) => (
    <BranchSessionCommentsSource
      dataSource={dataSource}
      enabled={enabled.has(sessionId)}
      key={sessionId}
      onReport={onReport}
      organizationId={organizationId}
      sessionId={sessionId}
    />
  ));
}

function BranchSessionCommentsSource({
  dataSource,
  enabled,
  onReport,
  organizationId,
  sessionId,
}: {
  dataSource: CommentsDataSource;
  enabled: boolean;
  onReport: ReportBranchSessionComments;
  organizationId: string | null | undefined;
  sessionId: string;
}) {
  const comments = useArtifactComments(
    { id: sessionId },
    { dataSource, organizationId, enabled }
  );
  const latestRetry = useRef(comments.onRetryLoad);
  useEffect(() => {
    latestRetry.current = comments.onRetryLoad;
  });
  const retry = useCallback(() => latestRetry.current(), []);
  const {
    capabilities,
    onCreateThread,
    onDelete,
    onEdit,
    onReopen,
    onReply,
    onResolve,
    onRetrySync,
    pendingDraftKeys,
    threads,
  } = comments;
  const status = comments.loadState.status;
  useEffect(() => {
    onReport(sessionId, {
      capabilities: capabilities ?? null,
      pendingDraftKeys,
      retry,
      status,
      threads,
      writes: {
        onCreateThread,
        onDelete,
        onEdit,
        onReopen,
        onReply,
        onResolve,
        onRetrySync,
      },
    });
  }, [
    capabilities,
    onCreateThread,
    onDelete,
    onEdit,
    onReopen,
    onReply,
    onReport,
    onResolve,
    onRetrySync,
    pendingDraftKeys,
    retry,
    sessionId,
    status,
    threads,
  ]);
  useEffect(() => () => onReport(sessionId, null), [onReport, sessionId]);
  return null;
}

/**
 * Settled reads stay on, and the first unsettled ones in render order fill the
 * concurrency budget, so the rest start as earlier reads land.
 */
function sessionReadsEnabled(
  sessionIds: readonly string[],
  reports: BranchSessionCommentsReports
): ReadonlySet<string> {
  const enabled = new Set<string>();
  let inFlight = 0;
  for (const sessionId of sessionIds) {
    const status = reports.get(sessionId)?.status;
    if (
      status === CommentsPaneLoadStatus.Ready ||
      status === CommentsPaneLoadStatus.Error
    ) {
      enabled.add(sessionId);
    } else if (inFlight < BRANCH_COMMENTS_READ_CONCURRENCY) {
      enabled.add(sessionId);
      inFlight += 1;
    }
  }
  return enabled;
}
