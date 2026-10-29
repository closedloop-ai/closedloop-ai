import assert from "node:assert/strict";
import { BranchStatus } from "@repo/api/src/types/branch";
import {
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BranchListLastActiveRange,
  BranchListPageMode,
  BranchListPullRequestPresence,
  BranchListSortDirection,
  BranchListSortKey,
} from "@repo/api/src/types/branch-list-contract";
import { describe, test } from "vitest";
import { toDesktopBranchServerPageQuery } from "../src/main/branch/branch-server-page-query.js";

describe("desktop Branch server-page query", () => {
  test("applies the canonical first-page defaults", () => {
    assert.deepEqual(toDesktopBranchServerPageQuery({}), {
      pageMode: BranchListPageMode.Server,
      limit: BRANCH_LIST_SERVER_PAGE_SIZE,
      offset: 0,
      sortKey: BranchListSortKey.LastActivity,
      sortDir: BranchListSortDirection.Desc,
    });
  });

  test("preserves every optional filter and explicit zero bound", () => {
    const query = toDesktopBranchServerPageQuery({
      limit: BRANCH_LIST_SERVER_PAGE_SIZE,
      offset: BRANCH_LIST_SERVER_PAGE_SIZE * 2,
      startDate: "2026-08-01T00:00:00.000Z",
      endDate: "2026-08-20T00:00:00.000Z",
      names: ["feature/a"],
      owners: ["owner-1"],
      collaborators: ["collaborator-1"],
      statuses: [BranchStatus.Open],
      pullRequests: [BranchListPullRequestPresence.Linked],
      lastActiveRanges: [BranchListLastActiveRange.WithinLastHour],
      repositories: ["acme/web"],
      tags: ["coverage"],
      locMin: 0,
      locMax: 0,
      sortKey: BranchListSortKey.Name,
      sortDir: BranchListSortDirection.Asc,
    });

    assert.deepEqual(query, {
      pageMode: BranchListPageMode.Server,
      limit: BRANCH_LIST_SERVER_PAGE_SIZE,
      offset: BRANCH_LIST_SERVER_PAGE_SIZE * 2,
      startDate: "2026-08-01T00:00:00.000Z",
      endDate: "2026-08-20T00:00:00.000Z",
      names: ["feature/a"],
      owners: ["owner-1"],
      collaborators: ["collaborator-1"],
      statuses: [BranchStatus.Open],
      pullRequests: [BranchListPullRequestPresence.Linked],
      lastActiveRanges: [BranchListLastActiveRange.WithinLastHour],
      repositories: ["acme/web"],
      tags: ["coverage"],
      locMin: 0,
      locMax: 0,
      sortKey: BranchListSortKey.Name,
      sortDir: BranchListSortDirection.Asc,
    });
  });

  test("rejects unaligned pages and inverted LOC bounds", () => {
    assert.throws(() => toDesktopBranchServerPageQuery({ offset: 1 }));
    assert.throws(() =>
      toDesktopBranchServerPageQuery({ locMin: 10, locMax: 5 })
    );
  });
});
