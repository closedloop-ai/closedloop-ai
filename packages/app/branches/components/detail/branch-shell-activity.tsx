"use client";

import { CommentSurface } from "@repo/api/src/types/comment";
// Feature slice -> documents slice: the Activity tab renders the shared
// Activity panel (ISS-10843) and its comment address, which the documents
// slice owns because it owns the row type.
import { ArtifactActivityPanel } from "@repo/app/documents/components/artifact-activity/artifact-activity-panel";
import type { ArtifactCommentAddress } from "@repo/app/documents/components/artifact-activity/artifact-activity-rows";
import { ActivityArtifactKind } from "@repo/app/documents/components/feed-sidebar/sources/activity-card";
import { withArtifactCommentParam } from "@repo/app/shared/lib/artifact-comment-href";
import { ArtifactDetailTab } from "@repo/app/shared/lib/artifact-detail-tab";
import { usePath } from "@repo/navigation/use-path";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { useCallback } from "react";
import { useBranchActivityFeed } from "../../hooks/use-branch-activity-feed";

/**
 * The Branch Activity tab (ISS-10980): the shared timeline over live rows —
 * stored activity events and the branch's comments in one stream, as
 * `GET /branches/[id]/activity` projects them (ISS-11004).
 *
 * The comment link is built HERE rather than by the shell host, which is the
 * opposite of the Session split: a Branch's rail is a page-level sibling of
 * the tab system, so the address needs this route rather than a host-owned
 * one. That needs the navigation port, which is why this panel reads it
 * instead of taking a builder as a prop.
 *
 * It still names a tab, and names it PER THREAD. The rail being page-level
 * does not make it reachable from everywhere: ISS-10963's approved design puts
 * it beside Artifact and Sessions "and no others"
 * (`branch-detail-design-preview.tsx` COMMENTS_TABS), so an address that kept
 * the reader on Activity would point at a tab with nothing to receive it.
 *
 * Which of the two depends on where the comment actually is (operator,
 * 2026-10-08): the rail reads a different collection per tab, so a
 * `branch_timeline` thread is only in the Sessions rail and a `branch_detail`
 * thread only in the Artifact one. The feed carries that surface (ISS-10980);
 * a thread whose surface it could not state falls to Artifact, the branch's
 * own comments tab — the one the legacy page called "Branch details".
 *
 * Operator decision, 2026-10-08, asked before this was built: ship the tab
 * now and leave the rail to its own change. `BranchShellView` does not mount
 * `BranchCommentsController` yet — ISS-10797 shipped the shell without it,
 * which is also why the header's comments toggle is inert on the shell path —
 * so until that lands the link addresses a thread no rail is listening for.
 */
export function BranchShellActivity({
  branchId,
}: Readonly<{ branchId: string }>) {
  const feed = useBranchActivityFeed(branchId);
  const path = usePath();
  const searchParams = useSearchParamsValue();
  const buildCommentHref = useCallback(
    ({ surface, threadId }: ArtifactCommentAddress) =>
      withArtifactCommentParam({
        path,
        railTab: branchCommentRailTab(surface),
        searchParams,
        threadId,
      }),
    [path, searchParams]
  );
  return (
    <ArtifactActivityPanel
      artifactKind={ActivityArtifactKind.Branch}
      buildCommentHref={buildCommentHref}
      feed={feed}
    />
  );
}

/**
 * The tab whose comments rail holds a thread on this surface. Only
 * `branch_timeline` sits with the Sessions rail; every other answer, including
 * a surface the feed did not state, is the branch's own comments tab.
 */
function branchCommentRailTab(
  surface: CommentSurface | null
): ArtifactDetailTab {
  return surface === CommentSurface.BranchTimeline
    ? ArtifactDetailTab.Sessions
    : ArtifactDetailTab.Artifact;
}
