/**
 * FEA-3930 — best-effort, fail-open write hooks that keep the `search_document`
 * projection eventually consistent with branches and their current pull request.
 * A branch routes to `/branches/<artifactId>`; a pull request routes to its
 * owning branch. Both are indexed from the single `BranchArtifactWithDetail` the
 * branch upsert returns, so create and update share one wire point.
 *
 * These wrap `searchIndexService.indexAfterCommit`, which is post-commit +
 * `waitUntil` + swallow-on-error, so a projection failure can never roll back or
 * 500 the authoritative branch/PR write. The one-shot backfill
 * (`packages/database` `backfill:search-documents`) is the reconcile net.
 *
 * Kept in a sibling module so the (grandfathered, over-ceiling) branch service
 * adds only the call site, not this logic.
 */

import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import {
  branchProjection,
  pullRequestProjection,
  searchIndexService,
} from "@/app/search/search-index-service";

/** The minimal branch-with-detail shape these hooks read. */
type IndexableBranchArtifact = {
  id: string;
  organizationId: string;
  updatedAt: Date;
  branch: {
    branchName: string;
    baseBranch: string | null;
    repositoryFullName: string;
  } | null;
  // PullRequestDetail has no updatedAt column of its own; the PR row inherits the
  // branch artifact's updatedAt as its freshness proxy.
  pullRequest: {
    id: string;
    title: string | null;
    body: string | null;
  } | null;
};

/**
 * Fail-open index a branch and (when present) its current pull request into the
 * search projection after the branch upsert committed.
 *
 * The whole body is wrapped so a projection failure — including a synchronous
 * throw while BUILDING the projection args from a partial/legacy artifact shape
 * (e.g. a branch row missing `repositoryFullName`) — can never propagate into
 * the authoritative branch write. `searchIndexService.indexAfterCommit` only
 * fail-opens its own async `waitUntil` task, so the synchronous projection
 * construction here needs its own guard to honor the "never blocks or fails the
 * branch write" contract.
 */
export function indexBranchArtifactAfterCommit(
  artifact: IndexableBranchArtifact
): void {
  try {
    if (artifact.branch) {
      searchIndexService.indexAfterCommit(
        branchProjection({
          artifactId: artifact.id,
          organizationId: artifact.organizationId,
          title: artifact.branch.branchName,
          body: branchSearchBody(
            artifact.branch.repositoryFullName,
            artifact.branch.baseBranch
          ),
          updatedAt: artifact.updatedAt,
        })
      );
    }
    if (artifact.pullRequest) {
      searchIndexService.indexAfterCommit(
        pullRequestProjection({
          id: artifact.pullRequest.id,
          organizationId: artifact.organizationId,
          title: artifact.pullRequest.title,
          body: artifact.pullRequest.body,
          // A PR routes to its owning branch (this branch artifact). The PR
          // detail has no updatedAt of its own, so mirror the branch artifact's.
          branchArtifactId: artifact.id,
          updatedAt: artifact.updatedAt,
        })
      );
    }
  } catch (error) {
    log.error("branch_search_index_after_commit_failed", {
      organizationId: artifact.organizationId,
      artifactId: artifact.id,
      error: parseError(error),
    });
  }
}

/**
 * Build a branch's searchable body from its repo full name and base branch.
 * Returns null when neither is present. Mirrors the backfill's `branchSearchBody`
 * so the write-hook and backfill produce identical bodies.
 */
function branchSearchBody(
  repositoryFullName: string | null | undefined,
  baseBranch: string | null | undefined
): string | null {
  const parts = [repositoryFullName, baseBranch].filter(
    (p): p is string => typeof p === "string" && p.length > 0
  );
  return parts.length > 0 ? parts.join(" ") : null;
}
