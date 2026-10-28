import {
  ISSUE_DESIGN_SCENARIOS,
  IssueDesignState,
} from "@repo/app/issues/components/detail-design/issue-detail-design-fixtures";
import {
  IssueActivityDesignPanel,
  IssueArtifactPanel,
  IssueDetailsDesignPanel,
  IssueSessionsDesignPanel,
} from "@repo/app/issues/components/detail-design/issue-detail-design-preview";
import { TooltipProvider } from "@repo/design-system/components/ui/tooltip";
import type { ReactNode } from "react";

// The Issue Detail page's tab bodies (PRD-751, ISS-12586), each in a
// page-height frame so it scrolls as it does on the page. Shared by the
// Composites tab stories under Labs/Issues/Issue Detail.

function TabFrame({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col bg-background">{children}</div>
    </TooltipProvider>
  );
}

/**
 * Artifact: the issue canvas in one of the issue's states, alone; its
 * page-level actions are inert here.
 */
export function IssueArtifactTabDemo({
  editing = false,
  state = IssueDesignState.Default,
}: {
  /** Open with the issue's text being edited: the edit bar shows. */
  editing?: boolean;
  state?: IssueDesignState;
}) {
  return (
    <TabFrame>
      <IssueArtifactPanel
        initialEditing={editing}
        onShowActivity={() => undefined}
        scenario={ISSUE_DESIGN_SCENARIOS[state]}
      />
    </TabFrame>
  );
}

export function IssueSessionsTabDemo() {
  return (
    <TabFrame>
      <IssueSessionsDesignPanel />
    </TabFrame>
  );
}

export function IssueDetailsTabDemo() {
  return (
    <TabFrame>
      <IssueDetailsDesignPanel />
    </TabFrame>
  );
}

export function IssueActivityTabDemo() {
  return (
    <TabFrame>
      <IssueActivityDesignPanel />
    </TabFrame>
  );
}
