import { BranchIdentityAvailability } from "@repo/api/src/types/branch-identity";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { describe, expect, it, vi } from "vitest";
import { getPullRequestForcePushEvents } from "../pull-request-force-push-events";

const BEFORE_SHA = "a".repeat(40);
const AFTER_SHA = "b".repeat(40);
const INPUT = {
  owner: "closedloop-ai",
  repo: "closedloop-ai",
  pullNumber: 7338,
  branchName: "feature/collaborators",
};

function event(
  changes: {
    id?: string;
    branchName?: string;
    prefix?: string;
    actorType?: string;
    databaseId?: number | null;
    login?: string;
    beforeSha?: string;
    afterSha?: string;
  } = {}
) {
  return {
    id: changes.id ?? "HRFPE_1",
    createdAt: "2026-09-29T20:00:00Z",
    ref: {
      prefix: changes.prefix ?? "refs/heads/",
      name: changes.branchName ?? INPUT.branchName,
    },
    actor: {
      __typename: changes.actorType ?? GitHubActorType.User,
      login: changes.login ?? "alice",
      databaseId: changes.databaseId === undefined ? 123 : changes.databaseId,
    },
    beforeCommit: { oid: changes.beforeSha ?? BEFORE_SHA },
    afterCommit: { oid: changes.afterSha ?? AFTER_SHA },
  };
}

function page(
  nodes: unknown[],
  hasNextPage = false,
  endCursor: string | null = null
) {
  return {
    repository: {
      pullRequest: {
        timelineItems: { nodes, pageInfo: { hasNextPage, endCursor } },
      },
    },
  };
}

describe("getPullRequestForcePushEvents", () => {
  it("returns the reported human actor for an exact Branch ref", async () => {
    const graphql = vi.fn().mockResolvedValue(page([event()]));

    const result = await getPullRequestForcePushEvents(
      { graphql } as never,
      INPUT
    );

    expect(result).toEqual({
      events: [
        {
          eventId: "HRFPE_1",
          beforeSha: BEFORE_SHA,
          afterSha: AFTER_SHA,
          providerUserId: "123",
          providerLogin: "alice",
          actorType: GitHubActorType.User,
          observedAt: new Date("2026-09-29T20:00:00Z"),
        },
      ],
      availability: BranchIdentityAvailability.Incomplete,
    });
    expect(graphql).toHaveBeenCalledWith(
      expect.stringContaining("HEAD_REF_FORCE_PUSHED_EVENT"),
      expect.objectContaining({ number: INPUT.pullNumber, first: 100 })
    );
  });

  it("rejects another Branch or tag, bot, unknown account, ghost, and unchanged ref", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValue(
        page([
          event({ id: "other", branchName: "other" }),
          event({ id: "tag", prefix: "refs/tags/" }),
          event({ id: "bot", actorType: GitHubActorType.Bot }),
          event({ id: "unknown", databaseId: null }),
          event({ id: "ghost", login: "ghost" }),
          event({ id: "unchanged", afterSha: BEFORE_SHA }),
        ])
      );

    const result = await getPullRequestForcePushEvents(
      { graphql } as never,
      INPUT
    );

    expect(result.events).toEqual([]);
    expect(result.availability).toBe(BranchIdentityAvailability.Incomplete);
  });

  it("paginates the timeline and keeps known actors after a later failure", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(page([event()], true, "cursor-1"))
      .mockRejectedValueOnce(new Error("timeline denied"));

    const result = await getPullRequestForcePushEvents(
      { graphql } as never,
      INPUT
    );

    expect(result.events).toHaveLength(1);
    expect(result.availability).toBe(BranchIdentityAvailability.Incomplete);
    expect(graphql).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({ after: "cursor-1" })
    );
  });

  it("reports a missing PR or denied first page as unavailable", async () => {
    const graphql = vi.fn().mockResolvedValue({
      repository: { pullRequest: null },
    });

    await expect(
      getPullRequestForcePushEvents({ graphql } as never, INPUT)
    ).resolves.toEqual({
      events: [],
      availability: BranchIdentityAvailability.Unavailable,
    });
  });
});
