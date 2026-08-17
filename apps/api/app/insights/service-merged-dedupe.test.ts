/**
 * Merged-PR dedupe across the WHOLE Delivery response (ISS-5411).
 *
 * PLN-1535 deduped merged PRs by identity but wired only the LOC-derived facets
 * to the deduped population, so one pull request carried by two projection rows
 * still counted twice in the headline count, its delta, the state and repo
 * splits, the daily trend, and every time-to-merge interval — and the response
 * stopped reconciling with itself ("Merged PRs 3" beside "Merged PRs scanned 2").
 * These cases pin the whole response on ONE population.
 *
 * A sibling file rather than more of `service.test.ts`: that module is
 * grandfathered over-size and shrink-only, and this is one cohesive concern
 * (same reasoning as `service-merged-loc.test.ts`).
 */

import { GitHubPRState as ApiGitHubPRState } from "@repo/api/src/types/github";
import {
  InsightsPeriod,
  InsightsScope,
  InsightsTileAvailabilityState,
} from "@repo/api/src/types/insights";
import { median } from "@repo/api/src/utils/math";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () =>
  (await import("@/__tests__/support/insights/service.test-db")).databaseMock()
);

import { withDb } from "@repo/database";
import {
  expectAllOrgScoped,
  flattenRawSql,
  makeFakeDb,
  ORG,
} from "@/__tests__/support/insights/service.test-db";
import { MERGED_PR_SCAN_CAP } from "./merged-pr-queries";
import { buildPrByRepoBuckets, insightsService } from "./service";

const USER = "user-1";
const ORG_CTX = { organizationId: ORG, userId: USER, scope: InsightsScope.Org };
const NOW = new Date("2026-06-09T12:00:00.000Z");
const HOUR = 3_600_000;
const MERGED_AT = new Date("2026-06-08T00:00:00.000Z");

/**
 * Route a delivery `where` to the count the scenario wants.
 *
 * Only the CURRENT merged window still reads a `count()` — ISS-5624 moved the
 * prior-window and closed-side counts into a distinct-identity aggregate, so
 * those two scenarios are expressed by their `priorMergedPrs` / `closedPrs`
 * fixture rows instead.
 */
function deliveryCounts(counts: { mergedRows: number }) {
  return (where: Record<string, unknown>): number => {
    const mergedAt = where.mergedAt as { lte?: unknown } | undefined;
    return where.prState === ApiGitHubPRState.Merged &&
      mergedAt?.lte !== undefined
      ? counts.mergedRows
      : 0;
  };
}

/** The prior-window count is the one windowed on the PR's own `merged_at`. */
function isPriorWindowCount(raw: { text: string }): boolean {
  return raw.text.includes("p.merged_at");
}

/**
 * One full merged-PR scan row (the `fetchMergedPrs` select shape), so the
 * shape lives once. The identity-only populations (closed / prior windows)
 * stay literal — they carry identity columns only, not this shape.
 */
