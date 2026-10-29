import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { describe, expect, it } from "vitest";
import { mapPullRequestAuthor } from "../pull-request-author";

describe("mapPullRequestAuthor", () => {
  it("does not turn GitHub's deleted-account placeholder into an author identity", () => {
    expect(
      mapPullRequestAuthor({ id: 10_137, login: "ghost", type: "User" })
    ).toEqual({
      authorLogin: null,
      authorProviderUserId: null,
      authorActorType: null,
    });
  });
  it("keeps the provider ID and actor kind independent of a mutable login", () => {
    expect(
      mapPullRequestAuthor({
        id: 123,
        login: "octocat",
        type: GitHubActorType.User,
      })
    ).toEqual({
      authorLogin: "octocat",
      authorProviderUserId: "123",
      authorActorType: GitHubActorType.User,
    });
  });

  it("omits missing identity instead of manufacturing a person", () => {
    expect(mapPullRequestAuthor(null)).toEqual({ authorLogin: null });
    expect(mapPullRequestAuthor({ login: "legacy" })).toEqual({
      authorLogin: "legacy",
    });
  });

  it("classifies unknown provider actor kinds without treating them as human", () => {
    expect(
      mapPullRequestAuthor({ id: 456, login: "future", type: "FutureKind" })
    ).toEqual({
      authorLogin: "future",
      authorProviderUserId: "456",
      authorActorType: GitHubActorType.Unknown,
    });
  });
});
