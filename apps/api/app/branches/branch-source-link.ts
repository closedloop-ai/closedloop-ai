import { LinkType } from "@repo/api/src/types/artifact";
import type { PullRequestArtifactLinkResult } from "@repo/api/src/types/pull-request-artifact-link";
import type { TransactionClient } from "@repo/database";
import { deriveImplementationEvidence } from "@/app/agent-sessions/service/attribution/derive-implementation-evidence";
import { nextProducesLinkSortOrder } from "@/app/artifact-links/produces-link-sort-order";
import { isAttributionEvidenceReadOnForOrganization } from "@/lib/attribution-evidence-policy-feature";

/**
 * The PRODUCES edge from a source document to the branch artifact a write just
 * committed, and the OBSERVATION of it that the write response reports.
 *
 * Split out of `branch-service.ts` for ISS-10169. The edge used to be written
 * there and then echoed by the caller straight from its own REQUEST — so the
 * response asserted a relationship whose write it had never looked at. Owning
 * the write and its read-back together is what makes the echo an observation;
 * they are one responsibility and they belong in one module.
 */

export type BranchSourceLinkInput = {
  organizationId: string;
  /** The link owner. `null` means no link was requested, not a failed one. */
  sourceArtifactId: string | null;
  branchArtifactId: string;
};

/**
 * Write the requested PRODUCES edge, and return what was written.
 *
 * An empty array means no link was REQUESTED. It never means a requested link
 * silently failed to land: the upsert below either commits a row and yields its
 * id, or throws and rolls the enclosing transaction back. That is the property
 * the response contract depends on — a caller reading `linkedArtifacts: []`
 * beside a link it asked for would be reading the exact false-completeness
 * ISS-10169 is about, so there must be no third outcome.
 */
export async function writeBranchSourceLink(
  tx: TransactionClient,
  input: BranchSourceLinkInput
): Promise<PullRequestArtifactLinkResult[]> {
  const { sourceArtifactId } = input;
  if (!sourceArtifactId) {
    return [];
  }
  const sortOrder = await nextProducesLinkSortOrder(
    tx,
    input.organizationId,
    sourceArtifactId
  );
  const link = await tx.artifactLink.upsert({
    where: {
      sourceId_targetId_linkType: {
        sourceId: sourceArtifactId,
        targetId: input.branchArtifactId,
        linkType: LinkType.Produces,
      },
    },
    create: {
      organizationId: input.organizationId,
      sourceId: sourceArtifactId,
      targetId: input.branchArtifactId,
      linkType: LinkType.Produces,
      sortOrder,
    },
    update: {},
    select: { id: true },
  });
  // ISS-12552: a session that already wrote to this branch
  // now has the document that produced it as its implementation row's
  // associated artifact. Only while the attribution flag
  // is on for the organization (PRD-800 "Rollout"), as the request read it
  // before this transaction opened; a caller that did not read it derives
  // nothing here.
  if (isAttributionEvidenceReadOnForOrganization(input.organizationId)) {
    await deriveImplementationEvidence(tx, {
      organizationId: input.organizationId,
      branchIds: [input.branchArtifactId],
    });
  }

  return [{ sourceArtifactId, linkId: link.id }];
}
