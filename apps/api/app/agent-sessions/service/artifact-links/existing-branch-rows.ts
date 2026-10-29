import { Prisma } from "@repo/database";
import type { AgentSessionUpsertTx } from "../records";

export type ExistingBranchRow = {
  artifactId: string;
  repositoryFullName: string;
  branchName: string;
  /** The branch artifact already holds an assignee (ISS-12463). */
  assigned: boolean;
};

/**
 * The D2 rows matching `identities`, tombstoned ones included, each with whether
 * its branch artifact is already assigned. One statement: a Prisma relation
 * select for the assignee issues a second query (ISS-12463, measured).
 */
export async function readExistingBranchRows(
  tx: AgentSessionUpsertTx,
  organizationId: string,
  identities: readonly { repositoryFullName: string; branchName: string }[]
): Promise<ExistingBranchRow[]> {
  return await tx.$queryRaw<ExistingBranchRow[]>(Prisma.sql`
    SELECT
      b.artifact_id AS "artifactId",
      b.repository_full_name AS "repositoryFullName",
      b.branch_name AS "branchName",
      a.assignee_id IS NOT NULL AS "assigned"
    FROM branch_detail b
    JOIN artifacts a ON a.id = b.artifact_id
    WHERE b.organization_id = ${organizationId}::uuid
      AND (b.repository_full_name, b.branch_name) IN (
        SELECT * FROM unnest(
          ${identities.map((identity) => identity.repositoryFullName)}::text[],
          ${identities.map((identity) => identity.branchName)}::text[]
        )
      )
  `);
}
