import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import {
  type GetPullRequestsResponse,
  GitHubPullRequestTrackingScope,
  type GitHubPullRequestTrackingScope as GitHubPullRequestTrackingScopeType,
} from "@repo/api/src/types/github";
import { ArtifactType, withDb } from "@repo/database";
import { parseGitHubPullRequestUrl } from "@/app/artifact-links/pull-requests/pull-request-url";
import { branchOwnedPullRequestWhere } from "@/app/branches/branch-canonical-pull-request";
import {
  cloudBranchCanonicalPullRequestSelect,
  resolveCloudBranchCanonicalDetail,
} from "@/app/branches/branch-canonical-pull-request-cloud";
import { trackedRepositorySelector } from "./tracked-repository-selector";

/**
 * Resolve which PRs/branches a project already tracks as ExternalLinks, so the
 * repository pull-requests read can mark them and target their PR numbers. Split
 * out of the github service (PLN-1535) — it is consumed only by getPullRequests.
 */
export async function getTrackedPullRequestState(input: {
  organizationId: string;
  projectId: string | null;
  /** Provider casing: it builds the branch keys and matches tracked PR URLs. */
  repositoryFullName: string;
  /**
   * `null` is the repo-less selector (PLN-1775 M7). An installation-free org's
   * BRANCH artifacts and `PullRequestDetail` rows carry no `repositoryId` and
   * key on the NORMALIZED `repositoryFullName` instead, so the predicate has to
   * switch rather than match a null id against every repo-less row in the org.
   */
  repositoryId: string | null;
  trackingScope?: GitHubPullRequestTrackingScopeType;
}): Promise<{
  trackedPrUrls: string[];
  trackedBranches: NonNullable<GetPullRequestsResponse["trackedBranches"]>;
  trackedBranchKeys: string[];
  trackedPrNumbers: number[];
  targetDiscoveryTruncated: boolean;
}> {
  if (
    !input.projectId &&
    input.trackingScope !== GitHubPullRequestTrackingScope.Organization
  ) {
    return {
      trackedPrUrls: [],
      trackedBranches: [],
      trackedBranchKeys: [],
      trackedPrNumbers: [],
      targetDiscoveryTruncated: false,
    };
  }

  if (input.trackingScope === GitHubPullRequestTrackingScope.Organization) {
    return getOrganizationTrackedPullRequestState(input);
  }

  const existingBranches = await withDb((db) =>
    db.artifact.findMany({
      where: {
        organizationId: input.organizationId,
        projectId: input.projectId,
        type: ArtifactType.BRANCH,
        branch: trackedRepositorySelector(input),
      },
      select: {
        id: true,
        externalUrl: true,
        // Scoped to the rows this branch OWNS (ISS-8903): the canonical
        // population keys on `branchArtifactId` alone, so an unscoped candidate
        // list lets a live PR row from another repository win the arbitration.
        // `extractTrackedPullRequestNumbers` then filters that foreign URL back
        // out, and the branch's own PR — the one this read exists to mark and
        // target — is silently never tracked.
        //
        // The ownership predicate, NOT `trackedRepositorySelector`: that one
        // matches the read's own identity, which is stricter than ownership and
        // drops an App-backed branch's not-yet-adopted repo-less PR row — the
        // same silent under-read, moved to a different population.
        pullRequestDetails: {
          where: branchOwnedPullRequestWhere(input),
          select: cloudBranchCanonicalPullRequestSelect,
        },
        branch: {
          select: {
            branchName: true,
            currentPullRequestDetailId: true,
            repositoryId: true,
            repositoryFullName: true,
            repository: { select: { fullName: true } },
          },
        },
      },
    })
  );

  const trackedBranches = existingBranches.flatMap((artifact) => {
    if (!artifact.branch) {
      return [];
    }
    // ISS-8153: the tracked-PR URL is the branch's CANONICAL PR (pointer with
    // owned-set fallback), so a healing tier-2 branch whose pointer is not yet
    // promoted still marks and targets its session-linked PR.
    const canonical = resolveCloudBranchCanonicalDetail({
      id: artifact.id,
      currentPullRequestDetailId: artifact.branch.currentPullRequestDetailId,
      branch: artifact.branch,
      pullRequestDetails: artifact.pullRequestDetails,
    });
    const branchKey = `${input.repositoryFullName}:${artifact.branch.branchName}`;
    return [
      {
        branchName: artifact.branch.branchName,
        branchKey,
        htmlUrl: artifact.externalUrl ?? "",
        pullRequestUrl: canonical.detail?.htmlUrl ?? null,
      },
    ];
  });
  const trackedPrUrls = trackedBranches.flatMap((branch) =>
    branch.pullRequestUrl ? [branch.pullRequestUrl] : []
  );
  return {
    trackedPrUrls,
    trackedBranches,
    trackedBranchKeys: trackedBranches.map((branch) => branch.branchKey),
    trackedPrNumbers: extractTrackedPullRequestNumbers(
      input.repositoryFullName,
      trackedPrUrls
    ),
    targetDiscoveryTruncated: false,
  };
}

