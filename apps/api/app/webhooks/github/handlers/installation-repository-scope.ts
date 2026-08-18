import { GitHubInstallationStatus } from "@repo/database";

/**
 * The canonical "this webhook's repository, on an ACTIVE installation, not
 * tombstoned" predicate for `gitHubInstallationRepository`.
 *
 * Three lookups need it for the same delivery — the in-transaction repo resolve
 * in `pull-request-handler.ts`, the post-commit label reconciliation in
 * `pull-request-label-reconciliation.ts`, and the repo/org resolve in
 * `deployment-status-handler.ts`. Keeping the where-clause here means a change
 * to what counts as an active repository cannot land in one and miss the
 * others; the call sites still own their own `select` shapes.
 *
 * `installationId` is optional because a delivery can arrive without an
 * `installation` object. Omitting it drops the tenant scope, and the same
 * `githubRepoId` can carry one row per installation — `GitHubInstallationRepository`
 * is unique only by `(installationId, githubRepoId)` — each resolving to a
 * different organization. So an unscoped match is NOT a safe source of tenant
 * identity: callers that persist org-owned data must check the id was present
 * rather than trusting the row's organization.
 */
export function activeInstallationRepositoryWhere(input: {
  githubRepoId: string;
  fullName: string;
  installationId?: string;
}) {
  return {
    githubRepoId: input.githubRepoId,
    fullName: input.fullName,
    removedAt: null,
    installation: {
      ...(input.installationId ? { installationId: input.installationId } : {}),
      status: GitHubInstallationStatus.ACTIVE,
    },
  };
}
