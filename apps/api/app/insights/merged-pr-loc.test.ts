import { describe, expect, it } from "vitest";
import {
  dedupeMergedPrs,
  dedupeMergedPrsWithEarliestCreation,
  type MergedPrLocInput,
  mergedLocKpis,
  mergedPrLocTotals,
  projectedPrIdentity,
} from "./merged-pr-loc";

function pr(overrides: Partial<MergedPrLocInput> = {}): MergedPrLocInput {
  return {
    id: "row-1",
    number: 42,
    githubId: null,
    repositoryFullName: "closedloop-ai/closedloop-ai",
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

  it("uses installed repository authority before stale PR row names", () => {
    const appRow = pr({
      id: "row-app",
      githubId: "PR_node_1",
      repository: { fullName: "acme/canonical" },
      repositoryFullName: "acme/stale-name",
      repositoryId: "repo-uuid",
    });
    const desktopTwin = pr({
      id: "row-desktop",
      repositoryFullName: "acme/canonical",
    });

    expect(projectedPrIdentity(appRow)).toBe(projectedPrIdentity(desktopTwin));
    expect(dedupeMergedPrs([appRow, desktopTwin])).toHaveLength(1);
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

// ---------------------------------------------------------------------------
// ISS-8184 — the raw-line KPIs that ship beside the deprecated KLOC ones
// ---------------------------------------------------------------------------

describe("mergedLocKpis raw-line twins", () => {
  // Two keys per pair, deliberately: ruling 3 is a per-key contract, and a
  // single-key fixture cannot tell a per-field migration from a producer that
  // renamed one key and called it done.
  it("emits both vocabularies, the KLOC one in thousands and the LOC one in lines", () => {
    const kpis = mergedLocKpis(
      mergedPrLocTotals([pr({ additions: 8000, deletions: 987 })]),
      null
    );

    expect(kpis.kloc.value).toBe(9);
    expect(kpis.loc.value).toBe(8987);
    expect(kpis.mergedKloc.value).toBe(9);
    expect(kpis.mergedLoc.value).toBe(8987);
  });

  it("labels the raw-line pair for the basis, not the unit-prefixed acronym", () => {
    const kpis = mergedLocKpis(mergedPrLocTotals([pr()]), null);

    expect(kpis.loc.label).toBe("Merged LOC");
    expect(kpis.mergedLoc.label).toBe("Merged LOC");
    // The deprecated pair keeps emitting for a client that predates the flag.
    expect(kpis.kloc.label).toBe("KLOC merged");
    expect(kpis.mergedKloc.label).toBe("KLOC merged");
  });

  it("does not recover lines by scaling the rounded KLOC back up", () => {
    // 8,987 lines rounds to 9.0 KLOC. A consumer multiplying that by 1,000 gets
    // 9,000 — the precision loss that makes the raw-line key necessary rather
    // than merely tidier.
    const kpis = mergedLocKpis(
      mergedPrLocTotals([pr({ additions: 8000, deletions: 987 })]),
      null
    );

    expect(kpis.loc.value).not.toBe((kpis.kloc.value as number) * 1000);
  });

  it("carries the unknown through to the raw-line pair rather than reporting 0", () => {
    // No merged PR carries line counts, so the window's volume is UNKNOWN. A
    // raw-line 0 here would read as a measured "nothing landed".
    const kpis = mergedLocKpis(
      mergedPrLocTotals([pr({ additions: null, deletions: null })]),
      null
    );

    expect(kpis.kloc.value).toBeNull();
    expect(kpis.loc.value).toBeNull();
    expect(kpis.mergedLoc.value).toBeNull();
  });

  it("keeps the raw-line pair internal-vs-visible exactly as the KLOC pair is", () => {
    const kpis = mergedLocKpis(mergedPrLocTotals([pr()]), null);

    expect(kpis.loc.internal).toBe(kpis.kloc.internal);
    expect(kpis.mergedLoc.internal).toBe(kpis.mergedKloc.internal);
  });
});

/**
 * ISS-11589 moved Median PR size onto the Branches card's Product-eligible
 * cohort while the lines-landed tiles kept folding the deduped row scan. The two
 * are different populations — the scan applies the Wrote check with no
 * default-branch authority gate — so each caption has to quote its own.
 */
describe("the Delivery size-coverage captions", () => {
  it("quotes the median's own population, not the row scan's", () => {
    const kpis = mergedLocKpis(
      mergedPrLocTotals([
        pr({ id: "a", number: 1 }),
        pr({ id: "b", number: 2 }),
        pr({ id: "c", number: 3, additions: null, deletions: null }),
      ]),
      { medianSize: 15, merged: 2, sized: 1 }
    );

    expect(kpis.kloc.sub).toContain("sized 2 of 3");
    expect(kpis.prSize.sub).toContain("sized 1 of 2");
    expect(kpis.prSize.value).toBe(15);
  });

  it("leaves the median's caption bare when no median was read", () => {
    const kpis = mergedLocKpis(mergedPrLocTotals([pr()]), null);

    expect(kpis.prSize.value).toBeNull();
    expect(kpis.prSize.sub).toBe("lines changed");
  });
});
