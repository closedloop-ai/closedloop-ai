import type {
  GetPullRequestsResponse,
  GitHubPullRequestSummary,
} from "@repo/api/src/types/github";
import {
  normalizePersistedRepositoryDefaultAuthority,
  repositoryDefaultProvenanceValidator,
  repositoryDefaultUnavailableObservationValidator,
} from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { GitHubInstallationStatus, type Prisma, withDb } from "@repo/database";
import { getTrackedPullRequestState } from "./tracked-pull-requests";

/**
 * PLN-1535 M3.1: serve the repository pull-requests read route from the cloud
 * projection (PullRequestDetail) instead of a live GitHub GraphQL call. The
 * projection is the SSOT (PLN-1535 D2), so this read carries NO GraphQL cost —
 * eliminating the getPullRequests-route drain that dominates steady-state read
 * cost. Gated behind the github-projection-reads flag (default off).
 *
 * PR-only: the branches route deliberately stays on live GraphQL (PLN-1535 M3
 * owner decision) because it isn't the cost driver and its default-branch
 * requirement — which the projection does not carry — is a functional dependency
 * of the job-repositories picker (use-default-branches → submit gate).
 *
 * The list is "tracked-only": only PRs Symphony has PROJECTED (webhook / backfill
 * / reconciler), narrower than the live "all PRs" list. Known display-only gaps,
 * deferred to M4 (when the projection is completed + a coverage stat ships) —
 * none of which feed the merged-LOC metric:
 *  - baseBranch is the parent branch's CURRENT base, so a branch reused for a
 *    later PR to a different target shows the wrong base on its historical PRs;
 *  - checksStatus is the branch head's, meaningful only for the branch's current
 *    PR (null otherwise);
 *  - author reads "unknown" until an old (pre-author_login) row is refreshed.
 */

const projectionPullRequestSelect = {
  id: true,
  githubId: true,
  number: true,
  title: true,
  htmlUrl: true,
  prState: true,
  isDraft: true,
  additions: true,
  deletions: true,
  changedFiles: true,
  closedAt: true,
  mergedAt: true,
  mergeCommitSha: true,
  githubUpdatedAt: true,
  headRefOid: true,
  headRepositoryGithubId: true,
  headRepositoryFullName: true,
  headRepositoryDefaultBranchName: true,
  headRepositoryDefaultBranchAvailability: true,
  headRepositoryDefaultBranchCompleteness: true,
  headRepositoryDefaultBranchReason: true,
  headRepositoryDefaultBranchSource: true,
  headRepositoryDefaultBranchMechanism: true,
  headRepositoryDefaultBranchTrigger: true,
  headRepositoryDefaultBranchCredentialType: true,
  headRepositoryDefaultBranchCredentialOwnerId: true,
  headRepositoryDefaultBranchObservationKey: true,
  headRepositoryDefaultBranchObservedAt: true,
  headRepositoryDefaultBranchEventAt: true,
  authorLogin: true,
  reviewDecision: true,
  branchArtifact: {
    select: {
      branch: {
        select: {
          branchName: true,
          baseBranch: true,
          checksStatus: true,
          currentPullRequestDetailId: true,
        },
      },
    },
  },
} satisfies Prisma.PullRequestDetailSelect;

type ProjectionPullRequestRow = Prisma.PullRequestDetailGetPayload<{
  select: typeof projectionPullRequestSelect;
}>;

export type ProjectionPullRequestReadResult = {
  pullRequests: GitHubPullRequestSummary[];
  hasMore: boolean;
  truncated: boolean;
  missingTargetNumbers: number[];
};

// A PR row the projection can serve as an identifiable list item. htmlUrl and
// githubId are nullable (desktop-produced rows until gh enrichment / App
// adoption); the live contract always filled them from GitHub, and the app uses
// htmlUrl as the React key + the already-linked identity + the link target. An
// unidentifiable row must be EXCLUDED, not served with an empty-string identity
// that collides on the key and links nothing (review: filter, don't manufacture).
const identifiablePullRequestWhere = {
  githubId: { not: null },
  htmlUrl: { not: null },
} satisfies Prisma.PullRequestDetailWhereInput;

