import type { Octokit } from "@octokit/rest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPullRequest,
  findOpenPullRequestForHeadBranch,
  GitHubPullRequestAmbiguousHeadBranchError,
  getPullRequest,
  getRepositoryDefaultBranch,
  updatePullRequest,
  verifyRepositoryBranchExists,
} from "../pull-request-write";

const OWNER = "closedloop-ai";
const REPO = "closedloop-ai";
const HEAD_BRANCH = "feature/no-gh-pr-create";
const BASE_BRANCH = "main";
const PR_URL = "https://github.com/closedloop-ai/closedloop-ai/pull/42";

const reposGet = vi.fn();
const reposGetBranch = vi.fn();
const pullsList = vi.fn();
const pullsCreate = vi.fn();
const pullsGet = vi.fn();
const pullsUpdate = vi.fn();

function makeOctokit(): Octokit {
  return {
    rest: {
      repos: {
        get: reposGet,
        getBranch: reposGetBranch,
      },
      pulls: {
        list: pullsList,
        create: pullsCreate,
        get: pullsGet,
        update: pullsUpdate,
      },
    },
  } as unknown as Octokit;
}

describe("pull-request-write helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads the repository default branch", async () => {
    reposGet.mockResolvedValue({ data: { default_branch: BASE_BRANCH } });

    await expect(
      getRepositoryDefaultBranch(makeOctokit(), { owner: OWNER, repo: REPO })
    ).resolves.toBe(BASE_BRANCH);
    expect(reposGet).toHaveBeenCalledWith({ owner: OWNER, repo: REPO });
  });

  it("verifies a branch and returns false only for 404", async () => {
    reposGetBranch.mockResolvedValueOnce({ data: { name: HEAD_BRANCH } });

    await expect(
      verifyRepositoryBranchExists(makeOctokit(), {
        owner: OWNER,
        repo: REPO,
        branch: HEAD_BRANCH,
      })
    ).resolves.toBe(true);
    expect(reposGetBranch).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      branch: HEAD_BRANCH,
    });

    reposGetBranch.mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), { status: 404 })
    );
    await expect(
      verifyRepositoryBranchExists(makeOctokit(), {
        owner: OWNER,
        repo: REPO,
        branch: HEAD_BRANCH,
      })
    ).resolves.toBe(false);

    reposGetBranch.mockRejectedValueOnce(
      Object.assign(new Error("Forbidden"), { status: 403 })
    );
    await expect(
      verifyRepositoryBranchExists(makeOctokit(), {
        owner: OWNER,
        repo: REPO,
        branch: HEAD_BRANCH,
      })
    ).rejects.toThrow("Forbidden");
  });

  it("finds an existing open pull request by owner-qualified head", async () => {
    pullsList.mockResolvedValue({
      data: [
        {
          number: 42,
          html_url: "https://github.com/closedloop-ai/closedloop-ai/pull/42",
        },
      ],
    });

    await expect(
      findOpenPullRequestForHeadBranch(makeOctokit(), {
        owner: OWNER,
        repo: REPO,
        headOwner: OWNER,
        headBranch: HEAD_BRANCH,
        baseBranch: BASE_BRANCH,
      })
    ).resolves.toEqual({
      number: 42,
      url: "https://github.com/closedloop-ai/closedloop-ai/pull/42",
    });
    expect(pullsList).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      state: "open",
      head: `${OWNER}:${HEAD_BRANCH}`,
      base: BASE_BRANCH,
      per_page: 2,
    });
  });

  it("rejects ambiguous open pull requests for a head branch", async () => {
    pullsList.mockResolvedValue({
      data: [{ number: 42 }, { number: 43 }],
    });

    await expect(
      findOpenPullRequestForHeadBranch(makeOctokit(), {
        owner: OWNER,
        repo: REPO,
        headOwner: OWNER,
        headBranch: HEAD_BRANCH,
      })
    ).rejects.toBeInstanceOf(GitHubPullRequestAmbiguousHeadBranchError);
  });

  it("creates, reads, and updates pull requests with user-token REST calls", async () => {
    pullsCreate.mockResolvedValue({
      data: {
        number: 42,
        html_url: "https://github.com/closedloop-ai/closedloop-ai/pull/42",
      },
    });
    pullsGet.mockResolvedValue({
      data: {
        number: 42,
        html_url: "https://github.com/closedloop-ai/closedloop-ai/pull/42",
      },
    });
    pullsUpdate.mockResolvedValue({
      data: {
        number: 42,
        html_url: "https://github.com/closedloop-ai/closedloop-ai/pull/42",
      },
    });

    await expect(
      createPullRequest(makeOctokit(), {
        owner: OWNER,
        repo: REPO,
        head: HEAD_BRANCH,
        base: BASE_BRANCH,
        title: "Retire gh",
        body: "Server-backed PR creation",
      })
    ).resolves.toEqual({
      number: 42,
      url: "https://github.com/closedloop-ai/closedloop-ai/pull/42",
    });
    expect(pullsCreate).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      head: HEAD_BRANCH,
      base: BASE_BRANCH,
      title: "Retire gh",
      body: "Server-backed PR creation",
    });

    await expect(
      getPullRequest(makeOctokit(), {
        owner: OWNER,
        repo: REPO,
        pullNumber: 42,
      })
    ).resolves.toEqual({
      number: 42,
      url: "https://github.com/closedloop-ai/closedloop-ai/pull/42",
    });
    expect(pullsGet).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      pull_number: 42,
    });

    await expect(
      updatePullRequest(makeOctokit(), {
        owner: OWNER,
        repo: REPO,
        pullNumber: 42,
        title: "Retire gh from Desktop",
      })
    ).resolves.toEqual({
      number: 42,
      url: "https://github.com/closedloop-ai/closedloop-ai/pull/42",
    });
    expect(pullsUpdate).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      pull_number: 42,
      title: "Retire gh from Desktop",
    });
  });

  it("returns null when no open pull request matches the head branch", async () => {
    pullsList.mockResolvedValue({ data: [] });

    await expect(
      findOpenPullRequestForHeadBranch(makeOctokit(), {
        owner: OWNER,
        repo: REPO,
        headOwner: OWNER,
        headBranch: HEAD_BRANCH,
      })
    ).resolves.toBeNull();
    expect(pullsList).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      state: "open",
      head: `${OWNER}:${HEAD_BRANCH}`,
      per_page: 2,
    });
  });

  it("carries head and base branch names from every pull request read and write", async () => {
    const data = {
      number: 42,
      html_url: PR_URL,
      head: { ref: HEAD_BRANCH },
      base: { ref: BASE_BRANCH },
    };
    const expected = {
      number: 42,
      url: PR_URL,
      headBranch: HEAD_BRANCH,
      baseBranch: BASE_BRANCH,
    };
    pullsList.mockResolvedValue({ data: [data] });
    pullsCreate.mockResolvedValue({ data });
    pullsGet.mockResolvedValue({ data });
    pullsUpdate.mockResolvedValue({ data });

    await expect(
      findOpenPullRequestForHeadBranch(makeOctokit(), {
        owner: OWNER,
        repo: REPO,
        headOwner: OWNER,
        headBranch: HEAD_BRANCH,
      })
    ).resolves.toEqual(expected);
    await expect(
      createPullRequest(makeOctokit(), {
        owner: OWNER,
        repo: REPO,
        head: HEAD_BRANCH,
        base: BASE_BRANCH,
        title: "t",
        body: "b",
      })
    ).resolves.toEqual(expected);
    await expect(
      getPullRequest(makeOctokit(), {
        owner: OWNER,
        repo: REPO,
        pullNumber: 42,
      })
    ).resolves.toEqual(expected);
    await expect(
      updatePullRequest(makeOctokit(), {
        owner: OWNER,
        repo: REPO,
        pullNumber: 42,
        title: "t",
      })
    ).resolves.toEqual(expected);
  });

  it("omits branch names when the provider returns null or empty refs", async () => {
    pullsGet.mockResolvedValue({
      data: {
        number: 42,
        html_url: PR_URL,
        head: null,
        base: { ref: "" },
      },
    });

    await expect(
      getPullRequest(makeOctokit(), {
        owner: OWNER,
        repo: REPO,
        pullNumber: 42,
      })
    ).resolves.toStrictEqual({ number: 42, url: PR_URL });
  });

  it("sends only the fields given when updating, and both when given both", async () => {
    pullsUpdate.mockResolvedValue({ data: { number: 42, html_url: PR_URL } });

    await updatePullRequest(makeOctokit(), {
      owner: OWNER,
      repo: REPO,
      pullNumber: 42,
      body: "new body",
    });
    expect(pullsUpdate.mock.lastCall?.[0]).toStrictEqual({
      owner: OWNER,
      repo: REPO,
      pull_number: 42,
      body: "new body",
    });

    await updatePullRequest(makeOctokit(), {
      owner: OWNER,
      repo: REPO,
      pullNumber: 42,
      title: "only title",
    });
    expect(pullsUpdate.mock.lastCall?.[0]).toStrictEqual({
      owner: OWNER,
      repo: REPO,
      pull_number: 42,
      title: "only title",
    });

    await updatePullRequest(makeOctokit(), {
      owner: OWNER,
      repo: REPO,
      pullNumber: 42,
      title: "new title",
      body: "new body",
    });
    expect(pullsUpdate).toHaveBeenLastCalledWith({
      owner: OWNER,
      repo: REPO,
      pull_number: 42,
      title: "new title",
      body: "new body",
    });
  });
});
