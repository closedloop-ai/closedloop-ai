import type {
  GetPullRequestsResponse,
  GitHubPullRequestSummary,
  GitHubPullRequestTrackingScope,
} from "@repo/api/src/types/github";
import { gitHubConfirmedHeadBranch } from "@repo/api/src/types/pull-request-github-head";
import {
  normalizePersistedRepositoryDefaultAuthority,
  repositoryDefaultProvenanceValidator,
  repositoryDefaultUnavailableObservationValidator,
} from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { GitHubInstallationStatus, type Prisma, withDb } from "@repo/database";
import { findVerifiedObservedRepository } from "./service/observed-repository-read";
import { getTrackedPullRequestState } from "./tracked-pull-requests";

/**
 * PLN-1535 M3.1: serve the repository pull-requests read route from the cloud
 * projection (PullRequestDetail) instead of a live GitHub GraphQL call. The
 * projection is the SSOT (PLN-1535 D2), so this read carries NO GraphQL cost —
 * eliminating the getPullRequests-route drain that dominates steady-state read
 * cost. The default read lane since ISS-8049 retired the
 * `github-projection-reads` flag; the route falls back to the live read for an
 * id this lane cannot resolve, and for a resolvable repo whose projection is
 * still empty (coverage not yet caught up).
 *
 * PR-only: the branches route deliberately stays on live GraphQL (PLN-1535 M3
 * owner decision) because it isn't the cost driver and no projection carries a
 * complete, recency-ordered view of a repository's refs to serve it from — the
 * whole list, not just the default branch, is a functional dependency of the
 * job-repositories picker (use-default-branches → submit gate + per-row branch
 * override). That route's own header (ISS-8156) carries the full reason.
 *
 * The list is "tracked-only": only PRs Symphony has PROJECTED (webhook / backfill
 * / reconciler), narrower than the live "all PRs" list.
 *
 * ISS-8155 stopped this read GUESSING the three fields this header used to list
 * as display-only gaps. `baseBranch` and `author` come from the PR's OWN columns
 * (base_ref_name, author_login), not the owning Branch's current base and a
 * literal "unknown"; `checksStatus` stays the branch head's rollup, which IS this
 * PR's while it is the branch's current PR and nothing once it is superseded. An
 * unfilled column serves the ABSENT form ("" for a ref or login, null for a
 * rollup) for the surface to render as unknown — never a neighbouring row's
 * value, never an invented one, and never a fall-through to GitHub.
 *
 * It does NOT claim every row is filled. `base_ref_name` has no backfill (see the
 * migration for why deriving one from the Branch was unsound). ISS-8175 gave the
 * desktop-sync lane a base for PRs the desktop itself OPENED (gh's own create
 * output, carried as the ref's optional `baseRef`). A PR no desktop session ever
 * created still has none and permanently cannot — a local clone cannot know a
 * foreign PR's base. So those rows, and historical ones from desktops that
 * predate the field, read as unknown until a GitHub producer re-projects them.
 *
 * headBranch (ISS-6584) serves the provider's own head ref (head_ref_name,
 * ISS-6541) so it agrees with the live mapper's node.headRefName. It falls back
 * to the owning Branch's CURRENT name where that column is still null, which is
 * NOT only pre-ISS-6541 rows: the authority writer fills it only for an
 * Available+Complete head-repository observation, and the ISS-6541 pair-guard
 * trigger clears it when head_ref_oid moves outside an authority generation. That
 * fallback diverges from the provider after a GitHub rename or on a multi-PR
 * branch, and Desktop keys its cloud PR overlays by headBranch, so the residue is
 * a dropped overlay rather than a mislabelled row — unlike the gaps above, not
 * display-only. Serving "" instead would strip that key from every row the
 * projection has not filled yet, so the fallback stays until it is filled for
 * every identifiable PR.
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
  headRefName: true,
  baseRefName: true,
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
  repositoryFullName: true,
  repository: { select: { fullName: true } },
  branchArtifact: {
    select: {
      branch: {
        select: {
          branchName: true,
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
  repository: ProjectionRepositorySelector,
  organizationId: string,
  options: { limit: number; targetNumbers: readonly number[] }
): Promise<ProjectionPullRequestReadResult> {
  const { limit, targetNumbers } = options;
  const repositoryWhere = projectionRepositoryWhere(repository);
  const primary = await withDb((db) =>
    db.pullRequestDetail.findMany({
      where: {
        ...repositoryWhere,
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
              ...repositoryWhere,
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
  // ISS-8153 exemption (pull-request-population-declaration allowlist): a
  // POINTER-scoped attach, not a population read — branch.checksStatus
  // describes the branch's CURRENT head, so only the pointed row may carry it.
  // A heal-window branch (no pointer yet) serves checksStatus null, which is
  // honest: its checks are unknown until promotion points at the row.
  const isCurrentPr = branch?.currentPullRequestDetailId === row.id;
  const headRepository = mapPersistedHeadRepository(row);
  const gitHubHeadBranch = gitHubConfirmedHeadBranch({
    headBranch: row.headRefName,
    headRepositoryFullName: row.headRepositoryFullName,
    repositoryFullName: row.repositoryFullName ?? row.repository?.fullName,
  });
  return {
    // githubId/htmlUrl are guaranteed non-null by identifiablePullRequestWhere;
    // the `?? ""` only satisfies the nullable column type.
    githubId: row.githubId ?? "",
    number: row.number,
    title: row.title ?? "",
    htmlUrl: row.htmlUrl ?? "",
    // The provider's own head ref, matching the live mapper's node.headRefName.
    // The Branch's CURRENT name is a floor for rows head_ref_name is still null
    // on, not parity with the live mapper — see the header for when that happens.
    headBranch: row.headRefName ?? branch?.branchName ?? "",
    // ISS-8155: this PR's own base ref, NOT the owning Branch's baseBranch —
    // that tracks the branch's CURRENT target, so it reported the newer base on
    // every historical PR of a reused branch.
    baseBranch: row.baseRefName ?? "",
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
    // ISS-8155: no author_login means no measured author. "unknown" is a login a
    // real account can hold, so serving it made an absence indistinguishable from
    // a measurement; both producers now serve the absent form instead.
    author: row.authorLogin ?? "",
    // checksStatus reflects the branch's CURRENT head, so it is only meaningful
    // for the branch's current PR; a superseded/closed PR reports null.
    //
    // ISS-8241 asked the stricter question on the BRANCH DETAIL and answers it
    // differently: there the rollup is served only while `checks_detail_head_sha`
    // equals that PR's own `head_ref_oid`, because a check run belongs to a
    // COMMIT and the pointer alone still admits a rollup measured at a head the
    // current PR has since moved past. This row keeps the pointer rule
    // deliberately — it is a tracked-PR LIST whose per-row `headSha` is the PR's
    // last projected head rather than the head the rollup was taken at, so the
    // stricter predicate would need a column this read does not select, and the
    // weaker answer here is the one ISS-8155 shipped behind
    // `pull-request-row-projection-fields`. Tighten this only with that flag's
    // rollout in hand; do not assume the two surfaces already agree.
    checksStatus: isCurrentPr ? (branch?.checksStatus ?? null) : null,
    reviewDecision: row.reviewDecision,
    ...headRepository,
    ...(gitHubHeadBranch === undefined ? {} : { gitHubHeadBranch }),
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
 *
 * Returns `null` for an id THIS lane cannot resolve — unknown, cross-org,
 * removed, or suspended-installation — and the caller falls through to the live
 * lane, which owns the not-found verdict and still raises "Repository not
 * found". It does not collapse "unavailable" into an empty list, which is what
 * the original throw existed to prevent.
 *
 * ISS-8049 extended resolution to the observed lane: an installation-free org's
 * repository ids belong to `github_observed_repository`, and its projected PR
 * rows are the repo-less kind (PLN-1775 M5: `repository_id IS NULL`, keyed on
 * the NORMALIZED `repository_full_name`), so a verified observation row routes
 * to the same projection read through the repo-less selector — previously those
 * orgs always paid the live GitHub paging path, which on a large repo can run
 * past the desktop's 10s hydration budget and dark its Branches lane.
 */
