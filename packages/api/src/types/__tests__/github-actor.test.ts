import { describe, expect, it } from "vitest";
import {
  GitHubActorType,
  githubActorTypeValidator,
  normalizeGitHubActorType,
  normalizeGitHubProviderUserId,
} from "../github-actor";

describe("GitHub actor type", () => {
  it.each([
    GitHubActorType.User,
    GitHubActorType.Bot,
    GitHubActorType.Organization,
    GitHubActorType.Mannequin,
    GitHubActorType.EnterpriseUserAccount,
  ])("preserves exact documented actor type %s", (actorType) => {
    expect(normalizeGitHubActorType(actorType)).toBe(actorType);
    expect(githubActorTypeValidator.safeParse(actorType).success).toBe(true);
  });

  it.each(["user", "ServiceAccount", null, 42, { type: "Bot" }])(
    "classifies present unsupported or malformed evidence %j as unknown",
    (value) => {
      expect(normalizeGitHubActorType(value)).toBe(GitHubActorType.Unknown);
    }
  );

  it("preserves omission when evidence is missing", () => {
    expect(normalizeGitHubActorType(undefined)).toBeUndefined();
  });
});

describe("GitHub immutable numeric actor identity", () => {
  it("normalizes a measured provider ID", () => {
    expect(normalizeGitHubProviderUserId(123)).toBe("123");
  });
  it.each([
    undefined,
    null,
    -1,
    0,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    "123",
    "",
  ])(
    "does not invent an identity from malformed or missing evidence %j",
    (value) => {
      expect(normalizeGitHubProviderUserId(value)).toBeUndefined();
    }
  );
});
