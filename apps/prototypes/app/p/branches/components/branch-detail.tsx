"use client";

import { TabsContent } from "@repo/design-system/components/ui/tabs";
import type { BranchDetail } from "../mock";
import { BranchCommentsPanel } from "./branch-comments-panel";
import { BranchFilesChangedPanel } from "./branch-files-changed-panel";
import {
  BranchChecksReviewPanel,
  BranchCostToMerge,
  BranchDeliveredPanel,
  BranchHeadlineCards,
  BranchLeadTimeWaterfall,
  BranchPropertiesPanel,
} from "./detail-panels";
import { BranchSessionsTimeline } from "./sessions-timeline";

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
  return (
    <div className="flex min-h-0 flex-1">
      <h1 className="sr-only">Branch {detail.branchName}</h1>
      <div className="flex min-h-0 min-w-0 flex-1">
        <TabsContent
          className="mx-auto min-h-0 w-full max-w-content flex-1 overflow-auto px-5 pt-4 pb-6"
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
          <BranchSessionsTimeline detail={detail} />
        </TabsContent>
      </div>

      <BranchCommentsPanel
        availability={detail.commentsAvailability}
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
      <BranchCommentsPanel
        comments={detail.sessionComments}
        emptyDescription="Comments about sessions and timeline events appear here."
        hidden={commentsCollapsed || activeTab !== BranchDetailTab.Sessions}
        placeholder="Add a session comment…"
        title="Session comments"
      />
    </div>
  );
}
