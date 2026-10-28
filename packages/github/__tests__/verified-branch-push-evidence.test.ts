import { BranchIdentityAvailability } from "@repo/api/src/types/branch-identity";
import { BranchPushContributionSource } from "@repo/api/src/types/branch-push-contribution";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  commitShas: vi.fn(),
  checkSuites: vi.fn(),
  forcePushes: vi.fn(),
  recentPushes: vi.fn(),
  account: vi.fn(),
  transition: vi.fn(),
}));

vi.mock("../branch-push-commit-shas", () => ({
  getBranchPushCommitShas: mocks.commitShas,
}));
vi.mock("../check-suite-push-evidence", () => ({
  getCheckSuitePushEvidenceForCommit: mocks.checkSuites,
}));
vi.mock("../pull-request-force-push-events", () => ({
  getPullRequestForcePushEvents: mocks.forcePushes,
}));
vi.mock("../repository-push-events", () => ({
  getRecentBranchPushEvents: mocks.recentPushes,
}));
vi.mock("../branch-push-transition", () => ({
  BranchPushTransitionState: {
    NewCommits: "new_commits",
    NoNewCommits: "no_new_commits",
    Unavailable: "unavailable",
  },
  readReportedPushAccount: mocks.account,
  verifyBranchPushTransition: mocks.transition,
}));

import { createGitHubOperationReadBudget } from "../operation-read-budget";
import { getVerifiedBranchPushEvidence } from "../verified-branch-push-evidence";

const BEFORE_SHA = "a".repeat(40);
const AFTER_SHA = "b".repeat(40);
const LATER_SHA = "c".repeat(40);
const NOW = new Date("2026-09-30T00:00:00.000Z");
const input = {
  owner: "closedloop-ai",
  repo: "closedloop-ai",
  branchName: "feature/collaborators",
  pullRequests: [
    { owner: "other-base", repo: "repo", number: 7338 },
    { owner: "closedloop-ai", repo: "closedloop-ai", number: 5133 },
  ],
  observedAt: NOW,
};