/**
 * Read the repository's projected pull requests, newest update first. Mirrors the
 * live route contract: the top `limit` by update recency, plus any tracked
 * `targetNumbers` that fall outside that window (the live
 * selectRepositoryPullRequestsForList behavior), with `missingTargetNumbers` for
 * targets the projection has no identifiable row for.
 */
export async function readRepositoryPullRequestsFromProjection(
  repositoryId: string,
  organizationId: string,
  options: { limit: number; targetNumbers: readonly number[] }
): Promise<ProjectionPullRequestReadResult> {
  const { limit, targetNumbers } = options;
  const primary = await withDb((db) =>
    db.pullRequestDetail.findMany({
      where: {
        repositoryId,
        organizationId,
        ...identifiablePullRequestWhere,
      },
      select: projectionPullRequestSelect,
      orderBy: [
        { githubUpdatedAt: { sort: "desc", nulls: "last" } },
        { number: "desc" },
      ],
      // One extra row distinguishes "exactly `limit`" from "more exist".
      take: limit + 1,
    })
  );
  const hasMore = primary.length > limit;
  const page = primary.slice(0, limit);
  const pageNumbers = new Set(page.map((row) => row.number));
  const outstandingTargets = targetNumbers.filter(
    (number) => !pageNumbers.has(number)
  );
  const extraTargetRows =
    outstandingTargets.length > 0
      ? await withDb((db) =>
          db.pullRequestDetail.findMany({
            where: {
              repositoryId,
              organizationId,
              number: { in: [...outstandingTargets] },
              ...identifiablePullRequestWhere,
            },
            select: projectionPullRequestSelect,
          })
        )
      : [];
  const rows = [...page, ...extraTargetRows];
  const foundNumbers = new Set(rows.map((row) => row.number));
  return {
    pullRequests: rows.map(mapProjectionPullRequest),
    hasMore,
    // hasMore means this slice is not repository-exhaustive, so truncated must
    // track it (they cannot disagree). The broader "projection is narrower than
    // the live list" signal is the M4 coverage stat, not this bounded-read flag.
    truncated: hasMore,
    missingTargetNumbers: targetNumbers.filter(
      (number) => !foundNumbers.has(number)
    ),
  };
}

function mapProjectionPullRequest(
  row: ProjectionPullRequestRow
): GitHubPullRequestSummary {
  const branch = row.branchArtifact.branch;
  const isCurrentPr = branch?.currentPullRequestDetailId === row.id;
  const headRepository = mapPersistedHeadRepository(row);
  return {
    // githubId/htmlUrl are guaranteed non-null by identifiablePullRequestWhere;
    // the `?? ""` only satisfies the nullable column type.
    githubId: row.githubId ?? "",
    number: row.number,
    title: row.title ?? "",
    htmlUrl: row.htmlUrl ?? "",
    headBranch: branch?.branchName ?? "",
    // Parent branch's CURRENT base — a known display-only limitation (M4).
    baseBranch: branch?.baseBranch ?? "",
    headSha: row.headRefOid,
    state: row.prState,
    isDraft: row.isDraft,
    additions: row.additions,
    deletions: row.deletions,
    changedFiles: row.changedFiles,
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    mergedAt: row.mergedAt ? row.mergedAt.toISOString() : null,
    mergeCommitSha: row.mergeCommitSha,
    // Nullable watermark coalesces to "", matching the live mapper's `?? ""`.
    updatedAt: row.githubUpdatedAt ? row.githubUpdatedAt.toISOString() : "",
    // Matches the live mapper's `author ?? "unknown"` fallback for rows the
    // projection has not filled with an author yet.
    author: row.authorLogin ?? "unknown",
    // checksStatus reflects the branch's CURRENT head, so it is only meaningful
    // for the branch's current PR; a superseded/closed PR reports null.
    checksStatus: isCurrentPr ? (branch?.checksStatus ?? null) : null,
    reviewDecision: row.reviewDecision,
    ...headRepository,
  };
}

/**
 * Reconstruct the optional persisted fork-head observation without ever using
 * the selected/base repository as identity fallback.
 */
function mapPersistedHeadRepository(
  row: ProjectionPullRequestRow
): Pick<
  GitHubPullRequestSummary,
  "headRepository" | "headRepositoryUnavailable"