export async function serveRepositoryPullRequestsFromProjection(
  repositoryId: string,
  organizationId: string,
  projectId: string | null,
  limit: number,
  trackingScope?: GitHubPullRequestTrackingScope
): Promise<GetPullRequestsResponse | null> {
  const resolved = await resolveProjectionRepository(
    repositoryId,
    organizationId
  );
  if (!resolved) {
    return null;
  }
  const tracked = await getTrackedPullRequestState({
    organizationId,
    projectId,
    repositoryFullName: resolved.trackedRepositoryFullName,
    repositoryId: resolved.trackedRepositoryId,
    ...(trackingScope ? { trackingScope } : {}),
  });
  const projection = await readRepositoryPullRequestsFromProjection(
    resolved.selector,
    organizationId,
    { limit, targetNumbers: tracked.trackedPrNumbers }
  );
  return {
    pullRequests: projection.pullRequests,
    hasMore: projection.hasMore,
    truncated: projection.truncated,
    missingTargetNumbers: projection.missingTargetNumbers,
    ...(tracked.targetDiscoveryTruncated
      ? { targetDiscoveryTruncated: true }
      : {}),
    trackedPrUrls: tracked.trackedPrUrls,
    trackedBranches: tracked.trackedBranches,
    trackedBranchKeys: tracked.trackedBranchKeys,
  };
}

