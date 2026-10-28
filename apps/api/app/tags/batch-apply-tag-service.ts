import type { BatchItemResult } from "@repo/api/src/types/batch-mutation-result";
import { Result, Status } from "@repo/api/src/types/result";
import type { TagEntityType } from "@repo/api/src/types/tag";
import { withDb } from "@repo/database";
import { batchResultsByFound } from "@/lib/batch-mutation-response";
import { reconcileLinkedPullRequestLabelsForArtifacts } from "@/lib/github/artifact-tag-label-reconciliation";
import {
  lockBatchTag,
  lockBatchTagArtifacts,
  type RecordBatchTagReceipt,
} from "./batch-tag-locks";

/**
 * Per-item results for `POST /entity-tags/batch/v2` (ISS-9464).
 *
 * Artifact-only, like the v1 batch it mirrors: the write is `tag_artifacts`
 * rows, and the validator pins `entityType` before this is reached.
 *
 * v1 throws `EntityNotFoundError` for the whole batch when any requested id is
 * missing from the org. Here the tag lands on the ids that resolved and the
 * rest are reported item by item. A tag that is not this org's fails every item
 * identically, so it stays an envelope error rather than N item failures.
 *
 * The tag read, the scope read and the insert are ONE transaction over locked
 * rows. Decomposed they are a read-modify-write across three round-trips: an
 * artifact or tag deleted in between makes the foreign key reject the whole
 * `createMany`, and the route answers the 500 envelope this route exists to
 * replace — losing the per-item results of every id that was fine.
 */
export const batchApplyTagService = {
  async applyPerItem(
    tagId: string,
    // Artifact-only: this writes `tagArtifact` rows. The validator and the
    // shared `BatchApplyTagInput` contract both pin `entityType` to Artifact,
    // so non-artifact ids can never reach this write against the wrong relation.
    _entityType: typeof TagEntityType.Artifact,
    entityIds: string[],
    organizationId: string,
    recordReceipt?: RecordBatchTagReceipt
  ): Promise<Result<BatchApplyTagPerItemResult>> {
    const uniqueIds = [...new Set(entityIds.map((id) => id.toLowerCase()))];

    const applied = await withDb.tx(
      async (tx): Promise<Result<AppliedTagBatch>> => {
        const tagExists = await lockBatchTag(tx, tagId, organizationId);
        if (!tagExists) {
          return Result.err(Status.NotFound);
        }

        const foundIds = await lockBatchTagArtifacts(
          tx,
          uniqueIds,
          organizationId
        );
        const taggedIds = uniqueIds.filter((id) => foundIds.has(id));

        const newlyTaggedIds: string[] = [];
        if (taggedIds.length > 0) {
          // The receipt's scope comes from the INSERT, never from a read taken
          // before it (ISS-9465 ruling 1). `skipDuplicates` is `ON CONFLICT DO
          // NOTHING`, so under READ COMMITTED a concurrent identical batch can
          // commit between a pre-read and this statement: the insert then skips
          // the row while the pre-read's difference still names it, and the
          // ledger gains a `tag_applied` entry for a row this transaction did
          // not write. `RETURNING` cannot disagree with what was written.
          // Still ONE statement, so the bound that made ruling 1 refuse per-row
          // upserts is untouched — it refused UPSERTS, not `RETURNING`.
          const inserted = await tx.tagArtifact.createManyAndReturn({
            data: taggedIds.map((artifactId) => ({ tagId, artifactId })),
            skipDuplicates: true,
            select: { artifactId: true },
          });
          newlyTaggedIds.push(...inserted.map((row) => row.artifactId));
        }

        // On the INSERT's own transaction (ISS-10993), so a receipt that cannot
        // be written rolls the tag back with it. A callback rather than a
        // transaction the route opens around this call: `withDb.tx` joins an
        // ambient transaction instead of nesting, and the reconcile below would
        // then run inside it.
        await recordReceipt?.(tx, newlyTaggedIds, taggedIds);

        return Result.ok({
          taggedIds,
          newlyTaggedIds,
          results: batchResultsByFound(uniqueIds, foundIds),
        });
      }
    );

    if (!applied.ok) {
      return applied;
    }

    if (applied.value.taggedIds.length > 0) {
      // ISS-4760, as v1: converge the linked PRs' labels through the bounded
      // helper — over the ids that were actually tagged, never the requested
      // set, or a batch would fan out GitHub writes for artifacts it refused.
      // AFTER the commit, deliberately: this makes GitHub network calls, and a
      // transaction held open across them holds its row locks for as long as
      // GitHub takes to answer.
      await reconcileLinkedPullRequestLabelsForArtifacts({
        organizationId,
        artifactIds: applied.value.taggedIds,
      });
    }

    return Result.ok({
      results: applied.value.results,
      newlyTaggedIds: applied.value.newlyTaggedIds,
    });
  },
};

/**
 * `applyPerItem`'s answer: the per-item results the route serializes, plus the
 * ids that actually gained the tag, which the route feeds to the activity
 * receipt and never puts on the wire (ISS-9465).
 */
export type BatchApplyTagPerItemResult = {
  results: Map<string, BatchItemResult>;
  newlyTaggedIds: string[];
};

type AppliedTagBatch = {
  /** The ids the insert covered, in request order — the reconcile's scope. */
  taggedIds: string[];
  /**
   * The subset of {@link AppliedTagBatch.taggedIds} that did not already carry
   * the tag — the activity receipt's scope (ISS-9465). Narrower than
   * `taggedIds` on purpose: re-applying a tag an artifact already has changes
   * nothing, and a receipt for it would report a change that never happened.
   */
  newlyTaggedIds: string[];
  /** One result per distinct requested id. */
  results: Map<string, BatchItemResult>;
};
