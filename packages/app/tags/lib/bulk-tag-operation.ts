import { BATCH_MUTATION_ENTITY_LIMIT } from "@repo/api/src/types/batch-mutation-limits";
import type { BatchMutationResponse } from "@repo/api/src/types/batch-mutation-result";
import { getFriendlyError } from "../../shared/api/api-error";
import type { BulkTagMutation as BulkTagMutationValue } from "./bulk-tag-mutation";
import {
  type BulkTagTarget,
  canonicalizeBulkTagArtifactId,
  resolveBulkTagOutcome,
} from "./bulk-tag-outcome";

/** Runs either tag mutation in shared bounded chunks with per-row outcomes. */
export async function performBulkTagMutation({
  targets,
  applyBatch,
  isCurrent,
  operation,
}: {
  targets: readonly BulkTagTarget[];
  applyBatch: (artifactIds: string[]) => Promise<BatchMutationResponse>;
  isCurrent: () => boolean;
  operation: BulkTagMutationValue;
}) {
  const byArtifact = groupTagTargets(targets);
  const artifactIds = [...byArtifact.keys()];
  const succeededIds: string[] = [];
  const failedIds: string[] = [];
  const removedIds: string[] = [];
  const notPresentIds: string[] = [];
  const messages = new Set<string>();
  for (
    let offset = 0;
    offset < artifactIds.length;
    offset += BATCH_MUTATION_ENTITY_LIMIT
  ) {
    if (!isCurrent()) {
      break;
    }
    const chunk = artifactIds.slice(
      offset,
      offset + BATCH_MUTATION_ENTITY_LIMIT
    );
    const chunkTargets = chunk.flatMap((id) => byArtifact.get(id) ?? []);
    try {
      const result = resolveBulkTagOutcome(
        chunkTargets,
        await applyBatch(chunk),
        operation
      );
      succeededIds.push(...result.succeededIds);
      failedIds.push(...result.failedIds);
      removedIds.push(...result.removedIds);
      notPresentIds.push(...result.notPresentIds);
      for (const message of result.messages) {
        messages.add(message);
      }
    } catch (error) {
      failedIds.push(...chunkTargets.map((target) => target.rowId));
      messages.add(getFriendlyError(error).description);
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

function groupTagTargets(targets: readonly BulkTagTarget[]) {
  const result = new Map<string, BulkTagTarget[]>();
  for (const target of targets) {
    if (target.canApply && target.artifactId) {
      const artifactId = canonicalizeBulkTagArtifactId(target.artifactId);
      const rows = result.get(artifactId) ?? [];
      rows.push(target);
      result.set(artifactId, rows);
    }
  }
  return result;
}
