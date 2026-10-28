import { BranchIdentityAvailability } from "@repo/api/src/types/branch-identity";
import { describe, expect, it, vi } from "vitest";
import { getBranchPushCommitShas } from "../branch-push-commit-shas";

const PR_SHA = "a".repeat(40);
const LIVE_SHA = "b".repeat(40);
const input = {
  owner: "closedloop-ai",
  repo: "closedloop-ai",
  branchName: "feature/collaborators",
  pullRequests: [
    { owner: "closedloop-ai", repo: "closedloop-ai", number: 5133 },
    { owner: "other-base", repo: "another-repo", number: 7338 },
  ],
};

describe("getBranchPushCommitShas", () => {
  it("collects both historical PR commits and live-ref history without duplicates", async () => {
    const listCommits = vi.fn().mockResolvedValue({
      data: [{ sha: PR_SHA }, { sha: LIVE_SHA }],
    });
    const listLiveCommits = vi.fn().mockResolvedValue({
      data: [{ sha: LIVE_SHA }],
    });
    const octokit = {
      rest: {
        pulls: { listCommits },
        repos: { listCommits: listLiveCommits },
      },
    } as never;

    const result = await getBranchPushCommitShas(octokit, input);

    expect(result).toEqual({
      commitShas: [PR_SHA, LIVE_SHA],
      availability: BranchIdentityAvailability.Incomplete,
    });
    expect(listCommits).toHaveBeenCalledWith({
      owner: input.owner,
      repo: input.repo,
      pull_number: 5133,
      per_page: 100,
      page: 1,
    });
    expect(listCommits).toHaveBeenCalledWith({
      owner: "other-base",
      repo: "another-repo",
      pull_number: 7338,
      per_page: 100,
      page: 1,
    });
    expect(listLiveCommits).toHaveBeenCalledWith({
      owner: input.owner,
      repo: input.repo,
      sha: input.branchName,
      per_page: 100,
      page: 1,
    });
  });

  it("keeps recovered PR commits when the live ref is deleted", async () => {
    const listCommits = vi.fn().mockResolvedValue({ data: [{ sha: PR_SHA }] });
    const listLiveCommits = vi.fn().mockRejectedValue(new Error("ref deleted"));
    const octokit = {
      rest: {
        pulls: { listCommits },
        repos: { listCommits: listLiveCommits },
      },
    } as never;

    const result = await getBranchPushCommitShas(octokit, input);

    expect(result.commitShas).toEqual([PR_SHA]);
    expect(result.availability).toBe(BranchIdentityAvailability.Incomplete);
  });

  it("marks a fully unreadable scan unavailable", async () => {
    const listCommits = vi.fn().mockRejectedValue(new Error("denied"));
    const octokit = {
      rest: {
        pulls: { listCommits },
        repos: { listCommits },
      },
    } as never;

    const result = await getBranchPushCommitShas(octokit, input);

    expect(result).toEqual({
      commitShas: [],
      availability: BranchIdentityAvailability.Unavailable,
    });
  });

  it("pages a full commit response and never treats its cap as complete", async () => {
    const firstPage = Array.from({ length: 100 }, () => ({ sha: PR_SHA }));
    const listCommits = vi
      .fn()
      .mockResolvedValueOnce({ data: firstPage })
      .mockResolvedValueOnce({ data: [{ sha: LIVE_SHA }] });
    const listLiveCommits = vi.fn().mockRejectedValue(new Error("ref deleted"));
    const octokit = {
      rest: {
        pulls: { listCommits },
        repos: { listCommits: listLiveCommits },
      },
    } as never;

    const result = await getBranchPushCommitShas(octokit, {
      ...input,
      pullRequests: [
        { owner: "closedloop-ai", repo: "closedloop-ai", number: 5133 },
      ],
    });

    expect(result.commitShas).toEqual([PR_SHA, LIVE_SHA]);
    expect(result.availability).toBe(BranchIdentityAvailability.Incomplete);
    expect(listCommits).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ page: 2 })
    );
  });
});
