import { LinkType } from "@repo/api/src/types/artifact";
import { BranchParticipationKind } from "@repo/api/src/types/branch";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { ArtifactType } from "../../generated/client";
import type { TransactionClient } from "../../generated/internal/prismaNamespace";

/**
 * An ownerless Session that Wrote the Branch: the explicit Wrote link a Branch
 * needs to pass Product eligibility (`branchProductWroteExistsSql`) and appear
 * in GET /branches.
 */
export async function seedWroteSessionLink(
  prisma: TransactionClient,
  input: {
    organizationId: string;
    computeTargetId: string;
    branchArtifactId: string;
    observedAt: Date;
    linkId: string;
    session: {
      id: string;
      name: string;
      slug: string;
      externalSessionId: string;
    };
  }
): Promise<void> {
  await prisma.artifact.upsert({
    where: { id: input.session.id },
    select: { id: true },
    create: {
      id: input.session.id,
      organizationId: input.organizationId,
      type: ArtifactType.SESSION,
      name: input.session.name,
      slug: input.session.slug,
      status: SESSION_STATUS.INACTIVE,
      session: {
        create: {
          computeTargetId: input.computeTargetId,
          externalSessionId: input.session.externalSessionId,
          sessionStartedAt: input.observedAt,
          sessionUpdatedAt: input.observedAt,
          lastActivityAt: input.observedAt,
          estimatedCost: 0,
        },
      },
    },
    update: {},
  });
  const evidence = {
    branchParticipation: BranchParticipationKind.Wrote,
    metadata: {
      linkKind: SessionArtifactLinkKind.SessionBranch,
      branchParticipation: BranchParticipationKind.Wrote,
    },
  };
  await prisma.artifactLink.upsert({
    where: {
      sourceId_targetId_linkType: {
        sourceId: input.session.id,
        targetId: input.branchArtifactId,
        linkType: LinkType.RelatesTo,
      },
    },
    select: { id: true },
    create: {
      id: input.linkId,
      organizationId: input.organizationId,
      sourceId: input.session.id,
      targetId: input.branchArtifactId,
      linkType: LinkType.RelatesTo,
      ...evidence,
    },
    update: evidence,
  });
}
