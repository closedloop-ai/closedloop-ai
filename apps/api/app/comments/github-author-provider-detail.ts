import type { BranchPrCommentAuthor } from "@repo/api/src/types/branch";
import type { JsonObject } from "@repo/api/src/types/common";
import {
  type GitHubActorType,
  normalizeGitHubActorType,
} from "@repo/api/src/types/github-actor";
import { z } from "zod";
import { jsonObjectSchema } from "@/lib/json-schema";

const githubAuthorProviderDetailSchema = z.looseObject({
  actorType: z.unknown().optional(),
});

/** Reads canonical actor type from optional persisted provider metadata. */
export function parseGitHubAuthorProviderDetailActorType(
  value: unknown
): GitHubActorType | undefined {
  const parsed = githubAuthorProviderDetailSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  return normalizeGitHubActorType(parsed.data.actorType);
}

/**
 * Merges authoritative actor evidence into provider metadata. Missing evidence
 * returns `undefined` so callers omit the database update entirely.
 */
export function mergeGitHubAuthorProviderDetail(
  existing: unknown,
  actorType: GitHubActorType | undefined
): JsonObject | undefined {
  if (!actorType) {
    return undefined;
  }

  const parsed = jsonObjectSchema.safeParse(existing);
  return {
    ...(parsed.success ? parsed.data : {}),
    actorType,
  };
}

/** A GitHub comment's stored external author, read in the given organization only. */
export function githubCommentExternalAuthorSelect(organizationId: string) {
  return {
    where: { organizationId },
    select: {
      providerLogin: true,
      displayName: true,
      avatarUrl: true,
      profileUrl: true,
      providerDetail: true,
    },
  } as const;
}

export function toBranchPrCommentAuthor(author: {
  providerLogin: string;
  displayName: string | null;
  avatarUrl: string | null;
  profileUrl: string | null;
  providerDetail: unknown;
}): BranchPrCommentAuthor {
  const actorType = parseGitHubAuthorProviderDetailActorType(
    author.providerDetail
  );
  return {
    login: author.providerLogin,
    displayName: author.displayName,
    avatarUrl: author.avatarUrl,
    profileUrl: author.profileUrl,
    ...(actorType ? { actorType } : {}),
  };
}
