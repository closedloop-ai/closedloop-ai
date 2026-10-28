import {
  BatchItemAppliedOutcome,
  type BatchItemResult,
  batchItemAppliedWithOutcome,
} from "@repo/api/src/types/batch-mutation-result";
import { Result } from "@repo/api/src/types/result";
import type { TagEntityType } from "@repo/api/src/types/tag";
import { Prisma, type TransactionClient, withDb } from "@repo/database";
import { reconcileLinkedPullRequestLabelsForArtifacts } from "@/lib/github/artifact-tag-label-reconciliation";
import { normalizeUuid } from "@/lib/is-uuid";
import {
  lockBatchTag,
  lockBatchTagArtifacts,
  type RecordBatchTagReceipt,
} from "./batch-tag-locks";
import { reportUnresolvedBatchTagRemoveIds } from "./batch-tag-removal-telemetry";

/** Organization-scoped, per-item batch tag removal for the v2 route. */
export const batchRemoveTagService = {
  async removePerItem(
    tagId: string,
    _entityType: typeof TagEntityType.Artifact,
    entityIds: string[],
    organizationId: string,
    recordReceipt?: RecordBatchTagReceipt
  ): Promise<Result<BatchRemoveTagPerItemResult, BatchRemoveTagRefusal>> {
    const uniqueIds = [...new Set(entityIds.map(normalizeUuid))];
    const removed = await withDb.tx(
      async (tx): Promise<Result<RemovedTagBatch, BatchRemoveTagRefusal>> => {
        const tagExists = await lockBatchTag(tx, tagId, organizationId);
        if (!tagExists) {
          return Result.err(BatchRemoveTagRefusal.TagNotFound);
        }

        const foundIds = await lockBatchTagArtifacts(
          tx,
          uniqueIds,
          organizationId
        );
        if (foundIds.size !== uniqueIds.length) {
          reportUnresolvedBatchTagRemoveIds(organizationId, {
            unresolvedIdCount: uniqueIds.length - foundIds.size,
            requestedIdCount: uniqueIds.length,
          });
          return Result.err(BatchRemoveTagRefusal.UnresolvedIds);
        }

        const removedIds = await deleteTagRowsReturningArtifactIds(
          tx,
          tagId,
          uniqueIds
        );
        await recordReceipt?.(tx, removedIds, uniqueIds);
        return Result.ok({
          removedIds,
          results: removalResults(uniqueIds, new Set(removedIds)),
        });
      }
    );

    if (!removed.ok) {
      return removed;
    }

    if (removed.value.removedIds.length > 0) {
      await reconcileLinkedPullRequestLabelsForArtifacts({
        organizationId,
        artifactIds: removed.value.removedIds,
      });
    }
    return Result.ok(removed.value);
  },
};

export const BatchRemoveTagRefusal = {
  TagNotFound: "tag_not_found",
  UnresolvedIds: "unresolved_ids",
} as const;
export type BatchRemoveTagRefusal =
  (typeof BatchRemoveTagRefusal)[keyof typeof BatchRemoveTagRefusal];

export type BatchRemoveTagPerItemResult = {
  results: Map<string, BatchItemResult>;
  removedIds: string[];
};

type RemovedTagBatch = BatchRemoveTagPerItemResult;
type RemovedArtifactIdRow = { artifactId: string };

function removalResults(
  artifactIds: readonly string[],
  removedIds: ReadonlySet<string>
): Map<string, BatchItemResult> {
  const results = new Map<string, BatchItemResult>();
  for (const artifactId of artifactIds) {
    results.set(
      artifactId,
      batchItemAppliedWithOutcome(
        artifactId,
        removedIds.has(artifactId)
          ? BatchItemAppliedOutcome.Removed
          : BatchItemAppliedOutcome.NotPresent
      )
    );
  }
  return results;
}

async function deleteTagRowsReturningArtifactIds(
  tx: TransactionClient,
  tagId: string,
  artifactIds: readonly string[]
): Promise<string[]> {
  if (artifactIds.length === 0) {
    return [];
  }
  const artifactIdSql = Prisma.join(
    artifactIds.map((artifactId) => Prisma.sql`${artifactId}::uuid`)
  );
  const rows = await tx.$queryRaw<RemovedArtifactIdRow[]>(Prisma.sql`
    DELETE FROM "tag_artifacts"
    WHERE "tag_id" = ${tagId}::uuid
      AND "artifact_id" IN (${artifactIdSql})
    RETURNING "artifact_id" AS "artifactId"
  `);
  return rows.map((row) => normalizeUuid(row.artifactId));
}
