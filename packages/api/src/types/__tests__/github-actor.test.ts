import { describe, expect, it } from "vitest";
import {
  GitHubActorType,
  githubActorTypeValidator,
  normalizeGitHubActorType,
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

  it.each([
    "user",
    "ServiceAccount",
    null,
    42,
    { type: "Bot" },
  ])("classifies present unsupported or malformed evidence %j as unknown", (value) => {
    expect(normalizeGitHubActorType(value)).toBe(GitHubActorType.Unknown);
  });

  it("preserves omission when evidence is missing", () => {
    expect(normalizeGitHubActorType(undefined)).toBeUndefined();
  });
});
