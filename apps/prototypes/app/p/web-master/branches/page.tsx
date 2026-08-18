"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@repo/design-system/components/ui/primitives/underline-tabs";
import { Tabs } from "@repo/design-system/components/ui/tabs";
import { PanelRightIcon } from "lucide-react";
import { Suspense, useState } from "react";
import {
  BranchDetailTab,
  type BranchDetailTab as BranchDetailTabValue,
  BranchDetailView,
} from "@/app/p/branches/components/branch-detail";
import { branchPrototypeReviewFixture } from "@/app/p/branches/components/branch-list-fixtures";
import { createDefaultBranchListViewState } from "@/app/p/branches/components/branch-list-state";
import { BranchesList } from "@/app/p/branches/components/branches-list";
import { TOGGLEABLE_COLUMNS } from "@/app/p/branches/components/branches-toolbar";
import { useMetricPresentationState } from "@/app/p/branches/components/use-metric-presentation-state";
import { usePrototypeCommentsControl } from "@/app/p/branches/components/use-prototype-comments-control";
import type { BranchRow } from "@/app/p/branches/mock";
import { buildBranchDetail } from "@/app/p/branches/mock-detail";
import { PageChrome } from "../components/page-chrome";

// The blessed Branches surface (app/p/branches), hosted as a subpage of the
// Web Master shell: same list/detail components and mock data. The Tabs root
// wraps the page chrome (not the whole shell as in the standalone prototype)
// so the underline triggers in the header and the TabsContent panes in the
// detail share one context inside the master layout.
const WebMasterBranchesPageContent = () => {
  const [listState, setListState] = useState(() =>
    createDefaultBranchListViewState(
      TOGGLEABLE_COLUMNS.map((column) => column.id)
    )
  );
  const [selected, setSelected] = useState<BranchRow | null>(null);
  const [activeTab, setActiveTab] = useState<BranchDetailTabValue>(
    BranchDetailTab.Details
  );
  const commentsControl = usePrototypeCommentsControl(selected?.id ?? null);
  const metricPresentationState = useMetricPresentationState();

  const openDetail = (branch: BranchRow) => {
    setActiveTab(BranchDetailTab.Details);
    setSelected(branch);
  };
  const detail = selected ? buildBranchDetail(selected) : null;

  return (
    <Tabs
      className="min-h-0 w-full flex-1 gap-0"
      onValueChange={(value) => setActiveTab(value as BranchDetailTabValue)}
      value={activeTab}
    >
      <PageChrome
        actions={
          selected ? (
            <CommentsToggle
              collapsed={!commentsControl.open}
              onToggle={() =>
                commentsControl.onOpenChange(!commentsControl.open)
              }
            />
          ) : undefined
        }
        breadcrumbs={
          selected
            ? [
                { label: "Branches", onSelect: () => setSelected(null) },
                { label: selected.branchName, isCurrent: true },
              ]
            : [{ label: "Branches", isCurrent: true }]
        }
        navigation={
          selected ? (
            <UnderlineTabsList>
              <UnderlineTabsTrigger value={BranchDetailTab.Details}>
                Branch details
              </UnderlineTabsTrigger>
              <UnderlineTabsTrigger value={BranchDetailTab.Sessions}>
                Sessions &amp; timeline
              </UnderlineTabsTrigger>
            </UnderlineTabsList>
          ) : undefined
        }
      >
        {detail ? (
          <BranchDetailView
            activeTab={activeTab}
            commentsCollapsed={!commentsControl.open}
            detail={detail}
            key={detail.id}
          />
        ) : (
          <BranchesList
            evidence={branchPrototypeReviewFixture.evidence}
            onOpenDetail={openDetail}
            onStateChange={setListState}
            presentationState={metricPresentationState}
            rows={branchPrototypeReviewFixture.rows}
            state={listState}
          />
        )}
      </PageChrome>
    </Tabs>
  );
};

const WebMasterBranchesPage = () => (
  <Suspense fallback={null}>
    <WebMasterBranchesPageContent />
  </Suspense>
);

function CommentsToggle({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const label = collapsed ? "Show comments rail" : "Hide comments rail";

  return (
    <Button
      aria-label={label}
      aria-pressed={!collapsed}
      onClick={onToggle}
      size="icon-sm"
      title={label}
      type="button"
      variant="ghost"
    >
      <PanelRightIcon aria-hidden />
    </Button>
  );
}

export default WebMasterBranchesPage;
