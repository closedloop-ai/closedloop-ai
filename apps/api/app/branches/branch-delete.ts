import { ArtifactType, withDb } from "@repo/database";
import { isUuid } from "@/lib/is-uuid";
import {
  type RecordWriteInTransaction,
  writeInShape,
} from "@/lib/record-write-in-transaction";

/**
 * Delete a branch artifact (and its nested PR state) by id, scoped to the
 * caller's organization. Mirrors document deletion: it removes the platform
 * record only; it does NOT touch the underlying git branch or GitHub PR.
 *
 * The DB cascade handles every dependent row: `BranchDetail`,
 * `BranchStatusCheck`, `BranchFileChange`, `PullRequestDetail` (FK
 * `branch_artifact_id` is ON DELETE CASCADE), `ArtifactLink`, `LinearSubtask`,
 * and favorites. `DeploymentDetail.branchArtifactId` is ON DELETE SET NULL, so
 * deployment records are preserved and merely unlinked.
 *
 * Returns `true` when a branch artifact was deleted, `false` when no branch
 * artifact with that id exists in the organization (so the route can answer
 * 404 without deleting documents or deployments through this endpoint).
 * Recorded, `recordWrite` runs on the delete's transaction only when a row
 * was deleted, so a receipt that cannot be stored keeps the branch
 * (ISS-12552); unrecorded, the delete is main's single autocommit statement.
 */
export async function deleteBranchArtifact(
  id: string,
  organizationId: string,
  recordWrite?: RecordWriteInTransaction<{ artifactId: string }>
): Promise<boolean> {
  // Branch artifacts carry no slug; they are referenced by UUID only. A
  // non-UUID id can never match, and would otherwise blow up the `@db.Uuid`
  // column comparison.
  if (!isUuid(id)) {
    return false;
  }
  // Single atomic query: the type guard lives in the WHERE clause, so there is
  // no check-then-delete race, and `deleteMany` is idempotent: a concurrent
  // double-delete yields `count: 0` (mapped to 404 by the route) instead of a
  // P2025 throw.
  return await writeInShape(recordWrite, {
    unrecorded: async () => {
      const result = await withDb((db) =>
        db.artifact.deleteMany({
          where: { id, organizationId, type: ArtifactType.BRANCH },
        })
      );
      return result.count > 0;
    },
    recorded: (record) =>
      withDb.tx(async (tx) => {
        const result = await tx.artifact.deleteMany({
          where: { id, organizationId, type: ArtifactType.BRANCH },
        });
        if (result.count === 0) {
          return false;
        }
        await record(tx, { artifactId: id });
        return true;
      }),
  });
}
