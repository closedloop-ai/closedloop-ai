import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { describe, expect, it } from "vitest";
import {
  mergeGitHubAuthorProviderDetail,
  parseGitHubAuthorProviderDetailActorType,
} from "../github-author-provider-detail";

describe("GitHub author provider detail", () => {
  it.each([
    GitHubActorType.User,
    GitHubActorType.Bot,
    GitHubActorType.Organization,
    GitHubActorType.Mannequin,
    GitHubActorType.EnterpriseUserAccount,
    GitHubActorType.Unknown,
  ])("reads canonical actor type %s", (actorType) => {
    expect(
      parseGitHubAuthorProviderDetailActorType({ actorType, retained: true })
    ).toBe(actorType);
  });

  it("maps a present unsupported stored type to unknown", () => {
    expect(
      parseGitHubAuthorProviderDetailActorType({ actorType: "ServiceAccount" })
    ).toBe(GitHubActorType.Unknown);
  });

  it.each([
    undefined,
    null,
    [],
    "legacy",
    7,
  ])("omits actor type for missing or malformed metadata %j", (value) => {
    expect(parseGitHubAuthorProviderDetailActorType(value)).toBeUndefined();
  });

  it("merges supplied evidence without erasing sibling JSON keys", () => {
    expect(
      mergeGitHubAuthorProviderDetail(
        { actorType: GitHubActorType.User, retained: { source: "github" } },
        GitHubActorType.Bot
      )
    ).toEqual({
      actorType: GitHubActorType.Bot,
      retained: { source: "github" },
    });
  });

  it("repairs malformed metadata only when actor evidence is supplied", () => {
    expect(
      mergeGitHubAuthorProviderDetail(["legacy"], GitHubActorType.Mannequin)
    ).toEqual({ actorType: GitHubActorType.Mannequin });
    expect(
      mergeGitHubAuthorProviderDetail(["legacy"], undefined)
    ).toBeUndefined();
  });
});
