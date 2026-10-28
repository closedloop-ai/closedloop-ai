import { describe, expect, it, vi } from "vitest";
import {
  BRANCH_FILE_CHANGE_TOTALS_ID_CHUNK_SIZE,
  getBranchFileChangeTotals,
} from "./file-change-totals-read";
import {
  BRANCH_ROW_HYDRATION_BATCH_SIZE,
  getBranchRowsById,
} from "./persisted-row-read";

/**
 * ISS-10298 — the shape of the file-change work a Branch read does.
 *
 * `GET /branches?pageMode=server` reads the whole eligible corpus before
 * slicing a page, and every one of those branches used to arrive with up to 500
 * `branch_file_changes` ROWS attached so three numbers could be summed in
 * JavaScript. What is pinned here is that the read is now per-BRANCH: one
 * grouped statement per id chunk, no per-file rows on the hydration select, and
 * no statement-per-branch loop.
 *
 * The chunk bound is asserted against a real over-size id set, not read back
 * from the constant, because an unchunked `in` is exactly the failure the bound
 * exists to prevent (`apps/api/AGENTS.md` → Bound every predicate).
 */

const ORGANIZATION_ID = "org-1";

describe("getBranchFileChangeTotals", () => {
  it("issues no statement at all for an empty id set", async () => {
    const groupBy = vi.fn();

    const totals = await getBranchFileChangeTotals(
      { branchFileChange: { groupBy } } as never,
      ORGANIZATION_ID,
      []
    );

    expect(groupBy).not.toHaveBeenCalled();
    expect(totals.size).toBe(0);
  });

  it("folds a whole batch in ONE grouped statement, not one per branch", async () => {
    const branchIds = idsOfLength(250);
    const groupBy = vi.fn().mockResolvedValue([]);

    await getBranchFileChangeTotals(
      { branchFileChange: { groupBy } } as never,
      ORGANIZATION_ID,
      branchIds
    );

    expect(groupBy).toHaveBeenCalledTimes(1);
    expect(groupBy.mock.calls[0]?.[0]?.where).toEqual({
      branchArtifactId: { in: branchIds },
      branch: { artifact: { organizationId: ORGANIZATION_ID } },
    });
  });

  it("folds a branch caught mid-refresh to unknown, not to a sum across two heads", async () => {
    const groupBy = vi.fn().mockResolvedValue([
      {
        branchArtifactId: "branch-1",
        headSha: "old-sha",
        _sum: { additions: 10, deletions: 5 },
        _count: { _all: 1, additions: 1, deletions: 1 },
      },
      {
        branchArtifactId: "branch-1",
        headSha: "new-sha",
        _sum: { additions: 400, deletions: 200 },
        _count: { _all: 3, additions: 3, deletions: 3 },
      },
    ]);

    const totals = await getBranchFileChangeTotals(
      { branchFileChange: { groupBy } } as never,
      ORGANIZATION_ID,
      ["branch-1"]
    );

    // Neither head's total and not their sum: which head this cache describes is
    // not knowable from here, so it reads as unknown LOC.
    expect(totals.get("branch-1")).toEqual({
      additions: null,
      deletions: null,
      fileCount: 0,
      headSha: null,
    });
  });

  it("chunks the id predicate so a large tenant cannot overflow bind parameters", async () => {
    const branchIds = idsOfLength(BRANCH_FILE_CHANGE_TOTALS_ID_CHUNK_SIZE + 1);
    const groupBy = vi.fn().mockResolvedValue([]);

    await getBranchFileChangeTotals(
      { branchFileChange: { groupBy } } as never,
      ORGANIZATION_ID,
      branchIds
    );

    expect(groupBy).toHaveBeenCalledTimes(2);
    expect(idCountOfCall(groupBy, 0)).toBe(
      BRANCH_FILE_CHANGE_TOTALS_ID_CHUNK_SIZE
    );
    expect(idCountOfCall(groupBy, 1)).toBe(1);
  });
});

describe("getBranchRowsById", () => {
  it("hydrates a page without loading a single per-file row", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const groupBy = vi.fn().mockResolvedValue([]);

    await getBranchRowsById(
      {
        artifact: { findMany },
        branchFileChange: { groupBy },
      } as never,
      ORGANIZATION_ID,
      ["branch-1", "branch-2"],
      []
    );

    // The regression this guards is the relation coming back: a `fileChanges`
    // key here is a per-branch row projection again, and on the server page that
    // is the whole corpus's files before 25 rows are kept.
    expect(
      findMany.mock.calls[0]?.[0]?.select?.branch?.select
    ).not.toHaveProperty("fileChanges");
    expect(groupBy).toHaveBeenCalledTimes(1);
  });

  it("attaches each branch's own folded totals, and unknown LOC where none exist", async () => {
    const findMany = vi
      .fn()
      .mockResolvedValue([persistedRow("branch-1"), persistedRow("branch-2")]);
    const groupBy = vi.fn().mockResolvedValue([
      {
        branchArtifactId: "branch-1",
        headSha: "head-sha-1",
        _sum: { additions: 12, deletions: 8 },
        _count: { _all: 2, additions: 2, deletions: 2 },
      },
    ]);

    const rows = await getBranchRowsById(
      {
        artifact: { findMany },
        branchFileChange: { groupBy },
      } as never,
      ORGANIZATION_ID,
      ["branch-1", "branch-2"],
      []
    );

    expect(rows[0]?.branch.fileChangeTotals).toEqual({
      additions: 12,
      deletions: 8,
      fileCount: 2,
      headSha: "head-sha-1",
    });
    // Not the other branch's totals, and not a fabricated zero: a branch the
    // fold returned no group for has no cached files, which is unknown LOC.
    expect(rows[1]?.branch.fileChangeTotals).toEqual({
      additions: null,
      deletions: null,
      fileCount: 0,
      headSha: null,
    });
  });

  it("chunks the fold in step with the hydration batch it is keyed off", () => {
    expect(BRANCH_FILE_CHANGE_TOTALS_ID_CHUNK_SIZE).toBe(
      BRANCH_ROW_HYDRATION_BATCH_SIZE
    );
  });
});

function idsOfLength(length: number): string[] {
  return Array.from({ length }, (_value, index) => `branch-${index}`);
}

function idCountOfCall(
  groupBy: ReturnType<typeof vi.fn>,
  callIndex: number
): number {
  return groupBy.mock.calls[callIndex]?.[0]?.where?.branchArtifactId?.in.length;
}

function persistedRow(id: string) {
  return { id, branch: { artifactId: id } };
}
