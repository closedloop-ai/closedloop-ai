import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { describe, expect, it, vi } from "vitest";
import {
  BranchPushTransitionState,
  readReportedPushAccount,
  verifyBranchPushTransition,
} from "../branch-push-transition";

const BEFORE_SHA = "a".repeat(40);
const AFTER_SHA = "b".repeat(40);
const input = {
  owner: "closedloop-ai",
  repo: "closedloop-ai",
  beforeSha: BEFORE_SHA,
  afterSha: AFTER_SHA,
};

describe("verifyBranchPushTransition", () => {
  it("qualifies an added commit and refuses a pure rewind", async () => {
    const compareCommitsWithBasehead = vi
      .fn()
      .mockResolvedValueOnce({ data: { ahead_by: 2 } })
      .mockResolvedValueOnce({ data: { ahead_by: 0 } });
    const octokit = {
      rest: { repos: { compareCommitsWithBasehead } },
    } as never;

    await expect(verifyBranchPushTransition(octokit, input)).resolves.toBe(
      BranchPushTransitionState.NewCommits
    );
    await expect(verifyBranchPushTransition(octokit, input)).resolves.toBe(
      BranchPushTransitionState.NoNewCommits
    );
    expect(compareCommitsWithBasehead).toHaveBeenCalledWith({
      owner: input.owner,
      repo: input.repo,
      basehead: `${BEFORE_SHA}...${AFTER_SHA}`,
      per_page: 1,
    });
  });

  it("compares a new ref against the default branch before accepting it", async () => {
    const get = vi.fn().mockResolvedValue({ data: { default_branch: "main" } });
    const compareCommitsWithBasehead = vi
      .fn()
      .mockResolvedValueOnce({ data: { ahead_by: 1 } })
      .mockResolvedValueOnce({ data: { ahead_by: 0 } });
    const octokit = {
      rest: { repos: { compareCommitsWithBasehead, get } },
    } as never;

    await expect(
      verifyBranchPushTransition(octokit, {
        ...input,
        beforeSha: "0".repeat(40),
      })
    ).resolves.toBe(BranchPushTransitionState.NewCommits);
    await expect(
      verifyBranchPushTransition(octokit, {
        ...input,
        beforeSha: "0".repeat(40),
      })
    ).resolves.toBe(BranchPushTransitionState.NoNewCommits);
    expect(get).toHaveBeenCalledTimes(2);
    expect(compareCommitsWithBasehead).toHaveBeenNthCalledWith(1, {
      owner: input.owner,
      repo: input.repo,
      basehead: `main...${AFTER_SHA}`,
      per_page: 1,
    });
    expect(compareCommitsWithBasehead).toHaveBeenNthCalledWith(2, {
      owner: input.owner,
      repo: input.repo,
      basehead: `main...${AFTER_SHA}`,
      per_page: 1,
    });
  });

  it("refuses deletion or no-op without comparing", async () => {
    const get = vi.fn();
    const compareCommitsWithBasehead = vi.fn();
    const octokit = {
      rest: { repos: { compareCommitsWithBasehead, get } },
    } as never;

    await expect(
      verifyBranchPushTransition(octokit, {
        ...input,
        afterSha: "0".repeat(40),
      })
    ).resolves.toBe(BranchPushTransitionState.Unavailable);
    await expect(
      verifyBranchPushTransition(octokit, {
        ...input,
        afterSha: BEFORE_SHA,
      })
    ).resolves.toBe(BranchPushTransitionState.NoNewCommits);
    expect(get).not.toHaveBeenCalled();
    expect(compareCommitsWithBasehead).not.toHaveBeenCalled();
  });

  it("does not claim a commit when comparison fails or returns bad data", async () => {
    const compareCommitsWithBasehead = vi
      .fn()
      .mockRejectedValueOnce(new Error("commit unreachable"))
      .mockResolvedValueOnce({ data: { ahead_by: Number.NaN } });
    const octokit = {
      rest: { repos: { compareCommitsWithBasehead } },
    } as never;

    await expect(verifyBranchPushTransition(octokit, input)).resolves.toBe(
      BranchPushTransitionState.Unavailable
    );
    await expect(verifyBranchPushTransition(octokit, input)).resolves.toBe(
      BranchPushTransitionState.Unavailable
    );
  });
});

describe("readReportedPushAccount", () => {
  it("uses the immutable REST account ID and preserves the provider's actor kind", async () => {
    const request = vi.fn().mockResolvedValue({
      data: { id: 123, login: "renamed-alice", type: GitHubActorType.User },
    });

    await expect(
      readReportedPushAccount({ request } as never, "123")
    ).resolves.toEqual({
      providerUserId: "123",
      providerLogin: "renamed-alice",
      actorType: GitHubActorType.User,
    });
    expect(request).toHaveBeenCalledWith("GET /user/{account_id}", {
      account_id: 123,
    });
  });

  it("returns a bot classification without promoting it to a human", async () => {
    const request = vi.fn().mockResolvedValue({
      data: { id: 123, login: "automation", type: GitHubActorType.Bot },
    });

    await expect(
      readReportedPushAccount({ request } as never, "123")
    ).resolves.toMatchObject({ actorType: GitHubActorType.Bot });
  });

  it("rejects a ghost, mismatched, missing, or unsafe account ID", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        data: { id: 123, login: "ghost", type: GitHubActorType.User },
      })
      .mockResolvedValueOnce({
        data: { id: 999, login: "other", type: GitHubActorType.User },
      })
      .mockRejectedValueOnce(new Error("account removed"));

    await expect(
      readReportedPushAccount({ request } as never, "123")
    ).resolves.toBeNull();
    await expect(
      readReportedPushAccount({ request } as never, "123")
    ).resolves.toBeNull();
    await expect(
      readReportedPushAccount({ request } as never, "123")
    ).resolves.toBeNull();
    await expect(
      readReportedPushAccount({ request } as never, "9007199254740993")
    ).resolves.toBeNull();
    expect(request).toHaveBeenCalledTimes(3);
  });
});
