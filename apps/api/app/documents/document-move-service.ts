import "server-only";

import { ArtifactType } from "@repo/api/src/types/artifact";
import type { MoveArtifactRequest } from "@repo/api/src/types/project-artifact-move";
import { Result, Status } from "@repo/api/src/types/result";
import { Prisma, withDb } from "@repo/database";
import {
  checkExpectedOrder,
  lockProjectRank,
  type MoveArtifactError,
  resolveInsertIndex,
  STACK_RANK_GAP,
} from "@/app/documents/document-sort-order";
import { documentWhere } from "@/lib/artifact-adapters";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";

/**
 * Stack-rank WRITES for the artifacts inside one project: the batch reindex and
 * the single-item move built on it (PRD-421).
 *
 * Split out of `document-service.ts`, which owns document CRUD. Rewriting a
 * project's ordering is a separate responsibility from writing a document — the
 * sibling `document-sort-order.ts` already owns the pure half of it (where a
 * move lands, what the next free rank is, whether a caller's precondition
 * holds), and this module is the persistence half that applies those answers.
 * `document-service.ts` re-exports both as delegates, so every existing caller
 * is unaffected, exactly as `documentDeleteService` and `documentListRead` are
 * reached today.
 */
export const documentMoveService = {
  /**
   * Reorder documents in a project by setting sortOrder values atomically.
   * Validates that every documentId belongs to the supplied project AND the
   * caller's organization.
   *
   * Performance: a single `UPDATE … FROM (VALUES …)` statement updates every
   * row in one Postgres round-trip regardless of input size, instead of one
   * round-trip per row. The validation `findMany` adds one more query for a
   * total of 2 statements per call.
   *
   * Caller assigns sortOrder by array position: `documentIds[i]` → sortOrder
   * = `i * STACK_RANK_GAP`. The caller is responsible for choosing the gap
   * strategy (full reindex vs. affected-window-only). For single-item moves,
   * prefer {@link documentMoveService.moveArtifact}, which computes a minimal
   * affected window internally.
   */
  reorder(
    projectId: string,
    documentIds: string[],
    organizationId: string
  ): Promise<string[]> {
    if (documentIds.length === 0) {
      return Promise.resolve([]);
    }

    const uniqueIds = [...new Set(documentIds)];

    return withDb.tx(async (tx) => {
      const artifacts = await tx.artifact.findMany({
        where: documentWhere({
          id: { in: uniqueIds },
          projectId,
          organizationId,
        }),
        select: { id: true },
      });

      if (artifacts.length !== uniqueIds.length) {
        const foundIds = new Set(artifacts.map((a: { id: string }) => a.id));
        const missingIds = uniqueIds.filter((id) => !foundIds.has(id));
        throw new Error(
          `Invalid artifact IDs for project ${projectId}: ${missingIds.join(", ")} not found in organization`
        );
      }

      const valueRows = uniqueIds.map(
        (id, index) => Prisma.sql`(${id}::uuid, ${index * STACK_RANK_GAP}::int)`
      );
      await tx.$executeRaw(Prisma.sql`
        UPDATE "artifacts"
        SET "sort_order" = data.new_order
        FROM (VALUES ${Prisma.join(valueRows)}) AS data(id, new_order)
        WHERE "artifacts"."id" = data.id
          AND "artifacts"."organization_id" = ${organizationId}::uuid
          AND "artifacts"."project_id" = ${projectId}::uuid
          AND "artifacts"."type" = ${ArtifactType.Document}::"ArtifactType"
      `);

      return uniqueIds;
    });
  },

  /**
   * Move one root DOCUMENT artifact to a new position in its project's stack
   * rank. Single-item primitive that backs drag-drop, keyboard ⌘↑/⌘↓, and the
   * row-menu "Move to top" / "Move to bottom" actions in the project page
   * (PRD-421).
   *
   * Implementation: fetches the current project ordering, splices the moved
   * id into the requested slot, and delegates to `reorder` which rewrites
   * sortOrder for every row of the project in a single SQL statement. The
   * gap-based midpoint optimisation that would touch only O(window) rows is
   * deferred — the simpler full-project reindex is correct, easy to test, and
   * runs in a single `UPDATE … FROM (VALUES …)` round-trip (FEA-821), which
   * stays well under the 250ms p95 target even for PRO-16's 834 artifacts.
   *
   * Returns `Result.err` for client-error paths the route maps to 4xx (per
   * apps/api/AGENTS.md "Errors as values"):
   *  - `Status.Conflict` — the caller supplied an `expectedOrder` precondition
   *    and the transaction observed a different ordering (ISS-8728). Nothing is
   *    written; the caller re-reads and retries.
   *  - `Status.NotFound` — `artifactId` not in `projectId` OR
   *    `referenceArtifactId` not in the same project. A caller with a stale
   *    id should not see a 500.
   *  - `Status.BadRequest` — `referenceArtifactId` equals `artifactId`
   *    (ambiguous), or `Before`/`After` is missing `referenceArtifactId`
   *    (the Zod validator already catches the latter at the boundary; the
   *    service still guards defensively).
   */
  moveArtifact(
    projectId: string,
    organizationId: string,
    input: MoveArtifactRequest,
    recordMoved?: RecordWriteInTransaction<{
      newSortOrder: number;
      /** The artifact's place in the project's order moved. */
      positionChanged: boolean;
    }>
  ): Promise<Result<{ newSortOrder: number }, MoveArtifactError>> {
    return withDb.tx(async (tx) => {
      // The transaction's FIRST statement, and what makes the precondition below
      // more than advice. `checkExpectedOrder` inside one transaction is still a
      // read-then-write: under READ COMMITTED two movers can observe the same
      // ordering, both pass, and the later unconditional rewrite discards the
      // earlier one — the precise lost update ISS-8728 exists to refuse. A
      // waiter resumes after the winner COMMITTED and re-reads its order below,
      // so it answers 409 instead. Shared with `artifactBulkRankService`, which
      // rewrites the same column (codex P1, PR #7201).
      await lockProjectRank(tx, projectId);

      const orderedRoots = await tx.artifact.findMany({
        where: documentWhere({ projectId, organizationId }),
        // `id` last, so the sequence is a TOTAL order. `sortOrder` is not
        // unique (NULLs, and two rows can share a rank) and `createdAt` is not
        // either — rows written in one transaction routinely share a
        // millisecond. With both tied the database may hand back either order,
        // so two reads could disagree, and this sequence is what an
        // `expectedOrder` is compared against and what the rewrite below is
        // computed from. Same three keys, in the same directions, as
        // `compareStackRankKeys` (codex P2, PR #7201).
        orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }, { id: "asc" }],
        select: { id: true },
      });
      const ids = orderedRoots.map((row) => row.id);

      // ISS-8728: checked FIRST, before anything else is read off `ids`. If the
      // ordering moved under the caller, every other conclusion drawn from its
      // stale read — which artifact, which reference, which slot — is drawn
      // from a project state that no longer exists, so reporting a not-found
      // for an id the caller saw a moment ago would name the wrong cause.
      const precondition = checkExpectedOrder(ids, input.expectedOrder);
      if (!precondition.ok) {
        return precondition;
      }

      if (!ids.includes(input.artifactId)) {
        return Result.err({
          status: Status.NotFound,
          message: `Artifact ${input.artifactId} not found in project ${projectId}`,
        });
      }
      const indexResult = resolveInsertIndex(ids, input, projectId);
      if (!indexResult.ok) {
        return indexResult;
      }
      const insertIndex = indexResult.value;

      const withoutTarget = ids.filter((id) => id !== input.artifactId);
      const newOrder = [
        ...withoutTarget.slice(0, insertIndex),
        input.artifactId,
        ...withoutTarget.slice(insertIndex),
      ];

      // Through the object, not by direct reference, so the reorder is
      // interceptable in tests — the same idiom `documentListRead` uses.
      // The inner `withDb.tx` participates in THIS transaction via
      // AsyncLocalStorage, so the read and the write stay atomic.
      await documentMoveService.reorder(projectId, newOrder, organizationId);

      const moved = { newSortOrder: insertIndex * STACK_RANK_GAP };
      await recordMoved?.(tx, {
        ...moved,
        positionChanged: newOrder.some((id, index) => id !== ids[index]),
      });
      return Result.ok(moved);
    });
  },
};
