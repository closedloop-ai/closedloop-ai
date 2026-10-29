import type { Octokit } from "@octokit/rest";
import { BranchIdentityAvailability } from "@repo/api/src/types/branch-identity";
import { z } from "zod";

const COMMITS_PER_PAGE = 100;
const MAX_COMMIT_PAGES = 3;
const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const commitSchema = z.object({ sha: z.string().regex(SHA_RE) });

export type BranchPushCommitEvidence = {
  commitShas: string[];
  availability: BranchIdentityAvailability;
};

/** The PR's base repository and number, not the Branch's head repository. */
export type AssociatedPullRequestRef = {
  owner: string;
  repo: string;
  number: number;
};

/**
 * Enumerate bounded PR and live-ref commits whose check suites may identify
 * historical Branch pushes. A full page never proves all pushes were found.
 */
export async function getBranchPushCommitShas(
  octokit: Pick<Octokit, "rest">,
  input: {
    owner: string;
    repo: string;
    branchName: string;
    pullRequests: readonly AssociatedPullRequestRef[];
  }
): Promise<BranchPushCommitEvidence> {
  const shas = new Set<string>();
  let successfulRead = false;
  for (const pullRequest of input.pullRequests) {
    const read = await collectCommitPages(
      (page) =>
        octokit.rest.pulls.listCommits({
          owner: pullRequest.owner,
          repo: pullRequest.repo,
          pull_number: pullRequest.number,
          per_page: COMMITS_PER_PAGE,
          page,
        }),
      shas
    );
    successfulRead ||= read;
  }
  const liveRefRead = await collectCommitPages(
    (page) =>
      octokit.rest.repos.listCommits({
        owner: input.owner,
        repo: input.repo,
        sha: input.branchName,
        per_page: COMMITS_PER_PAGE,
        page,
      }),
    shas
  );
  successfulRead ||= liveRefRead;
  return {
    commitShas: [...shas],
    availability: successfulRead
      ? BranchIdentityAvailability.Incomplete
      : BranchIdentityAvailability.Unavailable,
  };
}

async function collectCommitPages(
  readPage: (page: number) => Promise<{ data: unknown }>,
  shas: Set<string>
): Promise<boolean> {
  let successfulRead = false;
  for (let page = 1; page <= MAX_COMMIT_PAGES; page++) {
    let raw: unknown;
    try {
      raw = (await readPage(page)).data;
    } catch {
      break;
    }
    if (!Array.isArray(raw)) {
      break;
    }
    successfulRead = true;
    for (const item of raw) {
      const parsed = commitSchema.safeParse(item);
      if (parsed.success) {
        shas.add(parsed.data.sha.toLowerCase());
      }
    }
    if (raw.length < COMMITS_PER_PAGE) {
      break;
    }
  }
  return successfulRead;
}
