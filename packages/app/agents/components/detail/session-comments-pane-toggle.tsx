"use client";

import { useArtifactDetailTabRoute } from "@repo/app/shared/components/artifact-detail-shell/use-artifact-detail-tab-route";
import { CommentsPaneToggle } from "@repo/app/shared/components/comments/comments-pane-toggle";
import { CommentsPaneOpenKey } from "@repo/app/shared/components/comments/use-comments-pane-state";
import { ArtifactDetailTab } from "@repo/app/shared/lib/artifact-detail-tab";
import { SESSION_ARTIFACT_ROUTE_CONFIG } from "./session-artifact-routing";

/** ISS-12300 D3: the Session shell's header button, on the Session tab only. */
export function SessionCommentsPaneToggle() {
  const { activeTab } = useArtifactDetailTabRoute(
    SESSION_ARTIFACT_ROUTE_CONFIG
  );
  return (
    <CommentsPaneToggle
      openKey={CommentsPaneOpenKey.Session}
      paneOnTab={activeTab === ArtifactDetailTab.Sessions}
    />
  );
}
