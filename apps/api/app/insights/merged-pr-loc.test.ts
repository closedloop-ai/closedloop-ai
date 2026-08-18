import { describe, expect, it } from "vitest";
import {
  dedupeMergedPrs,
  dedupeMergedPrsWithEarliestCreation,
  distinctMergedPrCount,
  type MergedPrLocInput,
  mergedPrLoc,
  mergedPrLocTotals,
  projectedPrIdentity,
} from "./merged-pr-loc";

function pr(overrides: Partial<MergedPrLocInput> = {}): MergedPrLocInput {
  return {
    id: "row-1",
    number: 42,
    githubId: null,
    repositoryFullName: "closedloop-ai/symphony-alpha",
    repositoryId: null,
    additions: 10,
    deletions: 5,
    ...overrides,
  };
}

describe("projectedPrIdentity", () => {
  it("does not collapse the same PR number across different repos", () => {
    // The double-count's mirror image: collapsing two distinct PRs would
    // UNDER-count, which is why number alone is never the identity.
    const a = projectedPrIdentity(pr({ repositoryFullName: "acme/web" }));
    const b = projectedPrIdentity(pr({ repositoryFullName: "acme/api" }));

    expect(a).not.toBe(b);
  });

  it("merges the same PR projected by producers keyed on different columns", () => {
    // Desktop sync and the GitHub App projection writer key on different repo
    // columns — repositoryFullName only vs. repositoryFullName plus
    // repositoryId and the node id — but BOTH stamp the normalized
    // `owner/name` (schema.prisma D2), so that is where two projections of ONE
    // pull request meet.
    const desktopRow = pr({ id: "row-desktop" });
    const appRow = pr({
      id: "row-app",
      githubId: "PR_node_1",
      repositoryId: "repo-uuid",
    });

    expect(projectedPrIdentity(desktopRow)).toBe(projectedPrIdentity(appRow));
  });

  it("still keys a repo-less row by its github id", () => {
    // The identity an App row has if it ever lands before repo enrichment.
    expect(
      projectedPrIdentity(
        pr({ id: "row-a", githubId: "PR_node_1", repositoryFullName: null })
      )
    ).toBe("gh:PR_node_1");
  });

  it("keeps rows with no provable identity separate", () => {
    const a = projectedPrIdentity(
      pr({ id: "row-a", githubId: null, repositoryFullName: null })
    );
    const b = projectedPrIdentity(
      pr({ id: "row-b", githubId: null, repositoryFullName: null })
    );

    expect(a).not.toBe(b);
  });
});

describe("mergedPrLoc", () => {
  it("treats a half-projected row as unknown, not as a one-sided diff", () => {
    expect(mergedPrLoc(pr({ additions: 10, deletions: null }))).toBeNull();
    expect(mergedPrLoc(pr({ additions: null, deletions: 5 }))).toBeNull();
  });

  it("distinguishes a known-zero PR from an unknown one", () => {
    expect(mergedPrLoc(pr({ additions: 0, deletions: 0 }))).toBe(0);
    expect(mergedPrLoc(pr({ additions: null, deletions: null }))).toBeNull();
  });

  it("treats a non-finite or absent count as unknown, never as NaN", () => {
    // This module reads a persistence boundary: a row that never selected the
    // column presents as `undefined`, and a corrupt projection can carry NaN or
    // Infinity. A `=== null` check alone let those through and produced a NaN
    // KLOC — garbage on screen instead of the honest unknown the caller handles.
    const absent = {
      additions: undefined,
      deletions: undefined,
    } as unknown as Pick<MergedPrLocInput, "additions" | "deletions">;

    expect(mergedPrLoc(pr(absent))).toBeNull();
    expect(mergedPrLoc(pr({ additions: Number.NaN, deletions: 5 }))).toBeNull();
    expect(
      mergedPrLoc(pr({ additions: Number.POSITIVE_INFINITY, deletions: 5 }))
    ).toBeNull();
  });

  it("treats a negative count as unknown, not as a subtraction", () => {
    // `Number.isFinite(-5)` is true, so a corrupt projection would otherwise
    // subtract from the KLOC sum and could drive lines-per-dollar below zero —
    // a figure no diff can produce.
    expect(mergedPrLoc(pr({ additions: -5, deletions: 5 }))).toBeNull();
    expect(mergedPrLoc(pr({ additions: 10, deletions: -1 }))).toBeNull();
  });
});

