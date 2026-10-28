import { LinkType } from "@repo/api/src/types/artifact";
import { Prisma, type TransactionClient } from "@repo/database";
import { lockProjectRank } from "@/app/documents/document-sort-order";

const PRODUCES_LINK_RANK_LOCK_NAMESPACE = 9000;

/** Share the project rank lock with placement, then serialize sibling inserts before appending. */
export async function nextProducesLinkSortOrder(
  tx: TransactionClient,
  organizationId: string,
  sourceId: string
): Promise<number> {
  const source = await tx.artifact.findFirst({
    where: { id: sourceId, organizationId },
    select: { projectId: true },
  });
  if (source?.projectId) {
    await lockProjectRank(tx, source.projectId);
  }
  await tx.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(${PRODUCES_LINK_RANK_LOCK_NAMESPACE}::int4, hashtext(${sourceId}::text))`
  );
  const latest = await tx.artifactLink.aggregate({
    where: { organizationId, sourceId, linkType: LinkType.Produces },
    _max: { sortOrder: true },
  });
  return (latest._max.sortOrder ?? -1000) + 1000;
}
