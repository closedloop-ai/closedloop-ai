import { encodeBranchId } from "@repo/api/src/types/branch";
import type { BranchTokenAggregateRow } from "../database/branch-token-aggregate-reads.js";

/** Raw compatibility cost and canonical attributed cost for one branch row. */
export type DesktopBranchListCost = {
  estimatedCostUsd: number | null;
  attributedCostUsd: number | null;
};

/**
 * Group Desktop token aggregates into the two distinct Branch wire costs.
 * Raw cost remains replicated for older clients, while attributed cost is the
 * canonical even split. A priced zero remains zero and an entirely unpriced
 * branch remains null.
 */
export function projectDesktopBranchListCosts(
  tokenRows: readonly BranchTokenAggregateRow[]
): ReadonlyMap<string, DesktopBranchListCost> {
  const rowsByBranch = new Map<string, BranchTokenAggregateRow[]>();
  for (const row of tokenRows) {
    const id = encodeBranchId({
      repoFullName: row.repoFullName,
      branchName: row.branchName,
    });
    const rows = rowsByBranch.get(id) ?? [];
    rows.push(row);
    rowsByBranch.set(id, rows);
  }

  return new Map(
    [...rowsByBranch].map(([id, rows]) => [
      id,
      {
        estimatedCostUsd: sumNullableCosts(
          rows,
          (row) => row.rawCostUsdEstimated
        ),
        attributedCostUsd: sumNullableCosts(
          rows,
          (row) => row.costUsdEstimated
        ),
      },
    ])
  );
}

function sumNullableCosts(
  rows: readonly BranchTokenAggregateRow[],
  selectCost: (row: BranchTokenAggregateRow) => number | null
): number | null {
  let total = 0;
  let anyPriced = false;
  for (const row of rows) {
    const cost = selectCost(row);
    if (cost === null) {
      continue;
    }
    total += cost;
    anyPriced = true;
  }
  return anyPriced ? total : null;
}