function mergedPrRow(
  overrides: Partial<{
    id: string;
    number: number;
    githubId: string | null;
    additions: number | null;
    deletions: number | null;
    repositoryId: string | null;
    repositoryFullName: string;
    branchArtifactId: string;
    repository: { name: string } | null;
    branchArtifact: { createdAt: Date };
  }> = {}
) {
  return {
    mergedAt: MERGED_AT,
    prState: ApiGitHubPRState.Merged,
    id: "pr-1",
    number: 1,
    githubId: null,
    additions: null,
    deletions: null,
    repositoryId: null,
    repositoryFullName: "acme/symphony-alpha",
    branchArtifactId: "b1",
    repository: null,
    branchArtifact: { createdAt: new Date(MERGED_AT.getTime() - HOUR) },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("insightsService.getDelivery — merged-PR dedupe (ISS-5411)", () => {
  it("counts pull requests, not projection rows, across every merged-PR facet", async () => {
    // One pull request projected TWICE: the App-adopted row plus the repo-less
    // twin `adoptRepolessPullRequestDetail` documents leaving untouched. The
    // twin sits on a SECOND branch artifact, so before the fix it also
    // contributed a DIFFERENT merge interval for the same PR.
    const twinOnSecondBranch = mergedPrRow({
      id: "pr-1-desktop",
      branchArtifactId: "b1-desktop",
      branchArtifact: { createdAt: new Date(MERGED_AT.getTime() - 10 * HOUR) },
    });
    const adoptedAppRow = mergedPrRow({
      id: "pr-1-app",
      githubId: "gh-1",
      additions: 100,
      deletions: 50,
      repositoryId: "r1",
      repository: { name: "symphony-alpha" },
      branchArtifact: { createdAt: new Date(MERGED_AT.getTime() - 2 * HOUR) },
    });
    const otherPr = mergedPrRow({
      id: "pr-2",
      number: 2,
      githubId: "gh-2",
      additions: 200,
      deletions: 50,
      repositoryId: "r2",
      repositoryFullName: "acme/web",
      branchArtifactId: "b2",
      repository: { name: "web" },
      branchArtifact: { createdAt: new Date(MERGED_AT.getTime() - 4 * HOUR) },
    });
    // The closed population carries the same duplicate shape: four rows for
    // three pull requests, so the merge-rate denominator has to dedupe too.
    const closedIdentityRows = [
      {
        id: "closed-1-app",
        number: 11,
        githubId: "gh-c1",
        repositoryFullName: "acme/symphony-alpha",
        repositoryId: "r1",
      },
      {
        id: "closed-1-desktop",
        number: 11,
        githubId: null,
        repositoryFullName: "acme/symphony-alpha",
        repositoryId: null,
      },
      {
        id: "closed-2",
        number: 12,
        githubId: "gh-c2",
        repositoryFullName: "acme/web",
        repositoryId: "r2",
      },
      {
        id: "closed-3",
        number: 13,
        githubId: "gh-c3",
        repositoryFullName: "acme/web",
        repositoryId: "r2",
      },
    ];
    const { db, wheres } = makeFakeDb({
      mergedPrs: [twinOnSecondBranch, adoptedAppRow, otherPr],
      closedPrs: closedIdentityRows,
      // Three merged ROWS in range for two pull requests; four closed rows for
      // three.
      counts: deliveryCounts({ mergedRows: 3 }),
    });
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(cb(db as never))
    );

    const result = await insightsService.getDelivery(
      ORG_CTX,
      InsightsPeriod.Quarter,
      NOW
    );

    expectAllOrgScoped(wheres);

    // Headline count: the exact uncapped row count (3) minus the duplicate the
    // scan can see. Was 3.
    const merged = result.kpis.find((k) => k.key === "merged");
    expect(merged?.value).toBe(2);
    // FEA-2946's surface-agnostic twin reads the same population.
    expect(result.kpis.find((k) => k.key === "mergedCount")?.value).toBe(2);

    // The reconciliation the issue was filed on: the headline count and the
    // deduped scan population no longer contradict each other.
    expect(result.kpis.find((k) => k.key === "mergedPrsScanned")?.value).toBe(
      2
    );

    // State distribution is sized from the same count. Was 3.
    expect(result.charts.prByState).toEqual([
      { key: ApiGitHubPRState.Merged, label: "Merged", value: 2 },
    ]);

    // Daily trend: one bar of 2 on the merge day. Was 3.
    expect(
      result.charts.prTrend.points.find((point) => point.date === "2026-06-08")
        ?.values.merged
    ).toBe(2);

    // Repo split: the twin shares acme/symphony-alpha with the row that
    // survives, so case-folding the label alone never collapsed it. Was 2.
    expect(
      result.charts.prByRepo.find((bucket) => bucket.label === "symphony-alpha")
        ?.value
    ).toBe(1);
    expect(
      result.charts.prByRepo.reduce((total, bucket) => total + bucket.value, 0)
    ).toBe(2);

    // Time to merge: ONE interval per pull request — the raw population would
    // have medianed [10h, 2h, 4h], counting PR 1 twice. The interval measures
    // from the EARLIEST branch creation either twin carries (the desktop
    // artifact's, 10h) rather than the dedupe winner's own 2h, so a fact about
    // diff stats never decides a timing figure.
    expect(result.kpis.find((k) => k.key === "ttm")?.value).toBe(
      median([10 * HOUR, 4 * HOUR])
    );
    const lifespanTotal = result.charts.branchLifespan.reduce(
      (total, bucket) => total + bucket.value,
      0
    );
    expect(lifespanTotal).toBe(2);
    expect(
      result.charts.meanTimeToMerge.reduce(
        (total, bucket) => total + bucket.value,
        0
      )
    ).toBe(2);

    // Merge rate divides distinct pull requests by distinct pull requests:
    // 2 merged / (2 merged + 3 closed) = 40%. The closed side is fed 4 rows for
    // 3 pull requests, so the two other bases are both visibly wrong here —
    // raw/raw reads 3/(3+4) = 43%, and deduping only the numerator reads
    // 2/(2+4) = 33%, a rate the visible "Merged PRs 2" tile cannot reproduce.
    expect(result.kpis.find((k) => k.key === "merge-rate")?.value).toBe(40);
  });

  it("keeps a PR's merge interval when the dedupe winner was projected after the merge", async () => {
    // The desktop twin observed the branch 10h before the merge and holds the
    // only valid interval — but it is unsized, so it loses the dedupe.
    const twinObservedBeforeMerge = mergedPrRow({
      id: "pr-1-desktop",
      branchArtifactId: "b1-desktop",
      branchArtifact: { createdAt: new Date(MERGED_AT.getTime() - 10 * HOUR) },
    });
    // The sized App row wins on diff stats alone, but its branch artifact
    // materialized an hour AFTER the merge (Artifact.createdAt is
    // @default(now()) — a fact about projection timing, not about the branch),
    // so its own interval is negative and the >= 0 filter drops it.
    const winnerProjectedAfterMerge = mergedPrRow({
      id: "pr-1-app",
      githubId: "gh-1",
      additions: 100,
      deletions: 50,
      repositoryId: "r1",
      repository: { name: "symphony-alpha" },
      branchArtifact: { createdAt: new Date(MERGED_AT.getTime() + HOUR) },
    });
    const { db } = makeFakeDb({
      mergedPrs: [winnerProjectedAfterMerge, twinObservedBeforeMerge],
      counts: deliveryCounts({ mergedRows: 2 }),
    });
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(cb(db as never))
    );

    const result = await insightsService.getDelivery(
      ORG_CTX,
      InsightsPeriod.Quarter,
      NOW
    );

    // Before the earliest-creation basis, the winner's negative interval was
    // dropped and the PR vanished from the TTM population entirely:
    // branchLifespan and meanTimeToMerge fell below mergedPrsScanned, and
    // hasTtmEvidence flipped false so "Median time to merge" rendered
    // unavailable beside a nonzero "Merged PRs".
    expect(result.kpis.find((k) => k.key === "ttm")?.value).toBe(10 * HOUR);
    expect(result.tileAvailability?.["kpi:ttm"]).toBe(
      InsightsTileAvailabilityState.Available
    );
    expect(
      result.charts.meanTimeToMerge.reduce(
        (total, bucket) => total + bucket.value,
        0
      )
    ).toBe(1);
    expect(
      result.charts.branchLifespan.reduce(
        (total, bucket) => total + bucket.value,
        0
      )
    ).toBe(1);
  });

  it("does not report zero merged PRs when the count raced behind the scan", async () => {
    // `fetchMergedPrs` and `countMergedPrsInRange` are separate `withDb`
    // statements inside getDelivery's Promise.all, so a twin row written
    // between them leaves the scan holding a duplicate the count never saw:
    // one row counted, two rows scanned, one pull request.
    const twinOnSecondBranch = mergedPrRow({
      id: "pr-1-desktop",
      branchArtifactId: "b1-desktop",
      branchArtifact: { createdAt: new Date(MERGED_AT.getTime() - 10 * HOUR) },
    });
    const adoptedAppRow = mergedPrRow({
      id: "pr-1-app",
      githubId: "gh-1",
      additions: 100,
      deletions: 50,
      repositoryId: "r1",
      repository: { name: "symphony-alpha" },
    });
    const { db } = makeFakeDb({
      mergedPrs: [adoptedAppRow, twinOnSecondBranch],
      // The count ran before the twin landed.
      counts: deliveryCounts({ mergedRows: 1 }),
    });
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(cb(db as never))
    );

    const result = await insightsService.getDelivery(
      ORG_CTX,
      InsightsPeriod.Quarter,
      NOW
    );

    // Subtracting the unseen duplicate from the stale count reported ZERO, and
    // the rest of the response — every facet of which is built from the very
    // scan that is holding the pull request — then contradicted it. The scan's
    // own distinct count is the floor that cannot lie.
    expect(result.kpis.find((k) => k.key === "merged")?.value).toBe(1);
    expect(result.kpis.find((k) => k.key === "mergedCount")?.value).toBe(1);
    expect(result.kpis.find((k) => k.key === "mergedPrsScanned")?.value).toBe(
      1
    );
    // Was `[]` — an empty state donut beside a daily trend reporting a merge.
    expect(result.charts.prByState).toEqual([
      { key: ApiGitHubPRState.Merged, label: "Merged", value: 1 },
    ]);
    expect(
      result.charts.prTrend.points.find((point) => point.date === "2026-06-08")
        ?.values.merged
    ).toBe(1);
    expect(
      result.charts.prByRepo.reduce((total, bucket) => total + bucket.value, 0)
    ).toBe(1);
    // Was 0% — 0/(0+0) with a merged pull request on the screen.
    expect(result.kpis.find((k) => k.key === "merge-rate")?.value).toBe(100);
  });

  it("dedupes the prior window too, so the delta is not movement that never happened", async () => {
    const currentPr = mergedPrRow({
      id: "pr-9",
      number: 9,
      githubId: "gh-9",
      additions: 10,
      deletions: 10,
      repositoryId: "r1",
      branchArtifactId: "b9",
      repository: { name: "symphony-alpha" },
    });
    // The prior window's population: three rows, two pull requests.
    const priorIdentityRows = [
      {
        id: "prior-1-app",
        number: 1,
        githubId: "gh-p1",
        repositoryFullName: "acme/symphony-alpha",
        repositoryId: "r1",
      },
      {
        id: "prior-1-desktop",
        number: 1,
        githubId: null,
        repositoryFullName: "acme/symphony-alpha",
        repositoryId: null,
      },
      {
        id: "prior-2",
        number: 2,
        githubId: "gh-p2",
        repositoryFullName: "acme/web",
        repositoryId: "r2",
      },
    ];
    const { db, rawQueries } = makeFakeDb({
      mergedPrs: [currentPr],
      priorMergedPrs: priorIdentityRows,
      counts: deliveryCounts({ mergedRows: 1 }),
    });
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(cb(db as never))
    );

    const result = await insightsService.getDelivery(
      ORG_CTX,
      InsightsPeriod.Quarter,
      NOW
    );

    const merged = result.kpis.find((k) => k.key === "merged");
    expect(merged?.value).toBe(1);
    // 1 this window vs 2 pull requests last window = -50%. Against the raw
    // prior ROW count of 3 the same window would have read -67%.
    expect(merged?.deltaPct).toBe(-50);

    // ISS-5624: the prior window is deduped by a DB aggregate, so deduping the
    // delta costs one row on the wire — not a capped, identity-ordered slice of
    // up to MERGED_PR_SCAN_CAP identities that the endpoint then reduces in JS.
    const priorCount = rawQueries.map(flattenRawSql).find(isPriorWindowCount);
    expect(priorCount?.text).toContain("SELECT COUNT(*)::int AS n");
    expect(priorCount?.values).toContain(ORG);
  });

  it("does not count the prior window when there is none (the 'all' period)", async () => {
    const { db, mergedFindArgs, rawQueries } = makeFakeDb({
      mergedPrs: [],
      counts: deliveryCounts({ mergedRows: 0 }),
    });
    vi.mocked(withDb).mockImplementation((cb) =>
      Promise.resolve(cb(db as never))
    );

    await insightsService.getDelivery(ORG_CTX, InsightsPeriod.All, NOW);

    expect(rawQueries.map(flattenRawSql).filter(isPriorWindowCount)).toEqual(
      []
    );
    // The one PR scan the endpoint does still materialize stays bounded.
    expect(mergedFindArgs.length).toBeGreaterThan(0);
    for (const args of mergedFindArgs) {
      expect(args.take).toBe(MERGED_PR_SCAN_CAP);
    }
  });
});

