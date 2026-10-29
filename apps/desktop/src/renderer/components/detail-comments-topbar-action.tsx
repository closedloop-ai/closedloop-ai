import { SessionCommentsPaneToggle } from "@repo/app/agents/components/detail/session-comments-pane-toggle";
import type { BranchCommentsControl } from "@repo/app/branches/components/branch-detail-page";
import { BranchCommentsPaneToggle } from "@repo/app/branches/components/comments/branch-comments-pane-toggle";
import { BranchCommentsToggle } from "@repo/app/branches/components/comments/branch-comments-toggle";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { ARTIFACT_DETAIL_SHELL_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";

/**
 * The Session and Branch detail routes' comments button, in the Topbar's
 * actions slot. With `artifact-detail-shell` on it is the shell pane's own
 * button, shown only on tabs with a pane (ISS-12300 D3); off, Branch keeps its
 * legacy toggle and Session has none. Optional reader because the renderer has
 * no flag provider in every mount context; absent resolves false.
 */
export function DetailCommentsTopbarAction({
  branchCommentsControl,
  branchId,
  sessionId,
}: Readonly<{
  branchCommentsControl: BranchCommentsControl;
  branchId: string | null;
  sessionId: string | null;
}>) {
  const shellEnabled = useFeatureFlagEnabledOptional(
    ARTIFACT_DETAIL_SHELL_FEATURE_FLAG_KEY
  );
  if (sessionId) {
    return shellEnabled ? <SessionCommentsPaneToggle /> : null;
  }
  if (!branchId) {
    return null;
  }
  return shellEnabled ? (
    <BranchCommentsPaneToggle toggleRef={branchCommentsControl.toggleRef} />
  ) : (
    <BranchCommentsToggle
      onOpenChange={branchCommentsControl.onOpenChange}
      open={branchCommentsControl.open}
      toggleRef={branchCommentsControl.toggleRef}
    />
  );
}
