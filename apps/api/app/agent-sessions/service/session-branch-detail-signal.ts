import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import type { TransactionClient } from "@repo/database";
import { emitBranchDetailsChanged } from "@/app/branches/branch-detail-signal";

/** Include retracted memberships as well as branches that still own the session. */
export async function emitSessionBranchDetailChanged(
  tx: TransactionClient,
  organizationId: string,
  sessionArtifactId: string,
  previousBranchIds: readonly string[]
): Promise<void> {
  const remainingBranchIds = await readSessionBranchIds(
    tx,
    organizationId,
    sessionArtifactId
  );
  // Delivered only when the transaction containing the replacement commits.
  // One statement for the whole union: a session can touch many branches.
  await emitBranchDetailsChanged(tx, organizationId, [
    ...new Set([...previousBranchIds, ...remainingBranchIds]),
  ]);
}

export async function readSessionBranchIds(
  tx: TransactionClient,
  organizationId: string,
  sessionArtifactId: string
): Promise<string[]> {
  const links = await tx.artifactLink.findMany({
    where: {
      organizationId,
      sourceId: sessionArtifactId,
      linkType: LinkType.RelatesTo,
      target: { organizationId, type: ArtifactType.Branch },
    },
    select: { targetId: true },
  });
  return links.map((link) => link.targetId);
}
