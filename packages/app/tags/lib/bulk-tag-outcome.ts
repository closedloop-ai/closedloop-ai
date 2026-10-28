import {
  BATCH_ITEM_APPLIED_STATUS,
  BATCH_ITEM_FAILURE_MESSAGE,
  BatchItemAppliedOutcome,
  BatchItemFailureCode,
  type BatchMutationResponse,
  batchItemApplied,
  batchItemAppliedWithOutcome,
  batchItemFailed,
  type batchMutationResponseSchema,
  resolveBatchItemFailureCode,
} from "@repo/api/src/types/batch-mutation-result";
import { TagColor, type TagSummary } from "@repo/api/src/types/tag";
import { z } from "zod";
import {
  BulkTagMutation,
  type BulkTagMutation as BulkTagMutationValue,
} from "./bulk-tag-mutation";

/** Feature adapters provide canonical cloud identities and projected write permission. */
export type BulkTagTarget = {
  artifactId?: string;
  canApply: boolean;
  rowId: string;
};

const bulkTagOptionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  color: z.enum(TagColor),
});

/**
 * The picker consumes only the existing tag-summary projection. Each row is
 * parsed on its own, so one entry this build cannot read (a color added on a
 * newer server) is dropped instead of failing the whole catalog on an
 * installed Desktop build. A body that is not a list at all still throws.
 */
export function parseBulkTagOptions(data: unknown): TagSummary[] {
  return z
    .array(z.unknown())
    .parse(data)
    .flatMap((entry) => {
      const parsed = bulkTagOptionSchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    });
}

/** Canonicalizes UUID identities while preserving non-UUID host row keys. */
export function canonicalizeBulkTagArtifactId(artifactId: string) {
  return z.uuid().safeParse(artifactId).success
    ? artifactId.toLowerCase()
    : artifactId;
}

/** Only an unambiguous applied receipt for a requested artifact confirms a row. */
export function resolveBulkTagOutcome(
  targets: readonly BulkTagTarget[],
  response: BatchMutationResponse,
  operation: BulkTagMutationValue = BulkTagMutation.Add
) {
  const byArtifact = new Map<string, typeof response.results>();
  for (const result of response.results) {
    const artifactId = canonicalizeBulkTagArtifactId(result.id);
    const results = byArtifact.get(artifactId) ?? [];
    results.push(result);
    byArtifact.set(artifactId, results);
  }
  const succeededIds: string[] = [];
  const failedIds: string[] = [];
  const removedIds: string[] = [];
  const notPresentIds: string[] = [];
  const messages = new Set<string>();
  for (const target of targets) {
    const results = target.artifactId
      ? byArtifact.get(canonicalizeBulkTagArtifactId(target.artifactId))
      : undefined;
    const result = results?.length === 1 ? results[0] : undefined;
    if (
      result?.status === BATCH_ITEM_APPLIED_STATUS &&
      (operation === BulkTagMutation.Add ||
        result.outcome === BatchItemAppliedOutcome.Removed ||
        result.outcome === BatchItemAppliedOutcome.NotPresent)
    ) {
      succeededIds.push(target.rowId);
      if (result.outcome === BatchItemAppliedOutcome.Removed) {
        removedIds.push(target.rowId);
      } else if (result.outcome === BatchItemAppliedOutcome.NotPresent) {
        notPresentIds.push(target.rowId);
      }
    } else {
      failedIds.push(target.rowId);
      messages.add(BATCH_ITEM_FAILURE_MESSAGE[batchTagFailureCode(result)]);
    }
  }
  return {
    failedIds,
    messages: [...messages],
    notPresentIds,
    removedIds,
    succeededIds,
  };
}

/**
 * The v2 parser accepts failure codes this build has never seen. Narrowed here,
 * at the wire boundary, so every consumer reads the canonical response: an
 * unknown code, or a code on an applied status, is an unknown outcome for that
 * item and never a success.
 */
export function toBatchMutationResponse(
  wire: ReturnType<typeof batchMutationResponseSchema.parse>
): BatchMutationResponse {
  return {
    ...wire,
    results: wire.results.map((result) =>
      result.code === undefined
        ? parsedBatchItemApplied(result.id, result.outcome)
        : batchItemFailed(
            result.id,
            resolveBatchItemFailureCode(result.code) ??
              BatchItemFailureCode.OutcomeUnknown
          )
    ),
  };
}

function batchTagFailureCode(
  result: BatchMutationResponse["results"][number] | undefined
) {
  return result && "code" in result
    ? result.code
    : BatchItemFailureCode.OutcomeUnknown;
}

function parsedBatchItemApplied(
  id: string,
  outcome: BatchItemAppliedOutcome | undefined
) {
  if (outcome === undefined) {
    return batchItemApplied(id);
  }
  return batchItemAppliedWithOutcome(id, outcome);
}
