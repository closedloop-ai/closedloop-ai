import { withDb } from "@repo/database";
import {
  type AgentSessionCsvExportRow,
  collectAggregatedCsvExportRows,
} from "./csv-export";
import type { SessionUsageInput } from "./records";
import { buildUsageSummaryWhere } from "./usage-summary-where";

export async function findAgentSessionExportRows(
  input: SessionUsageInput
): Promise<{ rows: AgentSessionCsvExportRow[]; orgSlug: string | null }> {
  const where = await buildUsageSummaryWhere(input);

  const [organization, rows] = await Promise.all([
    withDb((db) =>
      db.organization.findUnique({
        where: { id: input.organizationId },
        select: { slug: true },
      })
    ),
    collectAggregatedCsvExportRows(where),
  ]);

  return { rows, orgSlug: organization?.slug ?? null };
}
