import {
  type GitHubActorType,
  normalizeGitHubActorType,
  normalizeGitHubProviderUserId,
} from "@repo/api/src/types/github-actor";

/** Preserve the provider's immutable PR author identity across read/webhook lanes. */
export function mapPullRequestAuthor(
  author:
    | { id?: number | null; login?: string | null; type?: unknown }
    | null
    | undefined
): {
  authorLogin: string | null;
  authorProviderUserId?: string | null;
  authorActorType?: GitHubActorType | null;
} {
  if (author?.login?.toLowerCase() === "ghost") {
    return {
      authorLogin: null,
      authorProviderUserId: null,
      authorActorType: null,
    };
  }
  const actorType = normalizeGitHubActorType(author?.type);
  const providerUserId = normalizeGitHubProviderUserId(author?.id);
  return {
    authorLogin: author?.login ?? null,
    ...(providerUserId === undefined
      ? {}
      : { authorProviderUserId: providerUserId }),
    ...(actorType === undefined ? {} : { authorActorType: actorType }),
  };
}
