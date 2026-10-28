import type { GitHubBundledPullRequestsObservation } from "@repo/api/src/types/github-read-model";
import { GitHubInstallationStatus, withDb } from "@repo/database";
import { GitHubReadCostRoute } from "@/lib/github/github-read-cost-log";
import { githubService } from "./service";

/**
 * Which repositories the bounded post-connect backfill sweeps, and how each
 * lane's branch/PR list is read (ISS-7721 M2).
 *
 * Split out of `backfill-service.ts` rather than grown in place: that file owns
 * the run gate, the sweep loop, and the summary, and is already past the
 * 500-line smell.
 */

export const GitHubBackfillLane = {
  Installation: "installation",
} as const;
export type GitHubBackfillLane =
  (typeof GitHubBackfillLane)[keyof typeof GitHubBackfillLane];

export type GitHubBackfillCandidate = {
  lane: typeof GitHubBackfillLane.Installation;
  /** `GitHubInstallationRepository.id` — the surrogate App-lane projection rows key on. */
  repositoryId: string;
  /** Provider casing, as the repository row recorded it. */
  fullName: string;
  owner: string;
  name: string;
};

const BRANCH_PAGE_LIMIT = 100;
const PULL_REQUEST_PAGE_LIMIT = 100;

/**
 * The repositories this org's backfill may sweep, newest-push first.
 *
 * PRD-683 P0-C retires the observed-repository fallback because it fed the
 * tier-2 repo-history genesis lane. Post-connect backfill is now App-lane only:
 * an org with no installation repositories returns no candidates rather than
 * enumerating verified observed repositories.
 */
export async function getBackfillCandidates(
  organizationId: string
): Promise<GitHubBackfillCandidate[]> {
  const installationRepositories = await withDb((db) =>
    db.gitHubInstallationRepository.findMany({
      where: {
        removedAt: null,
        installation: {
          organizationId,
          status: GitHubInstallationStatus.ACTIVE,
        },
      },
      orderBy: [
        { lastPushedAt: { sort: "desc", nulls: "last" } },
        { name: "asc" },
      ],
      // The four columns `GitHubBackfillCandidate` names. The ~20 default-branch
      // authority columns this table also carries belong to a different lane and
      // are read through it.
      select: { id: true, fullName: true, owner: true, name: true },
    })
  );
  return installationRepositories.map((repository) => ({
    lane: GitHubBackfillLane.Installation,
    repositoryId: repository.id,
    fullName: repository.fullName,
    owner: repository.owner,
    name: repository.name,
  }));
}

export type BackfillRepositoryListCounts = {
  branchCount: number;
  pullRequestCount: number;
  /**
   * Every `rateLimit` block this read observed, for the caller to hand back to
   * the drawn token's pool state. Empty on the installation lane, whose budget
   * is per-install rather than per-token. Returned rather than recorded here so
   * one repository's whole sweep feeds the pool through a single path.
   */
  observations: GitHubBundledPullRequestsObservation[];
};

/**
 * How many branches and PRs the installation repository currently reports.
 */
export function readBackfillRepositoryListCounts(input: {
  candidate: GitHubBackfillCandidate;
  organizationId: string;
}): Promise<BackfillRepositoryListCounts> {
  return readInstallationRepositoryListCounts(
    input.candidate.repositoryId,
    input.organizationId
  );
}

async function readInstallationRepositoryListCounts(
  repositoryId: string,
  organizationId: string
): Promise<BackfillRepositoryListCounts> {
  const [branches, pullRequests] = await Promise.all([
    githubService.getBranches(repositoryId, organizationId, BRANCH_PAGE_LIMIT),
    githubService.getPullRequests(
      repositoryId,
      organizationId,
      null,
      { limit: PULL_REQUEST_PAGE_LIMIT },
      GitHubReadCostRoute.Backfill
    ),
  ]);
  return {
    branchCount: branches.branches.length,
    pullRequestCount: pullRequests.pullRequests.length,
    observations: [],
  };
}