/**
 * Which projection rows belong to the requested repository. Installation repos
 * key on `repository_id`; the observed lane's rows are repo-less (PLN-1775 M5)
 * and key on the NORMALIZED `repository_full_name` with `repository_id IS NULL`
 * — without the null pin, an installation row for the same name would satisfy
 * the query and double-serve.
 */
export type ProjectionRepositorySelector =
  | { repositoryId: string }
  | { repositoryFullName: string; repositoryId: null };

function projectionRepositoryWhere(
  repository: ProjectionRepositorySelector
): Prisma.PullRequestDetailWhereInput {
  if (repository.repositoryId !== null) {
    return { repositoryId: repository.repositoryId };
  }
  return {
    repositoryFullName: repository.repositoryFullName,
    repositoryId: null,
  };
}

type ResolvedProjectionRepository = {
  selector: ProjectionRepositorySelector;
  /** Provider casing for tracked-PR state (branch keys, PR URL matching). */
  trackedRepositoryFullName: string;
  /** Installation row id, or null for the repo-less observed lane. */
  trackedRepositoryId: string | null;
};

/**
 * Resolve the route's repository id against the installation table first, then
 * the verified observed lane. `null` means neither lane owns the id — unknown,
 * cross-org, removed, suspended installation, or an unverified observation —
 * and the caller falls through to the live lane, which owns the not-found
 * verdict.
 */
async function resolveProjectionRepository(
  repositoryId: string,
  organizationId: string
): Promise<ResolvedProjectionRepository | null> {
  const installationRepository = await withDb((db) =>
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
  if (installationRepository) {
    return {
      selector: { repositoryId },
      trackedRepositoryFullName: installationRepository.fullName,
      trackedRepositoryId: repositoryId,
    };
  }
  // The live lane's resolver, so both lanes share ONE usable-row bar: a
  // Verified row missing its identity verification writes (owner, name,
  // githubRepoId, isPrivate) is dropped as corrupt there, and serving it from
  // the projection here would let the two lanes disagree about the same id
  // (PR #6037 review). A drop returns null, and the live lane owns the
  // not-found verdict.
  const observedRepository = await findVerifiedObservedRepository(
    repositoryId,
    organizationId
  );
  if (!observedRepository) {
    return null;
  }
  return {
    selector: {
      repositoryFullName: observedRepository.repositoryFullName,
      repositoryId: null,
    },
    trackedRepositoryFullName: observedRepository.fullName,
    trackedRepositoryId: null,
  };
}