describe("dedupeMergedPrs", () => {
  it("lets a sized duplicate win over an unsized one", () => {
    const unsized = pr({ id: "row-unsized", additions: null, deletions: null });
    const sized = pr({ id: "row-sized", additions: 7, deletions: 3 });

    expect(dedupeMergedPrs([unsized, sized])).toEqual([sized]);
    // Order must not decide the winner.
    expect(dedupeMergedPrs([sized, unsized])).toEqual([sized]);
  });

  it("preserves caller-selected fields on the winning row", () => {
    const mergedAt = new Date("2026-08-01T00:00:00.000Z");
    const rows = [{ ...pr(), mergedAt }];

    expect(dedupeMergedPrs(rows)[0]?.mergedAt).toBe(mergedAt);
  });

  it("collapses an adopted row and the duplicate twin adoption left behind", () => {
    // `adoptRepolessPullRequestDetail` stamps the githubId onto exactly ONE
    // `githubId IS NULL` row and documents leaving "any additional duplicate
    // row untouched" — no PullRequestDetail unique forbids two of them on one
    // (branchArtifactId, number). Keying githubId ahead of the repo gave this
    // pair two identities and counted the PR's lines twice.
    const adopted = pr({
      id: "row-adopted",
      githubId: "PR_node_1",
      repositoryId: "repo-uuid",
    });
    const twin = pr({ id: "row-twin" });

    const deduped = dedupeMergedPrs([adopted, twin]);

    expect(deduped).toHaveLength(1);
    expect(mergedPrLocTotals(deduped).totalLines).toBe(15);
  });

  it("lets the App-owned row settle a size disagreement, not arrival order", () => {
    // Both rows are sized and they disagree. Whichever the query emitted first
    // used to win, so one PR's reported size depended on row ordering — not a
    // fact about the PR. The row carrying a githubId is the App/webhook
    // projection, so its numbers came from GitHub.
    const appRow = pr({ id: "row-app", githubId: "PR_node_1", additions: 100 });
    const desktopRow = pr({ id: "row-desktop", additions: 7 });

    expect(
      mergedPrLocTotals(dedupeMergedPrs([appRow, desktopRow])).totalLines
    ).toBe(105);
    expect(
      mergedPrLocTotals(dedupeMergedPrs([desktopRow, appRow])).totalLines
    ).toBe(105);
  });
});

describe("mergedPrLocTotals", () => {
  it("counts a multi-PR branch's PRs once each, not the branch total per PR", () => {
    // The defect this replaces: both PRs on one branch read the BRANCH's whole
    // line total, so a branch with 15 + 25 lines of PRs reported 40 twice.
    const totals = mergedPrLocTotals(
      dedupeMergedPrs([
        pr({ id: "a", number: 1, additions: 10, deletions: 5 }),
        pr({ id: "b", number: 2, additions: 20, deletions: 5 }),
      ])
    );

    expect(totals.totalLines).toBe(40);
    expect(totals.prCount).toBe(2);
  });

  it("excludes unknown-LOC PRs from the sum instead of folding them in as zero", () => {
    const totals = mergedPrLocTotals(
      dedupeMergedPrs([
        pr({ id: "a", number: 1, additions: 10, deletions: 5 }),
        pr({ id: "b", number: 2, additions: null, deletions: null }),
      ])
    );

    expect(totals.totalLines).toBe(15);
    expect(totals.unknownLocCount).toBe(1);
    // The median population excludes the unknown PR — folding it in as 0 was
    // what dragged the median toward zero.
    expect(totals.knownLocValues).toEqual([15]);
  });

  it("reports every PR as unknown when the projection sizes none of them", () => {
    // The caller turns this into a null KLOC ("—"), never a 0.0 that would
    // claim no lines landed.
    const totals = mergedPrLocTotals(
      dedupeMergedPrs([
        pr({ id: "a", number: 1, additions: null, deletions: null }),
        pr({ id: "b", number: 2, additions: null, deletions: null }),
      ])
    );

    expect(totals.knownLocValues).toEqual([]);
    expect(totals.totalLines).toBe(0);
    expect(totals.unknownLocCount).toBe(2);
    expect(totals.prCount).toBe(2);
  });

  it("keeps a known-zero PR in the median population", () => {
    const totals = mergedPrLocTotals(
      dedupeMergedPrs([pr({ additions: 0, deletions: 0 })])
    );

    expect(totals.knownLocValues).toEqual([0]);
    expect(totals.unknownLocCount).toBe(0);
  });

  it("reconciles: prCount equals sized plus unsized", () => {
    const totals = mergedPrLocTotals(
      dedupeMergedPrs([
        pr({ id: "a", number: 1 }),
        pr({ id: "b", number: 2, additions: null, deletions: null }),
        pr({ id: "c", number: 3, additions: 1, deletions: 1 }),
      ])
    );

    expect(totals.prCount).toBe(
      totals.knownLocValues.length + totals.unknownLocCount
    );
  });
});