> {
  const authority = normalizePersistedRepositoryDefaultAuthority(
    {
      provider: VcsProviderKind.GitHub,
      providerRepositoryId: row.headRepositoryGithubId,
      fullName: row.headRepositoryFullName,
    },
    {
      defaultBranchName: row.headRepositoryDefaultBranchName,
      defaultBranchAvailability: row.headRepositoryDefaultBranchAvailability,
      defaultBranchCompleteness: row.headRepositoryDefaultBranchCompleteness,
      defaultBranchReason: row.headRepositoryDefaultBranchReason,
      defaultBranchSource: row.headRepositoryDefaultBranchSource,
      defaultBranchMechanism: row.headRepositoryDefaultBranchMechanism,
      defaultBranchTrigger: row.headRepositoryDefaultBranchTrigger,
      defaultBranchCredentialType:
        row.headRepositoryDefaultBranchCredentialType,
      defaultBranchCredentialOwnerId:
        row.headRepositoryDefaultBranchCredentialOwnerId,
      defaultBranchObservationKey:
        row.headRepositoryDefaultBranchObservationKey,
      defaultBranchObservedAt: row.headRepositoryDefaultBranchObservedAt,
      defaultBranchEventAt: row.headRepositoryDefaultBranchEventAt,
    }
  );
  if (authority?.provenance !== undefined) {
    return {
      headRepository: { ...authority, provenance: authority.provenance },
    };
  }

  const provenance = repositoryDefaultProvenanceValidator.safeParse({
    source: row.headRepositoryDefaultBranchSource,
    mechanism: row.headRepositoryDefaultBranchMechanism,
    trigger: row.headRepositoryDefaultBranchTrigger,
    credentialType: row.headRepositoryDefaultBranchCredentialType,
    ...(row.headRepositoryDefaultBranchCredentialOwnerId === null
      ? {}
      : {
          credentialOwnerId: row.headRepositoryDefaultBranchCredentialOwnerId,
        }),
    observationKey: row.headRepositoryDefaultBranchObservationKey,
    observedAt: row.headRepositoryDefaultBranchObservedAt?.toISOString(),
    ...(row.headRepositoryDefaultBranchEventAt === null
      ? {}
      : {
          eventAt: row.headRepositoryDefaultBranchEventAt.toISOString(),
        }),
  });
  if (!provenance.success) {
    return {};
  }

  const unavailable =
    repositoryDefaultUnavailableObservationValidator.safeParse({
      reason: row.headRepositoryDefaultBranchReason,
      provenance: provenance.data,
    });
  return unavailable.success
    ? { headRepositoryUnavailable: unavailable.data }
    : {};
}

/**
 * PLN-1535 M3.1: serve the pull-requests route from the projection — the whole
 * route with NO GitHub GraphQL call. Resolves the repo (org-scoped, non-tombstoned,
 * active installation) for the tracked-PR state, then reads the projected PRs.
 * Throws "Repository not found" for an unknown, cross-org, removed, or
 * suspended-installation id — matching the live path's not-found / assert-active
 * behavior rather than collapsing "unavailable" into an empty list.
 */
export async function serveRepositoryPullRequestsFromProjection(
  repositoryId: string,
  organizationId: string,
  projectId: string | null,
  limit: number
): Promise<GetPullRequestsResponse> {
  const repository = await withDb((db) =>
    db.gitHubInstallationRepository.findFirst({
      where: {
        id: repositoryId,
        removedAt: null,
        installation: {
          organizationId,
          status: GitHubInstallationStatus.ACTIVE,
        },
      },
      select: { fullName: true },
    })
  );
  if (!repository) {
    throw new Error("Repository not found");
  }
  const tracked = await getTrackedPullRequestState({
    organizationId,
    projectId,
    repositoryFullName: repository.fullName,
    repositoryId,
  });
  const projection = await readRepositoryPullRequestsFromProjection(
    repositoryId,
    organizationId,
    { limit, targetNumbers: tracked.trackedPrNumbers }
  );
  return {
    pullRequests: projection.pullRequests,
    hasMore: projection.hasMore,
    truncated: projection.truncated,
    missingTargetNumbers: projection.missingTargetNumbers,
    trackedPrUrls: tracked.trackedPrUrls,
    trackedBranches: tracked.trackedBranches,
    trackedBranchKeys: tracked.trackedBranchKeys,
  };
}