describe("getVerifiedBranchPushEvidence", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.commitShas.mockResolvedValue({
      commitShas: [AFTER_SHA],
      availability: BranchIdentityAvailability.Incomplete,
    });
    mocks.checkSuites.mockResolvedValue({
      pushes: [],
      availability: BranchIdentityAvailability.Incomplete,
    });
    mocks.forcePushes.mockResolvedValue({
      events: [],
      availability: BranchIdentityAvailability.Incomplete,
    });
    mocks.recentPushes.mockResolvedValue({
      events: [],
      availability: BranchIdentityAvailability.Incomplete,
    });
    mocks.transition.mockResolvedValue("new_commits");
  });

  it("reserves verification and independent sources when commit discovery saturates", async () => {
    const transport = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({}))
    );
    const budget = createGitHubOperationReadBudget({
      maxRequests: 20,
      maxDurationMs: 1000,
      fetch: transport,
    });
    mocks.commitShas.mockImplementation(async () => {
      for (let page = 0; page < 30; page++) {
        try {
          await budget.fetch("https://api.github.test/commit-discovery");
        } catch {
          break;
        }
      }
      return {
        commitShas: Array.from({ length: 100 }, () => AFTER_SHA),
        availability: BranchIdentityAvailability.Incomplete,
      };
    });
    mocks.checkSuites.mockImplementation(async () => {
      await budget.fetch("https://api.github.test/checks");
      return {
        pushes: [
          {
            pushId: "PSH_reserved",
            beforeSha: BEFORE_SHA,
            afterSha: AFTER_SHA,
            providerUserId: "123",
            actorType: GitHubActorType.User,
          },
        ],
        availability: BranchIdentityAvailability.Incomplete,
      };
    });
    mocks.forcePushes.mockImplementation(async () => {
      await budget.fetch("https://api.github.test/force-pushes");
      return {
        events: [],
        availability: BranchIdentityAvailability.Incomplete,
      };
    });
    mocks.recentPushes.mockImplementation(async () => {
      await budget.fetch("https://api.github.test/recent-events");
      return {
        events: [],
        availability: BranchIdentityAvailability.Incomplete,
      };
    });
    mocks.transition.mockImplementation(async () => {
      await budget.fetch("https://api.github.test/verification");
      return "new_commits";
    });
    try {
      const result = await getVerifiedBranchPushEvidence({} as never, {
        ...input,
        pullRequests: Array.from({ length: 20 }, (_, index) => ({
          owner: input.owner,
          repo: input.repo,
          number: index + 1,
        })),
        readBudget: budget,
      });
      expect(result.pushes.map((push) => push.sourceEventId)).toEqual([
        "PSH_reserved",
      ]);
      expect(result.availability).toBe(BranchIdentityAvailability.Incomplete);
      expect(transport.mock.calls.map(([request]) => String(request))).toEqual([
        "https://api.github.test/commit-discovery",
        "https://api.github.test/commit-discovery",
        "https://api.github.test/commit-discovery",
        "https://api.github.test/checks",
        "https://api.github.test/checks",
        "https://api.github.test/checks",
        "https://api.github.test/force-pushes",
        "https://api.github.test/force-pushes",
        "https://api.github.test/force-pushes",
        "https://api.github.test/force-pushes",
        "https://api.github.test/recent-events",
        "https://api.github.test/verification",
      ]);
      expect(budget.requestsUsed()).toBe(12);
      expect(mocks.checkSuites).toHaveBeenCalledTimes(3);
      expect(mocks.forcePushes).toHaveBeenCalledTimes(4);
    } finally {
      budget.dispose();
    }
  });

  it("recovers historical and later non-owner accounts, preferring one source per transition", async () => {
    mocks.checkSuites.mockResolvedValue({
      pushes: [
        {
          pushId: "PSH_old",
          beforeSha: BEFORE_SHA,
          afterSha: AFTER_SHA,
          providerUserId: "123",
          providerLogin: "historical-alice",
          actorType: GitHubActorType.User,
        },
      ],
      availability: BranchIdentityAvailability.Incomplete,
    });
    mocks.forcePushes.mockResolvedValue({
      events: [
        {
          eventId: "force-1",
          beforeSha: BEFORE_SHA,
          afterSha: AFTER_SHA,
          providerUserId: "123",
          actorType: GitHubActorType.User,
          observedAt: NOW,
        },
      ],
      availability: BranchIdentityAvailability.Incomplete,
    });
    mocks.recentPushes.mockResolvedValue({
      events: [
        {
          eventId: "recent-1",
          beforeSha: AFTER_SHA,
          afterSha: LATER_SHA,
          providerUserId: "999",
          providerLogin: "alice",
          observedAt: NOW,
        },
      ],
      availability: BranchIdentityAvailability.Incomplete,
    });
    mocks.account.mockResolvedValue({
      providerUserId: "999",
      providerLogin: "alice",
      actorType: GitHubActorType.User,
    });

    const result = await getVerifiedBranchPushEvidence({} as never, input);

    expect(result.pushes).toEqual([
      {
        source: BranchPushContributionSource.GraphqlPush,
        sourceEventId: "PSH_old",
        beforeSha: BEFORE_SHA,
        afterSha: AFTER_SHA,
        providerUserId: "123",
        providerLogin: "historical-alice",
        actorType: GitHubActorType.User,
        observedAt: NOW,
      },
      {
        source: BranchPushContributionSource.RestPushEvent,
        sourceEventId: "recent-1",
        beforeSha: AFTER_SHA,
        afterSha: LATER_SHA,
        providerUserId: "999",
        providerLogin: "alice",
        actorType: GitHubActorType.User,
        observedAt: NOW,
      },
    ]);
    expect(result.availability).toBe(BranchIdentityAvailability.Incomplete);
    expect(mocks.commitShas).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        pullRequests: [
          { owner: "closedloop-ai", repo: "closedloop-ai", number: 5133 },
          { owner: "other-base", repo: "repo", number: 7338 },
        ],
      })
    );
    expect(mocks.forcePushes).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        owner: "other-base",
        repo: "repo",
        pullNumber: 7338,
      })
    );
    expect(mocks.transition).toHaveBeenCalledTimes(2);
  });

  it("does not report a bot or a transition with no new commits", async () => {
    mocks.checkSuites.mockResolvedValue({
      pushes: [
        {
          pushId: "PSH_rewind",
          beforeSha: BEFORE_SHA,
          afterSha: AFTER_SHA,
          providerUserId: "123",
          actorType: GitHubActorType.User,
        },
      ],
      availability: BranchIdentityAvailability.Incomplete,
    });
    mocks.recentPushes.mockResolvedValue({
      events: [
        {
          eventId: "bot-event",
          beforeSha: AFTER_SHA,
          afterSha: LATER_SHA,
          providerUserId: "999",
          providerLogin: "bot",
          observedAt: NOW,
        },
      ],
      availability: BranchIdentityAvailability.Incomplete,
    });
    mocks.account.mockResolvedValue({
      providerUserId: "999",
      providerLogin: "bot",
      actorType: GitHubActorType.Bot,
    });
    mocks.transition.mockResolvedValue("no_new_commits");

    const result = await getVerifiedBranchPushEvidence({} as never, input);

    expect(result.pushes).toEqual([]);
    expect(mocks.transition).toHaveBeenCalledTimes(1);
  });

  it("reports unavailable when transition verification fails before any candidate qualifies", async () => {
    mocks.checkSuites.mockResolvedValue({
      pushes: [
        {
          pushId: "PSH_unverified",
          beforeSha: BEFORE_SHA,
          afterSha: AFTER_SHA,
          providerUserId: "123",
          actorType: GitHubActorType.User,
        },
      ],
      availability: BranchIdentityAvailability.Incomplete,
    });
    mocks.transition.mockResolvedValue("unavailable");

    const result = await getVerifiedBranchPushEvidence({} as never, input);

    expect(result).toEqual({
      pushes: [],
      availability: BranchIdentityAvailability.Unavailable,
    });
  });

  it("keeps capped transition verification incomplete", async () => {
    mocks.checkSuites.mockResolvedValue({
      pushes: Array.from({ length: 101 }, (_, index) => ({
        pushId: `PSH_${index}`,
        beforeSha: (index + 1).toString(16).padStart(40, "0"),
        afterSha: (index + 201).toString(16).padStart(40, "0"),
        providerUserId: String(index + 1),
        actorType: GitHubActorType.User,
      })),
      availability: BranchIdentityAvailability.Incomplete,
    });

    const result = await getVerifiedBranchPushEvidence({} as never, input);

    expect(result.pushes).toHaveLength(100);
    expect(result.availability).toBe(BranchIdentityAvailability.Incomplete);
    expect(mocks.transition).toHaveBeenCalledTimes(100);
  });

  it("keeps distinct reported accounts when the same source observes a repeated transition", async () => {
    mocks.checkSuites.mockResolvedValue({
      pushes: [
        {
          pushId: "PSH_first",
          beforeSha: BEFORE_SHA,
          afterSha: AFTER_SHA,
          providerUserId: "123",
          actorType: GitHubActorType.User,
        },
        {
          pushId: "PSH_repeat",
          beforeSha: BEFORE_SHA,
          afterSha: AFTER_SHA,
          providerUserId: "456",
          actorType: GitHubActorType.User,
        },
      ],
      availability: BranchIdentityAvailability.Incomplete,
    });

    const result = await getVerifiedBranchPushEvidence({} as never, input);

    expect(result.pushes.map((push) => push.providerUserId)).toEqual([
      "123",
      "456",
    ]);
    expect(mocks.transition).toHaveBeenCalledTimes(2);
  });

  it("recovers an older PR push even when REST Events no longer contains it", async () => {
    mocks.checkSuites.mockResolvedValue({
      pushes: [
        {
          pushId: "PSH_pr5133",
          beforeSha: BEFORE_SHA,
          afterSha: AFTER_SHA,
          providerUserId: "123",
          actorType: GitHubActorType.User,
        },
      ],
      availability: BranchIdentityAvailability.Incomplete,
    });

    const result = await getVerifiedBranchPushEvidence({} as never, {
      ...input,
      pullRequests: [
        { owner: "closedloop-ai", repo: "closedloop-ai", number: 5133 },
      ],
    });

    expect(result.pushes).toEqual([
      expect.objectContaining({
        source: BranchPushContributionSource.GraphqlPush,
        sourceEventId: "PSH_pr5133",
        providerUserId: "123",
      }),
    ]);
    expect(result.availability).toBe(BranchIdentityAvailability.Incomplete);
    expect(mocks.recentPushes).toHaveBeenCalledOnce();
    expect(mocks.account).not.toHaveBeenCalled();
  });

  it("recovers an exact-ref force push after its commit leaves the live history", async () => {
    mocks.commitShas.mockResolvedValue({
      commitShas: [],
      availability: BranchIdentityAvailability.Incomplete,
    });
    mocks.forcePushes.mockResolvedValue({
      events: [
        {
          eventId: "force-overwritten-1",
          beforeSha: BEFORE_SHA,
          afterSha: AFTER_SHA,
          providerUserId: "456",
          actorType: GitHubActorType.User,
          observedAt: NOW,
        },
      ],
      availability: BranchIdentityAvailability.Incomplete,
    });

    const result = await getVerifiedBranchPushEvidence({} as never, input);

    expect(result.pushes).toEqual([
      expect.objectContaining({
        source: BranchPushContributionSource.HeadRefForcePushed,
        sourceEventId: "force-overwritten-1",
        providerUserId: "456",
      }),
    ]);
    expect(mocks.checkSuites).not.toHaveBeenCalled();
    expect(result.availability).toBe(BranchIdentityAvailability.Incomplete);
  });

  it("reports fully unavailable provider reads without a complete-empty claim", async () => {
    mocks.commitShas.mockResolvedValue({
      commitShas: [],
      availability: BranchIdentityAvailability.Unavailable,
    });
    mocks.forcePushes.mockResolvedValue({
      events: [],
      availability: BranchIdentityAvailability.Unavailable,
    });
    mocks.recentPushes.mockResolvedValue({
      events: [],
      availability: BranchIdentityAvailability.Unavailable,
    });

    const result = await getVerifiedBranchPushEvidence({} as never, input);

    expect(result).toEqual({
      pushes: [],
      availability: BranchIdentityAvailability.Unavailable,
    });
    expect(mocks.checkSuites).not.toHaveBeenCalled();
  });
});
