/**
 * Stack-rank ordering for artifacts inside a project: the grid constant, the
 * next free rank for an append, and where a `moveArtifact` request lands in the
 * current ordering.
 *
 * Split out of `document-service.ts`, which owns document CRUD — deciding an
 * artifact's position in a project ordering is a separate concern from writing
 * the document, and it is pure enough to reason about (and test) on its own.
 */

import {
  type MoveArtifactRequest,
  MovePosition,
} from "@repo/api/src/types/project-artifact-move";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import type { TransactionClient } from "@repo/database";
import { documentWhere } from "@/lib/artifact-adapters";

/**
 * Spacing between consecutive `sortOrder` values when reindexing artifacts.
 *
 * A gap larger than 1 lets `moveArtifact` insert a row between two existing
 * neighbours by writing a single midpoint value rather than rewriting the
 * entire affected window. The matching backfill migration
 * (`20260528220059_backfill_artifact_sort_order`) seeds existing rows on the
 * same grid, so every code path that produces a sortOrder uses this constant.
 */
export const STACK_RANK_GAP = 1000;

/**
 * Tagged error shape returned by `documentService.moveArtifact` (and its
 * internal `resolveInsertIndex` helper). `status` is the HTTP status the
 * route should map to; `message` is the descriptive payload safe to send
 * back to API clients.
 */
export type MoveArtifactError = {
  status: StatusCode;
  message: string;
};

/**
 * Compute the next sortOrder for a brand-new DOCUMENT artifact landing in
 * `projectId`: one full `STACK_RANK_GAP` past the current maximum. Returns
 * `0` when the project is empty.
 *
 * Must be called inside the same `withDb.tx` as the subsequent `create`. The
 * composite index on `(organization_id, project_id, sort_order)` keeps the
 * MAX read cheap. Two concurrent inserts under READ COMMITTED can read the
 * same MAX and write the same value; the project tree compare function
 * tiebreaks on `createdAt` so the visible order stays deterministic, and
 * subsequent user moves will spread the rows back out.
 */
export async function computeNextSortOrder(
  tx: TransactionClient,
  organizationId: string,
  projectId: string
): Promise<number> {
  const max = await tx.artifact.aggregate({
    where: documentWhere({ projectId, organizationId }),
    _max: { sortOrder: true },
  });
  const current = max._max.sortOrder;
  return current === null ? 0 : current + STACK_RANK_GAP;
}

/**
 * Compute the array index at which `input.artifactId` should land after the
 * move. `ids` is the current project ordering INCLUDING the target. The
 * returned index is into the array WITHOUT the target spliced out, ready for
 * `Array#slice`-based insertion.
 *
 * Returns `Result.err` (not a throw) for the validation cases documented in
 * `documentService.moveArtifact` so the route can map them to 4xx instead of
 * 500.
 */
export function resolveInsertIndex(
  ids: readonly string[],
  input: MoveArtifactRequest,
  projectId: string
): Result<number, MoveArtifactError> {
  const withoutTarget = ids.filter((id) => id !== input.artifactId);

  if (input.position === MovePosition.Top) {
    return Result.ok(0);
  }
  if (input.position === MovePosition.Bottom) {
    return Result.ok(withoutTarget.length);
  }
  if (!input.referenceArtifactId) {
    return Result.err({
      status: Status.BadRequest,
      message: `referenceArtifactId is required for position "${input.position}"`,
    });
  }
  if (input.referenceArtifactId === input.artifactId) {
    return Result.err({
      status: Status.BadRequest,
      message: `referenceArtifactId must differ from artifactId (${input.artifactId})`,
    });
  }
  const refIndex = withoutTarget.indexOf(input.referenceArtifactId);
  if (refIndex < 0) {
    return Result.err({
      status: Status.NotFound,
      message: `Reference artifact ${input.referenceArtifactId} not found in project ${projectId}`,
    });
  }
  return Result.ok(
    input.position === MovePosition.Before ? refIndex : refIndex + 1
  );
}
