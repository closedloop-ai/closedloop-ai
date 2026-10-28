import { ArtifactType } from "@repo/api/src/types/artifact";
import { BATCH_MUTATION_ENTITY_LIMIT } from "@repo/api/src/types/batch-mutation-limits";
import type { BatchItemResult } from "@repo/api/src/types/batch-mutation-result";
import { Prisma, type TransactionClient } from "@repo/database";
import { batchResultsByFound } from "@/lib/batch-mutation-response";
import { normalizeUuid } from "@/lib/is-uuid";
import { isUserInOrganization } from "@/lib/user-org-membership";

type LockedAssigneeRow = {
  id: string;
  assigneeId: string | null;
  name: string;
  slug: string;
  subtype: string;
};

/** Lock and update the eligible document/issue subset within the caller's transaction. */
export async function batchUpdateDocumentAssignee(
  tx: TransactionClient,
  documentIds: readonly string[],
  assigneeId: string | null,
  organizationId: string
): Promise<{
  validAssignee: boolean;
  resultsById: Map<string, BatchItemResult>;
  changes: Array<{
    artifactId: string;
    before: string | null;
    after: string | null;
    name: string;
    slug: string;
    subtype: string;
  }>;
}> {
  if (documentIds.length > BATCH_MUTATION_ENTITY_LIMIT) {
    throw new RangeError("Document assignment batch exceeds the entity limit");
  }
  if (
    assigneeId !== null &&
    !(await isUserInOrganization(tx, assigneeId, organizationId))
  ) {
    return { validAssignee: false, resultsById: new Map(), changes: [] };
  }
  const uniqueRequestedIds = [...new Set(documentIds)];
  const normalizedIds = [...new Set(uniqueRequestedIds.map(normalizeUuid))];
  const lockedRows =
    normalizedIds.length === 0
      ? []
      : await tx.$queryRaw<LockedAssigneeRow[]>(Prisma.sql`
          SELECT "id", "assignee_id" AS "assigneeId", "name", "slug", "subtype"
          FROM "artifacts"
          WHERE "id" IN (${Prisma.join(normalizedIds.map((id) => Prisma.sql`${id}::uuid`))})
            AND "organization_id" = ${organizationId}::uuid
            AND "type" = ${ArtifactType.Document}::"ArtifactType"
          ORDER BY "id" ASC
          FOR NO KEY UPDATE
        `);
  const foundIds = new Set(lockedRows.map((row) => row.id));
  const changedRows = lockedRows.filter((row) => row.assigneeId !== assigneeId);
  if (changedRows.length > 0) {
    await tx.artifact.updateMany({
      where: {
        id: { in: changedRows.map((row) => row.id) },
        organizationId,
        type: ArtifactType.Document,
      },
      data: { assigneeId },
    });
  }
  return {
    validAssignee: true,
    resultsById: batchResultsByFound(
      uniqueRequestedIds,
      foundIds,
      normalizeUuid
    ),
    changes: changedRows.map((row) => ({
      artifactId: row.id,
      before: row.assigneeId,
      after: assigneeId,
      name: row.name,
      slug: row.slug,
      subtype: row.subtype,
    })),
  };
}
