import { LinkType } from "@repo/api/src/types/artifact";
import {
  commandDerivedSessionPrRefsFromMetadata,
  sessionPrIdentityKey,
} from "@repo/api/src/types/session-artifact-link";
import {
  ArtifactType,
  type Prisma,
  type TransactionClient,
} from "@repo/database";
import {
  SessionPrLinkAudience,
  sessionPrLinkKindWhere,
} from "@/lib/session-pr-links";

/**
 * Whether the acting user's own session carries command-derived evidence of
 * this PR on this Branch — the tombstoned-refresh lane's authorization to
 * spend the user's GitHub token on it.
 */
export async function hasOwnedSessionPullRequestReference(
  db: Pick<TransactionClient, "artifactLink">,
  input: {
    actorUserId: string;
    branchArtifactId: string;
    organizationId: string;
    pullNumber: number;
    repositoryFullName: string;
  }
): Promise<boolean> {
  const link: { metadata: Prisma.JsonValue | null } | null =
    await db.artifactLink.findFirst({
      where: {
        organizationId: input.organizationId,
        targetId: input.branchArtifactId,
        linkType: LinkType.RelatesTo,
        AND: [
          // ISS-5823 Metric: this probe AUTHORIZES a GitHub write as the user.
          // A PR the session merely named in prose vouches for nothing.
          sessionPrLinkKindWhere(SessionPrLinkAudience.Metric),
          {
            OR: [
              {
                AND: [
                  {
                    metadata: {
                      path: ["repositoryFullName"],
                      equals: input.repositoryFullName,
                    },
                  },
                  {
                    metadata: {
                      path: ["prNumber"],
                      equals: input.pullNumber,
                    },
                  },
                ],
              },
              {
                metadata: {
                  path: ["prRefs"],
                  array_contains: [
                    {
                      repositoryFullName: input.repositoryFullName,
                      prNumber: input.pullNumber,
                    },
                  ],
                },
              },
            ],
          },
        ],
        source: {
          organizationId: input.organizationId,
          type: ArtifactType.SESSION,
          createdById: input.actorUserId,
        },
        target: {
          organizationId: input.organizationId,
          type: ArtifactType.BRANCH,
        },
      },
      select: {
        metadata: true,
      },
    });
  return Boolean(
    link &&
      sessionPrLinkMatches(link.metadata, {
        pullNumber: input.pullNumber,
        repositoryFullName: input.repositoryFullName,
      })
  );
}

function sessionPrLinkMatches(
  metadata: Prisma.JsonValue | null,
  input: { pullNumber: number; repositoryFullName: string }
): boolean {
  const requestedIdentity = sessionPrIdentityKey(
    input.repositoryFullName,
    input.pullNumber
  );
  // ISS-5823: an ownership claim needs command-derived evidence; a prose
  // mention of the PR number does not make the session its author.
  return commandDerivedSessionPrRefsFromMetadata(metadata).some(
    (ref) =>
      sessionPrIdentityKey(ref.repositoryFullName, ref.prNumber) ===
      requestedIdentity
  );
}
