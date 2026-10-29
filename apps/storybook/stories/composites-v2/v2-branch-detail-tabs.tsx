import { BRANCH_DESIGN_PULL_REQUEST_IDS } from "@repo/app/branches/components/detail-design/branch-detail-design-fixtures";
import {
  BranchActivityPanel,
  BranchArtifactPanel,
  BranchDetailsPanel,
  BranchSessionsPanel,
} from "@repo/app/branches/components/detail-design/branch-detail-design-preview";
import { TooltipProvider } from "@repo/design-system/components/ui/tooltip";
import { type ReactNode, useState } from "react";

// The Branch Detail page's tab bodies (PRD-751), each in a page-height frame
// so it scrolls as it does on the page. Shared by the Composites tab
// stories under Artifacts/Branches/Branch Detail.

function TabFrame({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col bg-background">{children}</div>
    </TooltipProvider>
  );
}

/** Artifact: the branch, then everything scoped to the chosen pull request. */
export function BranchArtifactTabDemo() {
  const [selectedId, setSelectedId] = useState<string>(
    BRANCH_DESIGN_PULL_REQUEST_IDS.Open
  );
  return (
    <TabFrame>
      <BranchArtifactPanel
        onSelectPullRequest={setSelectedId}
        selectedId={selectedId}
      />
    </TabFrame>
  );
}

export function BranchDetailsTabDemo() {
  return (
    <TabFrame>
      <BranchDetailsPanel />
    </TabFrame>
  );
}

export function BranchSessionsTabDemo() {
  return (
    <TabFrame>
      <BranchSessionsPanel />
    </TabFrame>
  );
}

export function BranchActivityTabDemo() {
  return (
    <TabFrame>
      <BranchActivityPanel />
    </TabFrame>
  );
}
