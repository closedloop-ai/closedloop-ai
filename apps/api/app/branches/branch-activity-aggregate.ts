import { Prisma, type TransactionClient } from "@repo/database";
import { canonicalBranchActivityAtomEligibilitySql } from "./branch-activity-canonical-read";

type BranchActivityAggregateClient = Pick<TransactionClient, "$executeRaw">;

/**
 * Recompute compatibility Last-active scalars from trustworthy immutable atoms.
 * This may lower or clear a legacy future-poisoned scalar; callers must pass a
 * bounded set of organization-owned Branch ids from their current transaction.
 */
export async function recomputeBranchActivityAggregatesInTransaction(
  tx: BranchActivityAggregateClient,
  input: {
    organizationId: string;
    branchArtifactIds: readonly string[];
    /** Source Branches whose moved atoms now define an exact replacement. */
    exactReplacementBranchArtifactIds?: readonly string[];
  }
): Promise<void> {
  const branchArtifactIds = [...new Set(input.branchArtifactIds)];
  if (branchArtifactIds.length === 0) {
    return;
  }
  const exactReplacementBranchArtifactIds = [
    ...new Set(input.exactReplacementBranchArtifactIds ?? []),
  ].filter((branchArtifactId) => branchArtifactIds.includes(branchArtifactId));
  const exactReplacementPredicate =
    exactReplacementBranchArtifactIds.length === 0
      ? Prisma.sql`FALSE`
      : Prisma.sql`branch.artifact_id IN (${Prisma.join(
          exactReplacementBranchArtifactIds
        )})`;
  // NO KEY UPDATE, not UPDATE (ISS-10331): an atom-persist caller has just
  // inserted an atom whose FK holds KEY SHARE on this row, and FOR UPDATE
  // conflicts with KEY SHARE, so two concurrent writers on one Branch
  // deadlocked. NO KEY UPDATE still serializes recomputes; the UPDATE below
  // touches no key column. The relink caller's own ownership lock on these
  // rows takes NO KEY UPDATE too since ISS-10349, so the last plain FOR UPDATE
  // on this path is gone and the deadlock class is closed on both sides.
  await tx.$executeRaw(Prisma.sql`
    WITH locked_branches AS MATERIALIZED (
      SELECT branch.*
      FROM branch_detail AS branch
      WHERE branch.organization_id = ${input.organizationId}::uuid
        AND branch.artifact_id IN (${Prisma.join(branchArtifactIds)})
      ORDER BY branch.artifact_id
      FOR NO KEY UPDATE OF branch
    ), derived AS (
      SELECT
        branch.organization_id,
        branch.artifact_id,
        MAX(atom.occurred_at) AS last_activity_at
      FROM locked_branches AS branch
      LEFT JOIN branch_activity_atoms AS atom
        ON atom.organization_id = branch.organization_id
       AND atom.branch_artifact_id = branch.artifact_id
       AND ${canonicalBranchActivityAtomEligibilitySql(
         Prisma.sql`branch.organization_id`,
         Prisma.sql`branch.artifact_id`
       )}
      GROUP BY branch.organization_id, branch.artifact_id
    ), resolved AS (
      SELECT
        branch.organization_id,
        branch.artifact_id,
        CASE
          WHEN ${exactReplacementPredicate} THEN derived.last_activity_at
          WHEN EXISTS (
            SELECT 1
            FROM branch_activity_atoms AS poisoned
            WHERE poisoned.organization_id = branch.organization_id
              AND poisoned.branch_artifact_id = branch.artifact_id
              AND poisoned.occurred_at = branch.last_activity_at
              AND poisoned.occurred_at > poisoned.created_at + INTERVAL '24 hours'
          ) THEN derived.last_activity_at
          WHEN branch.last_activity_at IS NULL THEN derived.last_activity_at
          WHEN derived.last_activity_at IS NULL THEN branch.last_activity_at
          ELSE GREATEST(branch.last_activity_at, derived.last_activity_at)
        END AS last_activity_at
      FROM locked_branches AS branch
      INNER JOIN derived
        ON derived.organization_id = branch.organization_id
       AND derived.artifact_id = branch.artifact_id
    )
    UPDATE branch_detail AS branch
    SET last_activity_at = resolved.last_activity_at,
        updated_at = now()
    FROM resolved
    WHERE branch.organization_id = resolved.organization_id
      AND branch.artifact_id = resolved.artifact_id
      AND branch.last_activity_at IS DISTINCT FROM resolved.last_activity_at
  `);
}
