import type { BranchCostEvidenceContribution } from "@repo/api/src/types/branch-usage";
import type { BranchUsageTokenRow } from "../database/branch-reads.js";
import { readBoundedBranchUsageCostEvidence } from "../database/branch-usage-cost-evidence-read.js";
import type { DbHostPrisma } from "../database/prisma-client.js";
import { buildDesktopBranchCostEvidence } from "./branch-cost-evidence.js";

/**
 * Hydrate bounded persisted evidence and project truthful Desktop completeness.
 *
 * ISS-4941: under an active window `allEventRows` is the WINDOW-BOUNDED event
 * population, not the lifetime corpus (the caller no longer hydrates the whole
 * `token_events` table). Rows with an unusable `created_at` survive that bound,
 * so the invalid-timestamp coverage signal is intact; what re-scopes is the
 * `evidenceExceeded` fallback's `Malformed` reason, which now reflects in-window
 * corruption only. That is deliberate — a windowed metric should not be
 * characterized by data outside its own window.
 */
export async function resolveDesktopBranchCostCompleteness(
  prisma: DbHostPrisma,
  tokenRows: readonly BranchUsageTokenRow[],
  allEventRows: readonly BranchUsageTokenRow[],
  selectedEventRows: readonly BranchUsageTokenRow[],
  windowActive: boolean
): Promise<BranchCostEvidenceContribution[]> {
  const evidenceRead = await readBoundedBranchUsageCostEvidence(
    prisma,
    selectedEventRows.flatMap((row) =>
      row.eventRowId === undefined || row.eventFingerprint === undefined
        ? []
        : [
            {
              eventRowId: row.eventRowId,
              eventFingerprint: row.eventFingerprint,
            },
          ]
    )
  );
  const evidenceByEventRowId = new Map(
    evidenceRead.rows.map((row) => [row.eventRowId, row] as const)
  );
  const evidenceRows = selectedEventRows.flatMap((row) => {
    const payload = row.eventRowId
      ? evidenceByEventRowId.get(row.eventRowId)
      : undefined;
    return payload ? [{ ...row, ...payload }] : [];
  });
  return buildDesktopBranchCostEvidence({
    tokenRows,
    evidenceRows,
    allEventRows,
    subtotalRows: windowActive ? selectedEventRows : tokenRows,
    windowActive,
    evidenceExceeded:
      evidenceRead.exceeded || evidenceRows.length !== selectedEventRows.length,
  });
}
