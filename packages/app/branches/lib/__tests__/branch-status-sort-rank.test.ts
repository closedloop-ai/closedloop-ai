import { BRANCH_STATUS_SORT_ORDER } from "@repo/api/src/types/branch-status-order";
import { branchRow } from "@repo/app/branches/lib/__tests__/branch-row-fixture";
import {
  BRANCH_STATUS_CONFIG,
  type BranchRow,
  BranchRowStatus,
} from "@repo/app/branches/lib/branch-row";
import {
  BranchSortDir,
  BranchSortKey,
  sortBranchRows,
} from "@repo/app/branches/lib/branch-sort-group";
import { afterEach, describe, expect, it } from "vitest";

/**
 * ISS-9666 — Branches status order is DATA, not the display string.
 *
 * Both comparators used to sort on `BRANCH_STATUS_CONFIG[status].label` via
 * `localeCompare`, so the table's row order was a function of copy: renaming
 * "Changes requested" or translating "In review" silently reordered rows for
 * every reader. These tests rename the labels at runtime and require the order
 * to hold.
 */
const ORIGINAL_LABELS = new Map<string, string>(
  Object.entries(BRANCH_STATUS_CONFIG).map(
    ([status, config]) => [status, config.label] as const
  )
);

afterEach(() => {
  for (const [status, label] of ORIGINAL_LABELS) {
    BRANCH_STATUS_CONFIG[status as BranchRowStatus].label = label;
  }
});

describe("branch status sorting is independent of the display label", () => {
  it("keeps row order after every status label is renamed (approved comparator)", () => {
    const before = ids(
      sortBranchRows(statusRows(), BranchSortKey.Status, BranchSortDir.Asc)
    );

    renameEveryLabelToReverseAlphabetical();

    expect(
      ids(sortBranchRows(statusRows(), BranchSortKey.Status, BranchSortDir.Asc))
    ).toEqual(before);
  });

  it("keeps row order after every status label is renamed (legacy comparator)", () => {
    const before = ids(
      sortBranchRows(
        statusRows(),
        BranchSortKey.Status,
        BranchSortDir.Asc,
        false
      )
    );

    renameEveryLabelToReverseAlphabetical();

    expect(
      ids(
        sortBranchRows(
          statusRows(),
          BranchSortKey.Status,
          BranchSortDir.Asc,
          false
        )
      )
    ).toEqual(before);
  });

  it("orders rows by the canonical rank, spelled out independently", () => {
    // Pinned to literal status values rather than read back off
    // BRANCH_STATUS_SORT_ORDER, which is the thing under test.
    expect(
      ids(sortBranchRows(statusRows(), BranchSortKey.Status, BranchSortDir.Asc))
    ).toEqual(["open", "review", "merged", "draft", "blocked", "closed"]);
    expect(BRANCH_STATUS_SORT_ORDER).toEqual([
      "open",
      "review",
      "merged",
      "draft",
      "blocked",
      "closed",
    ]);
  });
});

/**
 * Reverse-alphabetical labels: under the old comparator this maximally inverts
 * the ordering, so a comparator that still reads a label cannot pass by luck.
 */
function renameEveryLabelToReverseAlphabetical(): void {
  const statuses: string[] = [...ORIGINAL_LABELS.keys()].sort().reverse();
  for (const [index, status] of statuses.entries()) {
    BRANCH_STATUS_CONFIG[status as BranchRowStatus].label =
      `zz-${index}-${status}`;
  }
}

function statusRows(): BranchRow[] {
  // Deliberately shuffled relative to the canonical rank.
  return [
    BranchRowStatus.Closed,
    BranchRowStatus.Open,
    BranchRowStatus.Draft,
    BranchRowStatus.Merged,
    BranchRowStatus.Blocked,
    BranchRowStatus.Review,
  ].map((status) =>
    branchRow({ id: status, canonicalIdentity: status, status })
  );
}

function ids(rows: BranchRow[]): string[] {
  return rows.map((entry) => entry.id);
}
