import "server-only";
import type { Octokit } from "@octokit/rest";

export type GitHubPullRequestRepository = {
  owner: string;
  repo: string;
};

export type GitHubPullRequestRef = {
  number: number;
  url: string;
  headBranch?: string;
  baseBranch?: string;
};

export class GitHubPullRequestAmbiguousHeadBranchError extends Error {
  readonly status = 409;

  constructor(headBranch: string) {
    super(`Multiple open pull requests found for head branch ${headBranch}`);
    this.name = "GitHubPullRequestAmbiguousHeadBranchError";
  }
}

export type GitHubPullRequestCreateInput = GitHubPullRequestRepository & {
  head: string;
  base: string;
  title: string;
  body: string;
};

export type GitHubPullRequestUpdateInput = GitHubPullRequestRepository & {
  pullNumber: number;
  title?: string;
  body?: string;
};

/** Read the repository default branch with the caller-provided user credential. */
export async function getRepositoryDefaultBranch(
  octokit: Octokit,
  repository: GitHubPullRequestRepository
): Promise<string> {
  const { data } = await octokit.rest.repos.get(repository);
  return data.default_branch;
}

/** Verify a branch exists in the repository without hiding non-404 failures. */
export async function verifyRepositoryBranchExists(
  octokit: Octokit,
  input: GitHubPullRequestRepository & { branch: string }
): Promise<boolean> {
  try {
    await octokit.rest.repos.getBranch({
      owner: input.owner,
      repo: input.repo,
      branch: input.branch,
    });
    return true;
  } catch (error) {
    if (isHttpStatus(error, 404)) {
      return false;
    }
    throw error;
  }
}

/**
 * Find an open PR by head branch. GitHub's `head` filter is owner-qualified,
 * so same-repository Desktop pushes use the target owner on both sides.
 */
export async function findOpenPullRequestForHeadBranch(
  octokit: Octokit,
  input: GitHubPullRequestRepository & {
    baseBranch?: string;
    headOwner: string;
    headBranch: string;
  }
): Promise<GitHubPullRequestRef | null> {
  const { data } = await octokit.rest.pulls.list({
    owner: input.owner,
    repo: input.repo,
    state: "open",
    head: `${input.headOwner}:${input.headBranch}`,
    ...(input.baseBranch === undefined ? {} : { base: input.baseBranch }),
    per_page: 2,
  });
  if (data.length > 1) {
    throw new GitHubPullRequestAmbiguousHeadBranchError(input.headBranch);
  }
  const first = data[0];
  if (!first) {
    return null;
  }
  return {
    number: first.number,
    url: first.html_url,
    ...pullRequestBranchFields(first),
  };
}

/** Create a pull request through GitHub REST using a caller-owned user token. */
export async function createPullRequest(
  octokit: Octokit,
  input: GitHubPullRequestCreateInput
): Promise<GitHubPullRequestRef> {
  const { data } = await octokit.rest.pulls.create({
    owner: input.owner,
    repo: input.repo,
    head: input.head,
    base: input.base,
    title: input.title,
    body: input.body,
  });
  return {
    number: data.number,
    url: data.html_url,
    ...pullRequestBranchFields(data),
  };
}

/** Read pull-request identity without mutating title, body, labels, or state. */
export async function getPullRequest(
  octokit: Octokit,
  input: GitHubPullRequestRepository & { pullNumber: number }
): Promise<GitHubPullRequestRef> {
  const { data } = await octokit.rest.pulls.get({
    owner: input.owner,
    repo: input.repo,
    pull_number: input.pullNumber,
  });
  return {
    number: data.number,
    url: data.html_url,
    ...pullRequestBranchFields(data),
  };
}

/** Update pull-request text fields without replacing labels or review state. */
export async function updatePullRequest(
  octokit: Octokit,
  input: GitHubPullRequestUpdateInput
): Promise<GitHubPullRequestRef> {
  const { data } = await octokit.rest.pulls.update({
    owner: input.owner,
    repo: input.repo,
    pull_number: input.pullNumber,
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.body === undefined ? {} : { body: input.body }),
  });
  return {
    number: data.number,
    url: data.html_url,
    ...pullRequestBranchFields(data),
  };
}

function pullRequestBranchFields(input: {
  head?: { ref?: string } | null;
  base?: { ref?: string } | null;
}): Pick<GitHubPullRequestRef, "headBranch" | "baseBranch"> {
  return {
    ...(input.head?.ref ? { headBranch: input.head.ref } : {}),
    ...(input.base?.ref ? { baseBranch: input.base.ref } : {}),
  };
}

function isHttpStatus(error: unknown, status: number): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "status" in error &&
    (error as { status: unknown }).status === status
  );
}
