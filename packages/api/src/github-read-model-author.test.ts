import { describe, expect, it } from "vitest";
import {
  buildPullRequestsByNumberQuery,
  mapPullRequestsByNumberResponse,
} from "./github-pull-requests-by-number";
import { mapBundledPullRequestsResponse } from "./github-read-model";
import { GitHubActorType } from "./types/github-actor";

describe("bounded PR author acquisitions", () => {
  it("requests immutable identity on the point read and preserves it on paged and point reads", () => {
    expect(buildPullRequestsByNumberQuery([42])).toContain(
      "... on User { databaseId }"
    );
    const node = {
      id: "PR_42",
      number: 42,
      url: "https://github.com/acme/repo/pull/42",
      author: { login: "renamed-account", databaseId: 123, __typename: "User" },
    };
    const page = mapBundledPullRequestsResponse({
      repository: { pullRequests: { nodes: [node] } },
    });
    const point = mapPullRequestsByNumberResponse(
      { repository: { pr_42: node } },
      undefined
    );
    for (const result of [page, point]) {
      expect(result.pullRequests[0]).toMatchObject({
        author: "renamed-account",
        authorProviderUserId: "123",
        authorActorType: GitHubActorType.User,
      });
    }
  });

  it.each([
    [{ login: "legacy" }, undefined, undefined],
    [
      { login: "app", databaseId: 456, __typename: "Bot" },
      "456",
      GitHubActorType.Bot,
    ],
    [
      { login: "imported", databaseId: 789, __typename: "Mannequin" },
      "789",
      GitHubActorType.Mannequin,
    ],
    [
      { login: "future", databaseId: 321, __typename: "FutureActor" },
      "321",
      GitHubActorType.Unknown,
    ],
    [
      { login: "bad-id", databaseId: -1, __typename: "User" },
      undefined,
      GitHubActorType.User,
    ],
  ])(
    "keeps legacy, bot and unknown evidence distinct",
    (author, providerId, actorType) => {
      const result = mapBundledPullRequestsResponse({
        repository: {
          pullRequests: {
            nodes: [
              {
                id: "PR_42",
                number: 42,
                url: "https://github.com/acme/repo/pull/42",
                author,
              },
            ],
          },
        },
      });
      expect(result.pullRequests[0]?.authorProviderUserId).toBe(providerId);
      expect(result.pullRequests[0]?.authorActorType).toBe(actorType);
      if (providerId === undefined) {
        expect(result.pullRequests[0]).not.toHaveProperty(
          "authorProviderUserId"
        );
      }
      if (actorType === undefined) {
        expect(result.pullRequests[0]).not.toHaveProperty("authorActorType");
      }
    }
  );
});
