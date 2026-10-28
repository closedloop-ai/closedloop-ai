"use client";

import { createDefaultBranchesListSurfaceV2PreviewState } from "@repo/app/branches/components/branches-list-surface-v2-demo";
import {
  BranchDetailTab,
  type BranchDetailTab as BranchDetailTabValue,
  BranchDetailView,
} from "@repo/app/branches/components/prototype-preview/components/branch-detail";
import { branchPrototypeReviewFixture } from "@repo/app/branches/components/prototype-preview/components/branch-list-fixtures";
import { BranchesList } from "@repo/app/branches/components/prototype-preview/components/branches-list";
import { useMetricPresentationState } from "@repo/app/branches/components/prototype-preview/components/use-metric-presentation-state";
import { usePrototypeCommentsControl } from "@repo/app/branches/components/prototype-preview/components/use-prototype-comments-control";
import type { BranchRow } from "@repo/app/branches/components/prototype-preview/mock";
import { buildBranchDetail } from "@repo/app/branches/components/prototype-preview/mock-detail";
import { Button } from "@repo/design-system/components/ui/button";
import {
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@repo/design-system/components/ui/primitives/underline-tabs";
import { Tabs } from "@repo/design-system/components/ui/tabs";
import { getStringRouteParam } from "@repo/navigation/route-param";
import { useRouteParams } from "@repo/navigation/use-route-params";
import { PanelRightIcon } from "lucide-react";
import { Suspense, useEffect, useState } from "react";
import {
  clearArtifactRouteState,
  readArtifactRouteState,
  writeArtifactRouteState,
} from "../../../shell/v2/components/web-master-preview/components/artifact-route-state"; // Cross-slice: mounted inside the Web Master preview shell (ISS-12938).
import { PageChrome } from "../../../shell/v2/components/web-master-preview/components/page-chrome"; // Cross-slice: mounted inside the Web Master preview shell (ISS-12938).
import { findWebMasterBranch } from "./branch-route-resolution";

const BASE_PATH = "/p/web-master/branches";

// The blessed Branches surface (app/p/branches), hosted as a subpage of the
// Web Master shell: same list/detail components and mock data. The Tabs root
// wraps the page chrome (not the whole shell as in the standalone prototype)
// so the underline triggers in the header and the TabsContent panes in the
// detail share one context inside the master layout.
const WebMasterBranchesPageContent = () => {
  const params = useRouteParams();
  const [listState, setListState] = useState(() =>
    createDefaultBranchesListSurfaceV2PreviewState()
  );
  const [selected, setSelected] = useState<BranchRow | null>(
    () =>
      findWebMasterBranch(getStringRouteParam(params, "artifactKey")) ?? null
  );
  const [activeTab, setActiveTab] = useState<BranchDetailTabValue>(
    BranchDetailTab.Details
  );
  const commentsControl = usePrototypeCommentsControl(selected?.id ?? null);
  const metricPresentationState = useMetricPresentationState();

  // The route key is the branch's identity here, so opening and closing a branch
  // has to move the URL with the view; otherwise a deep link reached from a
  // project collection reloads into a detail the breadcrumb has already left.
  useEffect(() => {
    const restoreRoute = () => {
      const route = readArtifactRouteState(undefined, { basePath: BASE_PATH });
      setSelected(findWebMasterBranch(route.artifactId) ?? null);
    };
    globalThis.window.addEventListener("popstate", restoreRoute);
    return () =>
      globalThis.window.removeEventListener("popstate", restoreRoute);
  }, []);

  const openDetail = (branch: BranchRow) => {
    setActiveTab(BranchDetailTab.Details);
    setSelected(branch);
    writeArtifactRouteState({ artifactId: branch.id }, "push", {
      basePath: BASE_PATH,
      routeKey: branch.id,
    });
  };

  const closeDetail = () => {
    setSelected(null);
    clearArtifactRouteState("push", { basePath: BASE_PATH });
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
                { label: "Branches", onSelect: closeDetail },
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

export const WebMasterBranchesRoute = () => (
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
