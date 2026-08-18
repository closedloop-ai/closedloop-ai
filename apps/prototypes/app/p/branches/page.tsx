"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import {
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@repo/design-system/components/ui/primitives/underline-tabs";
import { Tabs } from "@repo/design-system/components/ui/tabs";
import { GitBranchIcon, PanelRightIcon } from "lucide-react";
import { type ReactNode, Suspense, useState } from "react";
import { AppShell } from "./components/app-shell";
import {
  BranchDetailTab,
  type BranchDetailTab as BranchDetailTabValue,
  BranchDetailView,
} from "./components/branch-detail";
import { branchPrototypeReviewFixture } from "./components/branch-list-fixtures";
import { createDefaultBranchListViewState } from "./components/branch-list-state";
import { BranchesList } from "./components/branches-list";
import { TOGGLEABLE_COLUMNS } from "./components/branches-toolbar";
import { useMetricPresentationState } from "./components/use-metric-presentation-state";
import { usePrototypeCommentsControl } from "./components/use-prototype-comments-control";
import { BranchDataState, type BranchRow } from "./mock";
import { buildBranchDetail } from "./mock-detail";

const BranchesPrototypePageContent = () => {
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
  const awaitingSync = selected?.dataState === BranchDataState.AwaitingSync;

  const openDetail = (branch: BranchRow) => {
    setActiveTab(BranchDetailTab.Details);
    setSelected(branch);
  };
  const detail =
    selected && !awaitingSync
      ? buildBranchDetail(selected, { useFileCoverageFixtures: true })
      : null;
  let pageContent: ReactNode = (
    <BranchesList
      evidence={branchPrototypeReviewFixture.evidence}
      onOpenDetail={openDetail}
      onStateChange={setListState}
      presentationState={metricPresentationState}
      rows={branchPrototypeReviewFixture.rows}
      state={listState}
    />
  );
  if (selected && awaitingSync) {
    pageContent = <BranchAwaitingSyncState branchName={selected.branchName} />;
  } else if (detail) {
    pageContent = (
      <BranchDetailView
        activeTab={activeTab}
        commentsCollapsed={!commentsControl.open}
        detail={detail}
        key={detail.id}
      />
    );
  }

  return (
    <Tabs
      className="h-svh w-full gap-0"
      onValueChange={(value) => setActiveTab(value as BranchDetailTabValue)}
      value={activeTab}
    >
      <AppShell
        actions={
          selected && !awaitingSync ? (
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
          selected && !awaitingSync ? (
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
        {pageContent}
      </AppShell>
    </Tabs>
  );
};

const BranchesPrototypePage = () => (
  <Suspense fallback={null}>
    <BranchesPrototypePageContent />
  </Suspense>
);

function BranchAwaitingSyncState({ branchName }: { branchName: string }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
      <h1 className="sr-only">Branch {branchName}</h1>
      <EmptyState
        description="Branch data is being synchronized. Refresh this page after sync completes."
        icon={GitBranchIcon}
        title="Branch sync in progress"
      />
    </div>
  );
}

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

export default BranchesPrototypePage;
