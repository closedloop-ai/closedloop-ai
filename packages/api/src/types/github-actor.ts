import { z } from "zod";

/** Stable GitHub actor classifications shared by provider and Branch contracts. */
export const GitHubActorType = {
  User: "User",
  Bot: "Bot",
  Organization: "Organization",
  Mannequin: "Mannequin",
  EnterpriseUserAccount: "EnterpriseUserAccount",
  Unknown: "unknown",
} as const;
export type GitHubActorType =
  (typeof GitHubActorType)[keyof typeof GitHubActorType];

/** Validates canonical actor types after normalization. */
export const githubActorTypeValidator = z.enum(GitHubActorType);

const knownGitHubActorTypeValidator = z.enum({
  User: GitHubActorType.User,
  Bot: GitHubActorType.Bot,
  Organization: GitHubActorType.Organization,
  Mannequin: GitHubActorType.Mannequin,
  EnterpriseUserAccount: GitHubActorType.EnterpriseUserAccount,
});

/**
 * Normalizes authoritative GitHub actor evidence without inferring from login or
 * display names. Missing evidence stays omitted; present unsupported or malformed
 * evidence receives the stable unknown classification.
 */
export function normalizeGitHubActorType(
  value: unknown
): GitHubActorType | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = knownGitHubActorTypeValidator.safeParse(value);
  return parsed.success ? parsed.data : GitHubActorType.Unknown;
}
