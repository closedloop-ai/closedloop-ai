import {
  BranchStatus,
  type BranchRow as WireBranchRow,
} from "@repo/api/src/types/branch";
import {
  BranchIdentityAvailability,
  BranchPersonProvider,
} from "@repo/api/src/types/branch-identity";
import {
  BranchListSortDirection,
  BranchListSortKey,
} from "@repo/api/src/types/branch-list-contract";
import { TableGroupOrder } from "@repo/design-system/components/ui/table-toolbar-model";
import { describe, expect, it } from "vitest";
import {
  parseBranchFilterParams,
  parseBranchGroupViewParams,
} from "../branch-filter-params";
import { filterBranchRows } from "../branch-row";
import { adaptBranchRows } from "../branch-row-adapter";
import { buildBranchServerPageFilters } from "../branch-server-page-query";

/**
 * ISS-12463 (AC-012): the Branch Owner is now the branch's assignee, and the
 * wire keys it under the same `closedloop:<userId>` it always used. A bookmark
 * saved before the switch therefore keeps parsing, keeps asking the server for
 * the same `owners`, and still narrows a list response to the assignee's rows.
 */

const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const ASSIGNEE_ID = "user-assignee";
const OTHER_ID = "user-other";
const ASSIGNEE_KEY = `${BranchPersonProvider.ClosedLoop}:${ASSIGNEE_ID}`;
const BOOKMARK = new URLSearchParams(
  `owner=${ASSIGNEE_KEY}&group=owner:${TableGroupOrder.Ascending}`
);

describe("an Owner bookmark after the assignee switch", () => {
  it("parses ?owner and ?group=owner unchanged and sends the same owners filter", () => {
    const filters = parseBranchFilterParams(BOOKMARK);

    expect(filters.owners).toEqual([ASSIGNEE_KEY]);
    expect(parseBranchGroupViewParams(BOOKMARK)?.grouping.primary).toEqual({
      fieldId: "owner",
      order: TableGroupOrder.Ascending,
      showEmptyGroups: false,
    });
    expect(
      buildBranchServerPageFilters({
        filters,
        page: 0,
        sortKey: BranchListSortKey.Owner,
        sortDir: BranchListSortDirection.Asc,
      }).owners
    ).toEqual([ASSIGNEE_KEY]);
  });

  it("narrows a list response to the rows whose assignee the bookmark names", () => {
    const rows = adaptBranchRows(
      [
        wireRow("assigned", ASSIGNEE_ID, "Ada Assignee"),
        wireRow("other", OTHER_ID, "Olu Other"),
      ],
      { now: NOW }
    );

    expect(
      filterBranchRows(rows, parseBranchFilterParams(BOOKMARK), {
        now: NOW,
        approved: true,
      }).map((row) => row.branchName)
    ).toEqual(["assigned"]);
  });
});

/** A list response row whose Owner is the branch's assignee, as the API serves it. */
function wireRow(
  branchName: string,
  assigneeId: string,
  displayName: string
): WireBranchRow {
  return {
    id: branchName,
    branchName,
    baseBranch: "main",
    repoFullName: "acme/web",
    owner: displayName,
    ownerIdentity: {
      availability: BranchIdentityAvailability.Complete,
      person: {
        provider: BranchPersonProvider.ClosedLoop,
        id: assigneeId,
        userId: assigneeId,
        displayName,
      },
    },
    status: BranchStatus.Open,
    prNumber: null,
    prTitle: null,
    prState: null,
    prUrl: null,
    multiPrWarning: false,
    checksStatus: null,
    checksPassed: null,
    checksTotal: null,
    reviewDecision: null,
    ahead: null,
    behind: null,
    additions: null,
    deletions: null,
    filesChanged: null,
    estimatedCostUsd: null,
    lastActivityAt: "2026-10-19T11:00:00.000Z",
    sessionIds: [],
  };
}
