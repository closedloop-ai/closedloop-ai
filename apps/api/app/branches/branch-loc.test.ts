import { BranchStatus } from "@repo/api/src/types/branch";
import { describe, expect, it } from "vitest";
import {
  analyticsPullRequestSize,
  currentFileTotals,
  resolveDetailLoc,
  sumFileChanges,
  sumOrNullWhenPartial,
} from "./branch-loc";

const HEAD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OLD_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const UNKNOWN_TOTALS = {
  additions: null,
  deletions: null,
  filesChanged: null,
} as const;

describe("sumFileChanges", () => {
  it("returns all-null totals for an empty file cache", () => {
    expect(sumFileChanges([])).toEqual({
      additions: null,
      deletions: null,
      filesChanged: null,
    });
  });

  it("sums a fully-enriched cache", () => {
    expect(
      sumFileChanges([
        { additions: 10, deletions: 5 },
        { additions: 2, deletions: 3 },
      ])
    ).toEqual({ additions: 12, deletions: 8, filesChanged: 2 });
  });

  // wongk review: a null per-file count means that dimension is un-enriched for
  // the WHOLE cache — never coerce it to 0, which would look enriched and hide
  // the real PR fallback. `filesChanged` still reflects the row count.
  it("preserves null for a dimension when ANY file's count is null (partial cache)", () => {
    expect(
      sumFileChanges([
        { additions: 10, deletions: 5 },
        { additions: null, deletions: 3 },
      ])
    ).toEqual({ additions: null, deletions: 8, filesChanged: 2 });
  });
});

describe("sumOrNullWhenPartial", () => {
  it("sums when every entry is present", () => {
    expect(sumOrNullWhenPartial([1, 2, 3])).toBe(6);
  });

  it("returns null when any entry is null", () => {
    expect(sumOrNullWhenPartial([1, null, 3])).toBeNull();
  });

  it("sums to zero for an all-zero column (still complete, not null)", () => {
    expect(sumOrNullWhenPartial([0, 0])).toBe(0);
  });
});

describe("analyticsPullRequestSize", () => {
  it("returns additions + deletions for an enriched merged branch", () => {
    expect(
      analyticsPullRequestSize(BranchStatus.Merged, {
        additions: 10,
        deletions: 5,
      })
    ).toBe(15);
  });

  it("returns null for a non-merged branch (excluded from the median)", () => {
    expect(
      analyticsPullRequestSize(BranchStatus.Open, {
        additions: 10,
        deletions: 5,
      })
    ).toBeNull();
  });

  it("returns null when either line count is null (un-enriched, not folded as 0)", () => {
    expect(
      analyticsPullRequestSize(BranchStatus.Merged, {
        additions: 10,
        deletions: null,
      })
    ).toBeNull();
    expect(
      analyticsPullRequestSize(BranchStatus.Merged, {
        additions: null,
        deletions: 5,
      })
    ).toBeNull();
  });
});

describe("resolveDetailLoc", () => {
  it("prefers the enriched branch file-cache over PR diff stats", () => {
    expect(
      resolveDetailLoc(
        { additions: 12, deletions: 8, filesChanged: 2 },
        { additions: 35, deletions: 7, changedFiles: 4 }
      )
    ).toEqual({ additions: 12, deletions: 8, filesChanged: 2 });
  });

  it("backfills from complete PR diff stats when the file cache is un-enriched", () => {
    expect(
      resolveDetailLoc(
        { additions: null, deletions: null, filesChanged: null },
        { additions: 35, deletions: 7, changedFiles: 4 }
      )
    ).toEqual({ additions: 35, deletions: 7, filesChanged: 4 });
  });

  // A partial branch cache (one dimension null) is un-enriched, so the complete
  // PR totals still win — the exact partial-cache case sumFileChanges now emits.
  it("backfills from the PR when the file cache is partial (one dimension null)", () => {
    expect(
      resolveDetailLoc(
        { additions: null, deletions: 8, filesChanged: 2 },
        { additions: 35, deletions: 7, changedFiles: 4 }
      )
    ).toEqual({ additions: 35, deletions: 7, filesChanged: 4 });
  });

  it("does not backfill from a partial PR pair (one PR line count null)", () => {
    expect(
      resolveDetailLoc(
        { additions: null, deletions: null, filesChanged: null },
        { additions: 35, deletions: null, changedFiles: 4 }
      )
    ).toEqual({ additions: null, deletions: null, filesChanged: null });
  });

  it("preserves null when neither the file cache nor the PR carry diff stats", () => {
    expect(
      resolveDetailLoc(
        { additions: null, deletions: null, filesChanged: null },
        null
      )
    ).toEqual({ additions: null, deletions: null, filesChanged: null });
  });

  it("falls back to the file-cache filesChanged when the PR omits changedFiles", () => {
    expect(
      resolveDetailLoc(
        { additions: null, deletions: null, filesChanged: 3 },
        { additions: 35, deletions: 7, changedFiles: null }
      )
    ).toEqual({ additions: 35, deletions: 7, filesChanged: 3 });
  });
});

