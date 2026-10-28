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
  MOVE_ARTIFACT_CONFLICT,
  type MoveArtifactRequest,
  MovePosition,
} from "@repo/api/src/types/project-artifact-move";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import { Prisma, type TransactionClient } from "@repo/database";
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

/**
 * Check a caller's `expectedOrder` precondition against the ordering the move
 * transaction actually observed (ISS-8728).
 *
 * WHY THE SERVER OWNS THIS. The stack-rank writer used to re-read the tree
 * before every move and compare it client-side. That narrows the window from a
 * whole run to one GET/POST pair, but it cannot close it: a reorder landing
 * between the caller's read and its write is still overwritten, and the
 * divergence is only noticed on the NEXT iteration's read — after the damage.
 * Compared here, inside the same transaction as the write, the check and the
 * mutation observe one snapshot, so a mismatch is a refusal rather than a
 * partial apply (PR #6361 review, codex P2 / davetho P1).
 *
 * EXACT SEQUENCE EQUALITY, not set equality. The precondition is about ORDER:
 * two roots swapping places leaves the set identical and is precisely the
 * concurrent edit this exists to catch. Length is compared first so an
 * added-or-removed root is reported as the ordering change it is.
 *
 * `undefined` means the caller sent no precondition, which is the shipped
 * last-write-wins contract and must stay a pass — that branch is what keeps
 * drag-drop, keyboard move, the row menu, MCP agents, and any older deployed
 * bundle working unchanged.
 */
export function checkExpectedOrder(
  observedOrder: readonly string[],
  expectedOrder: readonly string[] | undefined
): Result<null, MoveArtifactError> {
  if (expectedOrder === undefined) {
    return Result.ok(null);
  }
  const matches =
    expectedOrder.length === observedOrder.length &&
    expectedOrder.every((id, index) => id === observedOrder[index]);
  if (matches) {
    return Result.ok(null);
  }
  return Result.err({
    status: Status.Conflict,
    message: `${MOVE_ARTIFACT_CONFLICT}: expected ${expectedOrder.length} root artifacts in the order supplied, found ${observedOrder.length} in a different order. Re-read the project and retry.`,
  });
}

/**
 * `pg_advisory_xact_lock` classid for the project-wide rank write, so the
 * per-project key below shares a namespace with nothing else.
 */
const PROJECT_RANK_LOCK_NAMESPACE = 8999;

/**
 * Serialize this project's rank writes against each other for the life of `tx`.
 *
 * ONE lock for both writers. `artifactBulkRankService` and
 * `documentMoveService.moveArtifact` rewrite the same `sort_order` column, so a
 * lock held privately by either would serialize that writer against itself and
 * not against the other — two mechanisms that exclude nothing between them. It
 * lives here, beside the pure rank helpers, because both services already
 * import this module and neither can import the other (`artifact-bulk-rank-
 * service` → `document-service` → `document-move-service` is a cycle).
 *
 * WHY A READ-THEN-WRITE NEEDS IT. Both callers read the current ordering,
 * decide against it, and then rewrite it. Under READ COMMITTED two callers can
 * each observe the same pre-state, each pass their own precondition
 * (`expectedRankEpoch` for bulk rank, `checkExpectedOrder` for a move), and each
 * write — no unique violation, no conflict reported, both answered 200, and the
 * second write silently discarding the first. Putting the read and the write in
 * one transaction gives atomicity, which is not isolation and does not close
 * this.
 *
 * Taken as the transaction's FIRST statement. A caller that waits here resumes
 * after the winner COMMITTED, and READ COMMITTED gives every statement after
 * the wait a fresh snapshot, so the waiter's own ordering read observes the
 * winner's order and its precondition answers 409 rather than overwriting it.
 *
 * Advisory rather than `SELECT … FROM projects FOR UPDATE`: the rank is not the
 * project row, and a row lock would block every unrelated project update behind
 * a rank rewrite. Postgres releases it at COMMIT or ROLLBACK, so no path leaks
 * it.
 */
export function lockProjectRank(
  tx: TransactionClient,
  projectId: string
): Promise<number> {
  // `$executeRaw`, not `$queryRaw`: the lock function returns `void`, and
  // Prisma's query path fails to deserialize a void column.
  return tx.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(${PROJECT_RANK_LOCK_NAMESPACE}::int4, hashtext(${projectId}::text))`
  );
}
