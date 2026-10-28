"use client";

import { useArtifactDetailTabRoute } from "@repo/app/shared/components/artifact-detail-shell/use-artifact-detail-tab-route";
import { CommentsPaneToggle } from "@repo/app/shared/components/comments/comments-pane-toggle";
import type { RefObject } from "react";
import { BRANCH_ARTIFACT_ROUTE_CONFIG } from "../branch-artifact-routing";
import {
  BRANCH_COMMENTS_PANE_KEYS,
  BranchCommentsTab,
  branchCommentsScopeForTab,
} from "./branch-comments-model";

export function BranchCommentsPaneToggle({
  toggleRef,
}: Readonly<{ toggleRef?: RefObject<HTMLButtonElement | null> }>) {
  const { activeTab } = useArtifactDetailTabRoute(BRANCH_ARTIFACT_ROUTE_CONFIG);
  const scope = branchCommentsScopeForTab(activeTab);
  return (
    <CommentsPaneToggle
      openKey={
        BRANCH_COMMENTS_PANE_KEYS[scope ?? BranchCommentsTab.Details].open
      }
      paneOnTab={scope !== null}
      toggleRef={toggleRef}
    />
  );
}