const ORGANIZATION_TRACKED_PULL_REQUEST_LIMIT = 500;

/**
 * Discover bounded associated PR targets across one authenticated org/repo.
 *
 * The raw `pullRequestDetail.findMany` below satisfies the
 * `pull-request-population-declaration` gate TRANSITIVELY, through this
 * module's branch-canonical import — the gate's declaration is file-scoped.
 * If you extract this function to its own module, the gate will (correctly)
 * fire there: bring a population declaration or a reasoned allowlist entry
 * with it.
 */
async function getOrganizationTrackedPullRequestState(input: {
  organizationId: string;
  repositoryFullName: string;
  repositoryId: string | null;
}) {
  const rows = await withDb((db) =>
    db.pullRequestDetail.findMany({
      where: {
        organizationId: input.organizationId,
        ...trackedRepositorySelector(input),
      },
      select: {
        number: true,
        htmlUrl: true,
        branchArtifact: {
          select: {
            externalUrl: true,
            branch: { select: { branchName: true } },
          },
        },
      },
      orderBy: [
        { githubUpdatedAt: { sort: "desc", nulls: "last" } },
        { number: "desc" },
      ],
      take: ORGANIZATION_TRACKED_PULL_REQUEST_LIMIT + 1,
    })
  );
  const targetDiscoveryTruncated =
    rows.length > ORGANIZATION_TRACKED_PULL_REQUEST_LIMIT;
  const bounded = rows.slice(0, ORGANIZATION_TRACKED_PULL_REQUEST_LIMIT);
  const trackedBranchesByName = new Map<
    string,
    NonNullable<GetPullRequestsResponse["trackedBranches"]>[number]
  >();
  const trackedPrNumbers: number[] = [];
  const trackedPrUrls: string[] = [];
  const seenNumbers = new Set<number>();
  for (const row of bounded) {
    if (!seenNumbers.has(row.number)) {
      seenNumbers.add(row.number);
      trackedPrNumbers.push(row.number);
    }
    if (row.htmlUrl) {
      trackedPrUrls.push(row.htmlUrl);
    }
    const branchName = row.branchArtifact.branch?.branchName;
    if (branchName && !trackedBranchesByName.has(branchName)) {
      trackedBranchesByName.set(branchName, {
        branchName,
        branchKey: `${input.repositoryFullName}:${branchName}`,
        htmlUrl: row.branchArtifact.externalUrl ?? "",
        pullRequestUrl: row.htmlUrl,
      });
    }
  }
  const trackedBranches = [...trackedBranchesByName.values()];
  return {
    trackedPrUrls,
    trackedBranches,
    trackedBranchKeys: trackedBranches.map((branch) => branch.branchKey),
    trackedPrNumbers,
    targetDiscoveryTruncated,
  };
}

/**
 * Which tracked PR URLs belong to this repository.
 *
 * Both sides are normalized because GitHub treats owner and repo as
 * case-insensitive while preserving whatever casing each producer recorded: the
 * URL's casing comes from the stored `htmlUrl`, and the name's from the
 * repository row. A mixed-case repository whose two producers disagree would
 * otherwise match nothing here and silently lose every target number, so
 * already-tracked PRs past the first page would stop being fetched — a quiet
 * under-read rather than a visible failure.
 */
export function extractTrackedPullRequestNumbers(
  repositoryFullName: string,
  trackedPrUrls: readonly string[]
): number[] {
  const canonicalName = normalizeRepoFullName(repositoryFullName);
  const seen = new Set<number>();
  const numbers: number[] = [];
  for (const url of trackedPrUrls) {
    const parsed = parseGitHubPullRequestUrl(url);
    if (
      !parsed ||
      normalizeRepoFullName(parsed.fullName) !== canonicalName ||
      seen.has(parsed.number)
    ) {
      continue;
    }
    seen.add(parsed.number);
    numbers.push(parsed.number);
  }
  return numbers;
}