describe("distinctMergedPrCount", () => {
  it("subtracts the duplicate rows the scan can see from the exact row count", () => {
    // The scan holds three rows for two pull requests: the adopted App row and
    // the repo-less twin `adoptRepolessPullRequestDetail` leaves behind. The
    // uncorrected count would report 3 merged PRs beside a deduped "2 scanned".
    const scanned = [
      pr({ id: "row-app", number: 1, githubId: "PR_node_1" }),
      pr({ id: "row-desktop", number: 1 }),
      pr({ id: "row-other", number: 2 }),
    ];

    expect(distinctMergedPrCount(3, scanned)).toBe(2);
  });

  it("keeps the count uncapped: rows beyond the scan still count", () => {
    // The whole reason the count is a separate query — the scan is bounded, so
    // a distinct count taken of the scan ALONE would report 2 for an org that
    // merged 5000 PRs.
    const scanned = [
      pr({ id: "row-app", number: 1, githubId: "PR_node_1" }),
      pr({ id: "row-desktop", number: 1 }),
      pr({ id: "row-other", number: 2 }),
    ];

    expect(distinctMergedPrCount(5000, scanned)).toBe(4999);
  });

  it("leaves a duplicate-free scan's count untouched", () => {
    expect(
      distinctMergedPrCount(2, [
        pr({ id: "a", number: 1 }),
        pr({ id: "b", number: 2 }),
      ])
    ).toBe(2);
  });

  it("floors a racing count at the scan's own distinct count, never at zero", () => {
    // Count and scan are separate queries: a twin row written between them can
    // leave the scan holding a duplicate the count never saw. 1 row counted
    // minus 1 duplicate would read 0 — beside sibling facets built from the
    // very scan that is holding the pull request. The scan saw one real PR, so
    // one is the floor that cannot lie.
    expect(
      distinctMergedPrCount(1, [
        pr({ id: "a", number: 1 }),
        pr({ id: "b", number: 1 }),
      ])
    ).toBe(1);
    expect(
      distinctMergedPrCount(0, [
        pr({ id: "a", number: 1 }),
        pr({ id: "b", number: 1 }),
      ])
    ).toBe(1);
  });

  it("never reports fewer pull requests than the scan holds distinct identities", () => {
    // The other race: rows written after the count land in the scan as NEW
    // identities, not duplicates. The subtraction alone would keep the stale
    // count; the scan's distinct count is the sharper lower bound.
    expect(
      distinctMergedPrCount(1, [
        pr({ id: "a", number: 1 }),
        pr({ id: "b", number: 2 }),
      ])
    ).toBe(2);
  });
});

describe("dedupeMergedPrsWithEarliestCreation", () => {
  const withCreation = (
    overrides: Partial<MergedPrLocInput>,
    createdAt: Date
  ) => ({ ...pr(overrides), branchArtifact: { createdAt } });

  it("rewrites the winner to the earliest branch creation a twin carries", () => {
    // The sized App row wins the dedupe on diff stats — a fact with no bearing
    // on timing — and its branch artifact can be projected AFTER the merge.
    // The unsized desktop twin observed the branch first, so the winner must
    // represent the pull request's timing with that earlier instant.
    const early = new Date("2026-08-01T00:00:00.000Z");
    const late = new Date("2026-08-03T00:00:00.000Z");
    const appRow = withCreation(
      { id: "row-app", githubId: "PR_node_1", additions: 7, deletions: 3 },
      late
    );
    const desktopRow = withCreation(
      { id: "row-desktop", additions: null, deletions: null },
      early
    );

    const deduped = dedupeMergedPrsWithEarliestCreation([appRow, desktopRow]);

    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.id).toBe("row-app");
    expect(deduped[0]?.branchArtifact.createdAt).toEqual(early);
    // The rewrite copies; the caller's input rows stay untouched.
    expect(appRow.branchArtifact.createdAt).toEqual(late);
  });

  it("returns a winner that already carries the earliest creation as-is", () => {
    const row = withCreation(
      { id: "row-a" },
      new Date("2026-08-01T00:00:00.000Z")
    );

    expect(dedupeMergedPrsWithEarliestCreation([row])).toEqual([row]);
  });

  it("keeps distinct pull requests on their own creation instants", () => {
    const a = withCreation(
      { id: "a", number: 1 },
      new Date("2026-08-01T00:00:00.000Z")
    );
    const b = withCreation(
      { id: "b", number: 2 },
      new Date("2026-08-02T00:00:00.000Z")
    );

    const deduped = dedupeMergedPrsWithEarliestCreation([a, b]);

    expect(deduped).toContainEqual(a);
    expect(deduped).toContainEqual(b);
  });
});