// ISS-5411 gave buildPrByRepoBuckets a second parameter, so its cases moved
// here from the grandfathered `service.test.ts` rather than being edited in
// place — the shrink-only rule forbids that file growing, and the counts-vs-
// labels split these now pin is this issue's concern.
describe("buildPrByRepoBuckets", () => {
  const row = (
    overrides: Partial<{
      repositoryFullName: string | null;
      repository: { name: string } | null;
    }>
  ) =>
    ({
      mergedAt: MERGED_AT,
      repositoryId: null,
      repositoryFullName: null,
      branchArtifactId: "b",
      repository: null,
      branchArtifact: { createdAt: new Date(MERGED_AT.getTime() - HOUR) },
      ...overrides,
    }) as Parameters<typeof buildPrByRepoBuckets>[0][number];

  it("merges App + desktop lanes for one repo across casing", () => {
    const lanes = [
      // App lane: canonical-case short name.
      row({ repository: { name: "Foo-Bar" } }),
      // Desktop repo-less lane: lowercased owner/name for the SAME repo.
      row({ repositoryFullName: "acme/foo-bar" }),
      // A different repo.
      row({ repository: { name: "Widgets" } }),
    ];
    const buckets = buildPrByRepoBuckets(lanes, lanes);

    // One bucket for the shared repo (count 2), canonical casing preserved.
    expect(buckets).toContainEqual({ label: "Foo-Bar", value: 2 });
    expect(buckets).toContainEqual({ label: "Widgets", value: 1 });
    expect(buckets).toHaveLength(2);
  });

  it("drops rows with neither repo identity", () => {
    const anonymous = [row({})];

    expect(buildPrByRepoBuckets(anonymous, anonymous)).toEqual([]);
  });

  it("keeps canonical casing supplied only by a row the dedupe dropped", () => {
    // The repo-less desktop row can win the dedupe (it is the sized one), and
    // it only knows the lowercased owner/name. Reading the label off the
    // surviving rows alone would downgrade the bucket to "foo-bar".
    const survivor = row({ repositoryFullName: "acme/foo-bar" });
    const droppedAppTwin = row({ repository: { name: "Foo-Bar" } });

    expect(
      buildPrByRepoBuckets([survivor], [survivor, droppedAppTwin])
    ).toEqual([{ label: "Foo-Bar", value: 1 }]);
  });
});
