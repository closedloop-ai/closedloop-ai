import { BranchStatus } from "@repo/api/src/types/branch";
import { describe, expect, it } from "vitest";
import { toBranchFileChangeTotals } from "@/__tests__/support/branches/branch-file-change-totals.test-helpers";
import {
  analyticsPullRequestSize,
  currentFileTotals,
  resolveDetailLoc,
} from "./branch-loc";

const HEAD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OLD_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const UNKNOWN_TOTALS = {
  additions: null,
  deletions: null,
  filesChanged: null,
} as const;

// ISS-10298: the `sumFileChanges` / `sumOrNullWhenPartial` folds that used to be
// covered here no longer exist — `getBranchFileChangeTotals` does that fold in
// SQL, and `file-change-totals-read.integration.test.ts` carries the empty,
// fully-enriched, and partial-cache cases against real Postgres. `currentFileTotals`
// below keeps only the CURRENCY gate it always owned.

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
  // PR totals still win — the exact partial-cache case the fold now emits.
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
  const changes = toBranchFileChangeTotals(
    [
      { additions: 10, deletions: 5 },
      { additions: 2, deletions: 3 },
    ],
    HEAD_SHA
  );

  it("sums the cache when its head matches the branch head (fresh)", () => {
    expect(currentFileTotals(changes, HEAD_SHA, HEAD_SHA)).toEqual({
      additions: 12,
      deletions: 8,
      filesChanged: 2,
    });
  });

  // davetho review: `refreshBranchFileChangeCache` preserves the OLD rows and
  // leaves `fileCacheHeadSha` on the prior sha when a refresh for a new head
  // fails/pends. A non-null pair from that stale cache must NOT count as the
  // current head's LOC — it reads as unknown so the PR/unknown fallback wins.
  it("reads as unknown when the cache head is a STALE prior head (old-sha cache)", () => {
    expect(currentFileTotals(changes, OLD_SHA, HEAD_SHA)).toEqual(
      UNKNOWN_TOTALS
    );
  });

  // ISS-10298: the sums arrive from their OWN statement now, so the row's claim
  // that its cache is current is not evidence that THESE rows are the ones it
  // was claiming about. A refresh committing between the artifact read and the
  // fold hands over the NEW head's rows under the OLD head's claim — reporting a
  // size the branch does not have, which is the lie this gate exists to prevent.
  it("reads as unknown when the folded rows describe a DIFFERENT head than the cache claims", () => {
    const refreshedUnderneath = toBranchFileChangeTotals(
      [
        { additions: 10, deletions: 5 },
        { additions: 2, deletions: 3 },
      ],
      OLD_SHA
    );
    expect(currentFileTotals(refreshedUnderneath, HEAD_SHA, HEAD_SHA)).toEqual(
      UNKNOWN_TOTALS
    );
  });

  // `headSha: null` is how the fold reports rows that did not agree on one head
  // (a refresh mid-flight). The relation load this replaced summed those two
  // diffs together and reported the total as a measured size.
  it("reads as unknown when the fold saw rows for more than one head", () => {
    const midRefresh = toBranchFileChangeTotals(
      [{ additions: 10, deletions: 5 }],
      null
    );
    expect(currentFileTotals(midRefresh, HEAD_SHA, HEAD_SHA)).toEqual(
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
        toBranchFileChangeTotals(
          [
            { additions: 10, deletions: 5 },
            { additions: null, deletions: 3 },
          ],
          HEAD_SHA
        ),
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

  // ISS-6127. GitHub caps a compare at 300 files for the ENTIRE comparison and
  // reports neither a total nor a truncation flag, so a capped cache is fresh,
  // head-matched, and made of individually complete rows — it passes every guard
  // this module already had and produces a confident, short sum. These pin the
  // capped branch onto the same UNKNOWN exit a stale cache takes.
  it("reads as unknown when the cache is CAPPED, even though it is fresh and head-matched", () => {
    expect(currentFileTotals(changes, HEAD_SHA, HEAD_SHA, true)).toEqual(
      UNKNOWN_TOTALS
    );
  });

  it("defaults to complete, so an un-migrated or unflagged caller keeps summing", () => {
    expect(currentFileTotals(changes, HEAD_SHA, HEAD_SHA)).toEqual({
      additions: 12,
      deletions: 8,
      filesChanged: 2,
    });
  });

  it("capped cache + current PR: display backfills from the PR diff stats", () => {
    const capped = currentFileTotals(changes, HEAD_SHA, HEAD_SHA, true);
    expect(
      resolveDetailLoc(capped, { additions: 35, deletions: 7, changedFiles: 4 })
    ).toEqual({ additions: 35, deletions: 7, filesChanged: 4 });
  });

  it("capped cache: analytics median excludes the branch (unknown size)", () => {
    const capped = currentFileTotals(changes, HEAD_SHA, HEAD_SHA, true);
    expect(analyticsPullRequestSize(BranchStatus.Merged, capped)).toBeNull();
  });

  it("no-PR case with a capped cache stays unknown (never a truncated sum)", () => {
    const capped = currentFileTotals(changes, HEAD_SHA, HEAD_SHA, true);
    expect(resolveDetailLoc(capped, null)).toEqual(UNKNOWN_TOTALS);
  });

  // The case that decided the column-vs-enum-member question: capped and stale
  // are independent facts, and a cache can be both. A sixth `BranchFileCacheStatus`
  // member would have forced one to overwrite the other at the write site.
  it("a capped cache that has ALSO gone stale is representable and reads unknown", () => {
    expect(currentFileTotals(changes, OLD_SHA, HEAD_SHA, true)).toEqual(
      UNKNOWN_TOTALS
    );
  });
});
