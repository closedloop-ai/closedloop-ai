"use client";

import { TabsContent } from "@repo/design-system/components/ui/tabs";
import { useRef, useState } from "react";
import type { BranchDetail, PrComment } from "../mock";
import { countCommentsByTurnId } from "../trace-text";
import { BranchCommentsPanel } from "./branch-comments-panel";
import {
  BranchChecksReviewPanel,
  BranchCostToMerge,
  BranchDeliveredPanel,
  BranchFilesChangedPanel,
  BranchHeadlineCards,
  BranchLeadTimeWaterfall,
  BranchPropertiesPanel,
} from "./detail-panels";
import { BranchSessionsTimeline, scrollTraceToTurn } from "./sessions-timeline";

export const BranchDetailTab = {
  Details: "branch-details",
  Sessions: "sessions-timeline",
} as const;

export type BranchDetailTab =
  (typeof BranchDetailTab)[keyof typeof BranchDetailTab];

export function BranchDetailView({
  activeTab,
  commentsCollapsed,
  detail,
}: {
  activeTab: BranchDetailTab;
  commentsCollapsed: boolean;
  detail: BranchDetail;
}) {
  // Session comments are lifted here so the rail and the timeline's in-message
  // Add-comment affordance write to one shared list. Monotonic ids keep local
  // notes from colliding after a deletion frees an index.
  const [sessionComments, setSessionComments] = useState<PrComment[]>(
    detail.sessionComments
  );
  const nextLocalId = useRef(0);

  const addSessionComment = (
    body: string,
    anchorPreview?: string,
    anchorTurnId?: string
  ) => {
    nextLocalId.current += 1;
    setSessionComments((current) => [
      ...current,
      {
        id: `session-local-${nextLocalId.current}`,
        author: "You",
        at: "just now",
        anchorPreview,
        anchorTurnId,
        body,
      },
    ]);
  };

  // Comments-per-turn drives the persistent marker on each trace message; derived
  // from the live list so a newly added note updates the count immediately.
  const commentCountByTurnId = countCommentsByTurnId(sessionComments);
  const hasSessions = detail.sessions.length > 0;

  return (
    <div className="flex min-h-0 flex-1">
      <h1 className="sr-only">Branch {detail.branchName}</h1>
      <div className="flex min-h-0 min-w-0 flex-1">
        <TabsContent
          className="mx-auto min-h-0 w-full max-w-[1000px] flex-1 overflow-auto px-5 pt-4 pb-6"
          value={BranchDetailTab.Details}
        >
          <BranchPropertiesPanel detail={detail} />
          <BranchHeadlineCards detail={detail} />
          <BranchCostToMerge detail={detail} />
          <BranchLeadTimeWaterfall detail={detail} />
          <BranchDeliveredPanel detail={detail} />
          <BranchChecksReviewPanel detail={detail} />
          <BranchFilesChangedPanel detail={detail} />
        </TabsContent>

        <TabsContent
          className="min-h-0 flex-1 overflow-auto"
          value={BranchDetailTab.Sessions}
        >
          <BranchSessionsTimeline
            commentCountByTurnId={commentCountByTurnId}
            detail={detail}
            onAddComment={addSessionComment}
          />
        </TabsContent>
      </div>

      <BranchCommentsPanel
        comments={detail.comments}
        emptyDescription={
          detail.prNumber === null
            ? "PR comments will be available after this branch has a linked pull request."
            : "Pull request review comments and replies appear here."
        }
        emptyTitle={
          detail.prNumber === null ? "No pull request linked" : undefined
        }
        hidden={commentsCollapsed || activeTab !== BranchDetailTab.Details}
        placeholder="Add a PR comment…"
        readOnly
        title="PR comments"
      />
      {/* The session rail is display-only (hint-only, matching production): every
          session comment is created from the trace's Add-comment affordance, so
          the rail never mints an anchor-less comment through its own composer. */}
      <BranchCommentsPanel
        comments={detail.sessionComments}
        emptyDescription={
          hasSessions
            ? "Comments about sessions and timeline events appear here. Select Add comment on any message to start one."
            : "No sessions have been recorded for this branch yet."
        }
        hidden={commentsCollapsed || activeTab !== BranchDetailTab.Sessions}
        items={sessionComments}
        onAnchorClick={scrollTraceToTurn}
        placeholder="Add a session comment…"
        readOnly
        title="Session comments"
      />
    </div>
  );
}
