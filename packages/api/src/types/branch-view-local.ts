export const BranchViewLocalGatewayPath = {
  List: "/api/gateway/git/local-changes",
  Diff: "/api/gateway/git/local-changes/diff",
  CommitPush: "/api/gateway/git/local-changes/commit-push",
} as const;
export type BranchViewLocalGatewayPath =
  (typeof BranchViewLocalGatewayPath)[keyof typeof BranchViewLocalGatewayPath];

export const BranchViewLocalOperationId = {
  Read: "git_local_changes",
  CommitPush: "git_local_commit_push",
} as const;
export type BranchViewLocalOperationId =
  (typeof BranchViewLocalOperationId)[keyof typeof BranchViewLocalOperationId];

export const BranchViewLocalHeader = {
  Operation: "x-branch-view-local-operation",
  ExternalLinkId: "x-branch-view-external-link-id",
  RepoFullName: "x-branch-view-repo-full-name",
  HeadBranch: "x-branch-view-head-branch",
  PrNumber: "x-branch-view-pr-number",
  AuthorizedUserId: "x-branch-view-authorized-user-id",
  AuthorizedOrgId: "x-branch-view-authorized-org-id",
} as const;
export type BranchViewLocalHeader =
  (typeof BranchViewLocalHeader)[keyof typeof BranchViewLocalHeader];

export const BranchViewLocalErrorCode = {
  AuthorizationRequired: "branch_view_authorization_required",
  NotAuthor: "branch_view_not_author",
  ContextMismatch: "branch_view_context_mismatch",
  FeatureDisabled: "branch_view_feature_disabled",
  ComputeTargetForbidden: "compute_target_forbidden",
  ComputeTargetOffline: "compute_target_offline",
  StaleProof: "stale_branch_view_proof",
  PublicEventReadRequired: "branch_view_public_event_read_required",
  UnsupportedDesktopVersion: "unsupported_desktop_version",
} as const;
export type BranchViewLocalErrorCode =
  (typeof BranchViewLocalErrorCode)[keyof typeof BranchViewLocalErrorCode];

export function getBranchViewLocalGatewayPathname(path: string): string {
  return new URL(path, "http://local").pathname;
}

export function isBranchViewLocalGatewayPath(path: string): boolean {
  const pathname = getBranchViewLocalGatewayPathname(path);
  return (
    pathname === BranchViewLocalGatewayPath.List ||
    pathname === BranchViewLocalGatewayPath.Diff ||
    pathname === BranchViewLocalGatewayPath.CommitPush
  );
}

export function resolveBranchViewLocalOperationId(
  path: string
): BranchViewLocalOperationId | null {
  const pathname = getBranchViewLocalGatewayPathname(path);
  if (pathname === BranchViewLocalGatewayPath.CommitPush) {
    return BranchViewLocalOperationId.CommitPush;
  }
  if (
    pathname === BranchViewLocalGatewayPath.List ||
    pathname === BranchViewLocalGatewayPath.Diff
  ) {
    return BranchViewLocalOperationId.Read;
  }
  return null;
}
