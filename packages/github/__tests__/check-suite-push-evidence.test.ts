import { BranchIdentityAvailability } from "@repo/api/src/types/branch-identity";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { describe, expect, it, vi } from "vitest";
import { getCheckSuitePushEvidenceForCommit } from "../check-suite-push-evidence";

const BEFORE_SHA = "a".repeat(40);
const AFTER_SHA = "b".repeat(40);
const INPUT = {
  owner: "closedloop-ai",
  repo: "closedloop-ai",
  commitSha: AFTER_SHA,
  branchName: "feature/collaborators",
};

function suite(
  overrides: {
    branchName?: string | null;
    actorType?: string;
    login?: string;
    databaseId?: number | null;
    pushId?: string;
    beforeSha?: string | null;
    afterSha?: string | null;
  } = {}
) {
  return {
    branch:
      overrides.branchName === null
        ? null
        : { name: overrides.branchName ?? INPUT.branchName },
    push: {
      id: overrides.pushId ?? "PSH_1",
      previousSha: overrides.beforeSha ?? BEFORE_SHA,
      nextSha: overrides.afterSha ?? AFTER_SHA,
      pusher: {
        __typename: overrides.actorType ?? GitHubActorType.User,
        login: overrides.login ?? "alice",
        databaseId:
          overrides.databaseId === undefined ? 123 : overrides.databaseId,
      },
    },
  };
}

function page(
  nodes: unknown[],
  hasNextPage = false,
  endCursor: string | null = null
) {
  return {
    repository: {
      object: { checkSuites: { nodes, pageInfo: { hasNextPage, endCursor } } },
    },
  };
}

describe("getCheckSuitePushEvidenceForCommit", () => {
  it("retains ghost provenance as an exclusion instead of attributing its placeholder account", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValue(page([suite({ login: "ghost" })]));

    const result = await getCheckSuitePushEvidenceForCommit(
      { graphql } as never,
      INPUT
    );

    expect(result).toEqual({
      pushes: [],
      availability: BranchIdentityAvailability.Incomplete,
      excludedTransitions: [{ beforeSha: BEFORE_SHA, afterSha: AFTER_SHA }],
    });
  });
  it("recovers a historical account on the exact ref and deduplicates Push IDs", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(
        page(
          [
            suite({
              beforeSha: BEFORE_SHA.toUpperCase(),
              afterSha: AFTER_SHA.toUpperCase(),
            }),
            suite(),
          ],
          true,
          "cursor-1"
        )
      )
      .mockResolvedValueOnce(
        page([
          suite({ branchName: "other-branch", pushId: "PSH_2" }),
          suite({ actorType: GitHubActorType.Bot, pushId: "PSH_3" }),
        ])
      );

    const result = await getCheckSuitePushEvidenceForCommit(
      { graphql } as never,
      INPUT
    );

    expect(result).toEqual({
      pushes: [
        {
          pushId: "PSH_1",
          beforeSha: BEFORE_SHA,
          afterSha: AFTER_SHA,
          providerUserId: "123",
          providerLogin: "alice",
          actorType: GitHubActorType.User,
        },
      ],
      availability: BranchIdentityAvailability.Incomplete,
      excludedTransitions: [{ beforeSha: BEFORE_SHA, afterSha: AFTER_SHA }],
    });
    expect(graphql).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({ after: "cursor-1", sha: AFTER_SHA })
    );
  });

  it("does not turn a missing check suite into a complete empty set", async () => {
    const graphql = vi.fn().mockResolvedValue(page([]));

    const result = await getCheckSuitePushEvidenceForCommit(
      { graphql } as never,
      INPUT
    );

    expect(result.pushes).toEqual([]);
    expect(result.availability).toBe(BranchIdentityAvailability.Incomplete);
  });

  it("treats a missing connection as unavailable", async () => {
    const graphql = vi.fn().mockResolvedValue({
      repository: { object: { checkSuites: null } },
    });

    const result = await getCheckSuitePushEvidenceForCommit(
      { graphql } as never,
      INPUT
    );

    expect(result).toEqual({
      pushes: [],
      availability: BranchIdentityAvailability.Unavailable,
    });
  });

  it("keeps known pushers when a later page fails", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(page([suite()], true, "cursor-1"))
      .mockRejectedValueOnce(new Error("Checks denied"));

    const result = await getCheckSuitePushEvidenceForCommit(
      { graphql } as never,
      INPUT
    );

    expect(result.pushes).toHaveLength(1);
    expect(result.availability).toBe(BranchIdentityAvailability.Incomplete);
  });

  it("reports a first-page provider failure as unavailable", async () => {
    const graphql = vi.fn().mockRejectedValue(new Error("Checks denied"));

    const result = await getCheckSuitePushEvidenceForCommit(
      { graphql } as never,
      INPUT
    );

    expect(result).toEqual({
      pushes: [],
      availability: BranchIdentityAvailability.Unavailable,
    });
  });

  it("excludes a null ref, an unknown account, and no-new-commit transitions", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValue(
        page([
          suite({ branchName: null }),
          suite({ actorType: "EnterpriseUserAccount", databaseId: null }),
          suite({ afterSha: BEFORE_SHA }),
        ])
      );

    const result = await getCheckSuitePushEvidenceForCommit(
      { graphql } as never,
      INPUT
    );

    expect(result.pushes).toEqual([]);
    expect(result.availability).toBe(BranchIdentityAvailability.Incomplete);
  });
});
