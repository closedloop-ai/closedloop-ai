import { withDb } from "@repo/database";
import type { InvariantCheckResult } from "./service";

/**
 * One statement for the count and the sample, so the two describe the same
 * snapshot: `COUNT(*) OVER ()` is evaluated before `LIMIT`, so it is the whole
 * population, not the page.
 */
export function checkCrossOrgProjectAssignees(
  sampleLimit: number
): Promise<InvariantCheckResult> {
  return withDb(async (db) => {
    const rows = await db.$queryRaw<Array<{ id: string; total: bigint }>>`
      SELECT p.id::text AS id, COUNT(*) OVER () AS total
      FROM projects p
      JOIN users u ON u.id = p.assignee_id
      WHERE u.organization_id <> p.organization_id
      ORDER BY p.id
      LIMIT ${sampleLimit}
    `;
    return {
      count: Number(rows[0]?.total ?? 0n),
      sampleIds: rows.map((row) => row.id),
    };
  });
}
