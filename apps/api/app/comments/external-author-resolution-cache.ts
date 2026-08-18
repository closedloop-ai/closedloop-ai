import type { GitHubActorType } from "@repo/api/src/types/github-actor";
import type { TransactionClient } from "@repo/database";
import {
  type ExternalGitHubAuthorSource,
  type ExternalGitHubUser,
  normalizeExternalGitHubAuthor,
  type ResolvedExternalGitHubAuthor,
  resolveExternalGitHubAuthorInTransaction,
} from "./external-authors";

type ExternalAuthorResolutionDb = Pick<
  TransactionClient,
  "externalCommentAuthor" | "gitHubUserConnection" | "user"
>;

type ExternalAuthorResolutionCacheEntry = {
  actorType?: GitHubActorType;
  resolved: ResolvedExternalGitHubAuthor;
};

/**
 * Creates a transaction-scoped author resolver that avoids repeated identity
 * queries without discarding actor evidence added by a later payload.
 */
export function createExternalGitHubAuthorResolutionCache(
  db: ExternalAuthorResolutionDb,
  organizationId: string
) {
  const cache = new Map<string, ExternalAuthorResolutionCacheEntry>();

  return async (
    author: ExternalGitHubUser | null,
    source: ExternalGitHubAuthorSource
  ): Promise<ResolvedExternalGitHubAuthor> => {
    const identity = normalizeExternalGitHubAuthor(author, source);
    if (!identity.isGhost) {
      const cached = cache.get(identity.providerUserId);
      if (cached && canReuseResolution(cached, identity.actorType)) {
        return cached.resolved;
      }
    }

    const resolved = await resolveExternalGitHubAuthorInTransaction(db, {
      organizationId,
      author,
      source,
    });
    if (!identity.isGhost) {
      cache.set(identity.providerUserId, {
        actorType: identity.actorType,
        resolved,
      });
    }
    return resolved;
  };
}

function canReuseResolution(
  cached: ExternalAuthorResolutionCacheEntry,
  incomingActorType: GitHubActorType | undefined
): boolean {
  return (
    incomingActorType === undefined || incomingActorType === cached.actorType
  );
}