describe("currentFileTotals", () => {
  const changes = [
    { additions: 10, deletions: 5 },
    { additions: 2, deletions: 3 },
  ];

  it("sums the cache when its head matches the branch head (fresh)", () => {
    expect(currentFileTotals(changes, HEAD_SHA, HEAD_SHA)).toEqual({
      additions: 12,
      deletions: 8,
      filesChanged: 2,
    });
  });

  // shafty023 review: `refreshBranchFileChangeCache` preserves the OLD rows and
  // leaves `fileCacheHeadSha` on the prior sha when a refresh for a new head
  // fails/pends. A non-null pair from that stale cache must NOT count as the
  // current head's LOC — it reads as unknown so the PR/unknown fallback wins.
  it("reads as unknown when the cache head is a STALE prior head (old-sha cache)", () => {
    expect(currentFileTotals(changes, OLD_SHA, HEAD_SHA)).toEqual(
      UNKNOWN_TOTALS
    );
  });

  it("reads as unknown when the cache was never synced (null cache head)", () => {
    expect(currentFileTotals(changes, null, HEAD_SHA)).toEqual(UNKNOWN_TOTALS);
  });

  it("reads as unknown when the branch has no head sha (never pushed)", () => {
    expect(currentFileTotals(changes, HEAD_SHA, null)).toEqual(UNKNOWN_TOTALS);
  });

  it("preserves a partial current cache (one dimension null) once head-matched", () => {
    expect(
      currentFileTotals(
        [
          { additions: 10, deletions: 5 },
          { additions: null, deletions: 3 },
        ],
        HEAD_SHA,
        HEAD_SHA
      )
    ).toEqual({ additions: null, deletions: 8, filesChanged: 2 });
  });

  // The end-to-end precedence the service wires: a stale old-sha cache falls back
  // to the connected PR's complete diff stats for DISPLAY (resolveDetailLoc)...
  it("old-sha cache + current PR: display backfills from the PR diff stats", () => {
    const stale = currentFileTotals(changes, OLD_SHA, HEAD_SHA);
    expect(
      resolveDetailLoc(stale, { additions: 35, deletions: 7, changedFiles: 4 })
    ).toEqual({ additions: 35, deletions: 7, filesChanged: 4 });
  });

  // ...and is EXCLUDED from the analytics median (file-cache basis, no PR backfill),
  // instead of folding in the prior head's size.
  it("old-sha cache: analytics median excludes the branch (unknown size)", () => {
    const stale = currentFileTotals(changes, OLD_SHA, HEAD_SHA);
    expect(analyticsPullRequestSize(BranchStatus.Merged, stale)).toBeNull();
  });

  it("no-PR case with a stale cache stays unknown (no fabricated LOC)", () => {
    const stale = currentFileTotals(changes, OLD_SHA, HEAD_SHA);
    expect(resolveDetailLoc(stale, null)).toEqual(UNKNOWN_TOTALS);
  });
});
