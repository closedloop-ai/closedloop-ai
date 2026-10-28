import { isHumanGitHubActor } from "@repo/api/src/types/branch-identity";
import type { GitHubActorType } from "@repo/api/src/types/github-actor";
import type { TransactionClient } from "@repo/database";
import {
  ExternalGitHubCollaboratorSourceKind,
  resolveExternalGitHubAuthorInTransaction,
} from "@/app/comments/external-authors";

const PROVIDER_USER_ID_RE = /^\d+$/;

/** Reuse the org-scoped GitHub commenter identity for a measured PR author. */
export async function ensurePullRequestAuthorIdentity(
  tx: TransactionClient,
  input: {
    organizationId: string;
    githubId: string;
    authorProviderUserId?: string | null;
    authorLogin?: string | null;
    authorActorType?: GitHubActorType | null;
  }
): Promise<void> {
  const providerUserId = input.authorProviderUserId;
  const actorType = input.authorActorType;
  if (
    !(
      providerUserId &&
      PROVIDER_USER_ID_RE.test(providerUserId) &&
      actorType &&
      isHumanGitHubActor(actorType)
    )
  ) {
    return;
  }
  await resolveExternalGitHubAuthorInTransaction(tx, {
    organizationId: input.organizationId,
    author: {
      id: providerUserId,
      login: input.authorLogin,
      actorType,
    },
    source: {
      sourceKind: ExternalGitHubCollaboratorSourceKind.PullRequestAuthor,
      githubObjectId: input.githubId,
    },
  });
}
