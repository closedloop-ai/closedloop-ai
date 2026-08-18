import {
  type BranchAnalytics,
  BranchKpiState,
  BranchStatus,
  type BranchRow as WireBranchRow,
} from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import {
  CostAvailability,
  deriveCostAvailability,
  formatCostLabel,
  getCostTooltip,
} from "@repo/app/agents/lib/cost-availability";
import {
  resolveSessionDurationWindow,
  resolveSessionWallClockLabel,
} from "@repo/app/agents/lib/session-duration";
import { describe, expect, it } from "vitest";
import { makeBranchAnalytics } from "../../components/branch-analytics-fixtures";
import type { BranchRow as RenderBranchRow } from "../branch-row";
import { BranchRowStatus, DEFAULT_BRANCH_FILTERS } from "../branch-row";
import { filterBranchRowsByWindow } from "../branch-sort-group";
import {
  deriveFilteredBranchAnalytics,
  selectVisibleWireRows,
} from "../filtered-branch-analytics";

/**
 * ISS-4407 — behavioral regression coverage for the recurring Sessions/Branches
 * derived-value RECONCILIATION bug classes a logical-QA sweep surfaced (values
 * that disagree list-vs-detail or web-vs-desktop, counts that don't reconcile
 * with filters/population, misleading zero/unavailable states, multi-PR math on
 * single-PR cohorts, date-window cohorts that differ between summary and table).
 *
 * The individual derivations already have example-based unit tests; this file
 * adds the CLASS-LEVEL invariants those examples don't assert, so a regression
 * that reintroduces a whole class (not just one example) fails here. Every test
 * drives the REAL canonical derivation with fixtures and asserts the observable
 * reconciled output — no source scans, no timing, no duplicated helper logic.
 */

function makeWireRow(over: Partial<WireBranchRow> = {}): WireBranchRow {
  return {
    id: "b1",
    branchName: "feature/x",
    baseBranch: null,
    repoFullName: "acme/web",
    owner: "alice",
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
    lastActivityAt: "2026-06-10T12:00:00.000Z",
    sessionIds: [],
    ...over,
  };
}

function makeRenderRow(over: Partial<RenderBranchRow>): RenderBranchRow {
  return {
    id: "b1",
    branchName: "feature/x",
    baseBranch: "main",
    repo: "acme/web",
    owner: "alice",
    status: BranchRowStatus.Open,
    prNumber: null,
    prTitle: null,
    prUrl: null,
    prState: null,
    checksPassed: null,
    checksTotal: null,
    checksStatus: null,
    behind: null,
    ahead: null,
    additions: null,
    deletions: null,
    sessionCount: 0,
    commentCount: null,
    lastActivityLabel: "1d",
    ...over,
  };
}

type CountKpiKey = "activeBranchCount" | "activePrCount" | "mergedCount";

const KPI_COUNT_KEYS: readonly CountKpiKey[] = [
  "activeBranchCount",
  "activePrCount",
  "mergedCount",
];

/**
 * Read a count KPI that the invariant REQUIRES to be `Available`, THROWING (which
 * fails the enclosing test) when the state regressed to `Unavailable` (a distinct
 * "we couldn't derive this" state) — instead of silently coercing it to 0 and
 * passing every downstream `<=`/equality check as if the count were a legitimate
 * zero. Throws rather than `expect()` so it stays a reusable helper outside an
 * `it()` (Biome's `noMisplacedAssertion`), while still surfacing the distinct
 * unavailable state as a hard failure at the call site.
 */
function expectAvailableKpiValue(
  analytics: BranchAnalytics,
  key: CountKpiKey
): number {
  const kpi = analytics[key];
  if (kpi.state !== BranchKpiState.Available || kpi.value == null) {
    throw new Error(
      `expected KPI "${key}" to be Available with a numeric value, got state=${kpi.state} value=${kpi.value}`
    );
  }
  return kpi.value;
}

/**
 * ISS-5131 (#4409 review): the Duration resolvers take their clock as an
 * argument. Every case in this file is a TERMINAL session, so the value is
 * irrelevant to the result — pinning it is what proves that.
 */
const NOW_MS = new Date("2026-08-04T18:05:00.000Z").getTime();

describe("ISS-4407 list-vs-detail / web-vs-desktop value parity", () => {
  it("Sessions list Duration equals the detail Properties headline for the same session (ISS-4631 class)", () => {
    // Two surfaces reading the SAME session must not print two different
    // Duration numbers (the ISS-4631 bug). ISS-5131: they agree because both
    // resolve the ONE window from the session's status and `endedAt` — not
    // because both happen to echo the collector's `wallClock`, which on a
    // completed session tracked SYNC time and read 5.5x too high.
    const startedAt = "2026-06-10T08:00:00.000Z";
    const endedAt = "2026-06-10T11:33:00.000Z";
    const window = resolveSessionDurationWindow(
      SESSION_STATUS.INACTIVE,
      endedAt
    );
    const listLabel = resolveSessionWallClockLabel(startedAt, window, NOW_MS);
    const detailLabel = resolveSessionWallClockLabel(startedAt, window, NOW_MS);

    expect(listLabel).toBe("3h 33m");
    expect(listLabel).toBe(detailLabel);
    // ...and it is the session's own span, not the collector's activity-anchored
    // `wallClock`, which on this session read 170h 30m for a 3h 33m run.
    expect(listLabel).not.toBe("170h 30m");
  });

  it("Duration is identical whether the surface passes Date objects (web) or ISO strings (desktop)", () => {
    // The web shell passes Date objects; the desktop renderer passes ISO
    // strings. The same two instants must yield the same label so the surfaces
    // cannot diverge.
    const startIso = "2026-06-10T08:00:00.000Z";
    const endIso = "2026-06-10T09:30:00.000Z";
    const webLabel = resolveSessionWallClockLabel(
      new Date(startIso),
      resolveSessionDurationWindow(SESSION_STATUS.INACTIVE, new Date(endIso)),
      NOW_MS
    );
    const desktopLabel = resolveSessionWallClockLabel(
      startIso,
      resolveSessionDurationWindow(SESSION_STATUS.INACTIVE, endIso),
      NOW_MS
    );

    expect(webLabel).not.toBeNull();
    expect(webLabel).toBe(desktopLabel);
  });
});

describe("ISS-4407 count reconciliation invariants (filters + population)", () => {
  // A mixed corpus: merged/open/closed, single- and multi-PR, priced and not.
  function corpus(): WireBranchRow[] {
    return [
      makeWireRow({
        id: "m1",
        status: BranchStatus.Merged,
        prState: GitHubPRState.Merged,
        mergedAt: "2026-06-05T00:00:00.000Z",
        owner: "alice",
        additions: 40,
        deletions: 10,
      }),
      makeWireRow({
        id: "m2",
        status: BranchStatus.Merged,
        prState: GitHubPRState.Merged,
        mergedAt: "2026-06-06T00:00:00.000Z",
        owner: "bob",
        additions: 20,
        deletions: 20,
      }),
      makeWireRow({
        id: "o1",
        status: BranchStatus.Open,
        prState: GitHubPRState.Open,
        owner: "alice",
      }),
      makeWireRow({
        id: "c1",
        status: BranchStatus.Closed,
        prState: GitHubPRState.Closed,
        owner: "bob",
      }),
      // STALE-OPEN-BUT-MERGED (the FEA-4333 double-classification trap): the raw
      // `prState` still reads OPEN, but `mergedAt` is set, so the merge-evidence-
      // first `countPrLifecycle` classifier MUST bucket it as merged ONLY, never
      // also into the active-PR bucket. Without this row the corpus has no PR
      // whose open-vs-merged classification is ambiguous, so a regression that
      // re-read raw `prState` and double-counted it would still satisfy a loose
      // `<= rows.length` bound.
      makeWireRow({
        id: "so",
        status: BranchStatus.Merged,
        prState: GitHubPRState.Open,
        mergedAt: "2026-06-08T00:00:00.000Z",
        owner: "bob",
      }),
      // Multi-PR merged branch — must never enter the single-PR merge/median math.
      makeWireRow({
        id: "mp",
        status: BranchStatus.Merged,
        prState: GitHubPRState.Merged,
        mergedAt: "2026-06-07T00:00:00.000Z",
        owner: "alice",
        multiPrWarning: true,
        additions: 500,
        deletions: 500,
      }),
    ];
  }

  it("narrowing a facet never GROWS a reconciled count, and no count exceeds the visible population", () => {
    const base = makeBranchAnalytics({});
    const rows = corpus();

    const unfiltered = deriveFilteredBranchAnalytics(
      base,
      rows,
      DEFAULT_BRANCH_FILTERS
    );
    // Narrow by owner (a strict subset of the population).
    const narrowed = deriveFilteredBranchAnalytics(base, rows, {
      ...DEFAULT_BRANCH_FILTERS,
      owners: ["alice"],
    });
    const visibleAlice = rows.filter((row) => row.owner === "alice").length;

    for (const key of KPI_COUNT_KEYS) {
      const wide = expectAvailableKpiValue(unfiltered, key);
      const tight = expectAvailableKpiValue(narrowed, key);
      // Narrowing the filter can only shrink (or hold) a count, never grow it.
      expect(tight).toBeLessThanOrEqual(wide);
      // No count may exceed its own parent population (the visible subset size).
      expect(tight).toBeLessThanOrEqual(visibleAlice);
      expect(wide).toBeLessThanOrEqual(rows.length);
    }
  });

  it("mutually-exclusive PR buckets: active-PR and merged counts never overlap or exceed the population", () => {
    const base = makeBranchAnalytics({});
    const rows = corpus();
    const result = deriveFilteredBranchAnalytics(
      base,
      rows,
      DEFAULT_BRANCH_FILTERS
    );

    const activePr = expectAvailableKpiValue(result, "activePrCount");
    const merged = expectAvailableKpiValue(result, "mergedCount");
    // EXACT buckets over the single-PR population (multi-PR `mp` excluded):
    //   active  = o1 (genuinely OPEN, no merge evidence)              → 1
    //   merged  = m1, m2, so (the stale-open-but-merged PR)           → 3
    //   closed  = c1                                                  → 1
    // The stale-open-but-merged `so` row lands ONLY in `merged`; re-reading raw
    // `prState` (the FEA-4333 regression) would push it into `active` too, making
    // active=2 / merged=3 and the sum 5 = rows.length — which a loose
    // `<= rows.length` bound would still accept. Pinning the exact bucket values
    // makes that reintroduction fail here.
    expect(activePr).toBe(1);
    expect(merged).toBe(3);
    // Disjoint buckets: their sum stays within the single-PR population and never
    // reaches rows.length, so no PR is double-classified.
    expect(activePr + merged).toBeLessThan(rows.length);
  });
});

describe("ISS-4407 UX-state distinctness (true-zero vs unavailable vs no-usage)", () => {
  it("keeps a real priced cost, worked-but-unpriced, and never-ran as three DISTINCT states, not one collapsed empty", () => {
    // (a) A session that DID work and priced to a real positive cost — shown as a
    //     dollar value, NOT an em-dash.
    const priced = deriveCostAvailability({
      estimatedCost: 4.82,
      turns: 5,
      inputTokens: 100,
      outputTokens: 50,
    });
    // (b) A session that worked but has no pricing for its model (cost floors to
    //     0) — unavailable, shown as "—" with a pricing tooltip. Distinct from a
    //     session that never ran even though both surface an em-dash.
    const unpriced = deriveCostAvailability({
      estimatedCost: 0,
      turns: 5,
      inputTokens: 100,
      outputTokens: 50,
      model: "some-unpriced-model",
      billingMode: "api",
    });
    // (c) A session that never did measurable work — no-usage, shown as "—".
    const neverRan = deriveCostAvailability({
      estimatedCost: 0,
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
    });

    // The three availabilities are distinct classifications.
    expect(priced).toBe(CostAvailability.Available);
    expect(unpriced).toBe(CostAvailability.Unavailable);
    expect(neverRan).toBe(CostAvailability.NoUsage);

    // The priced session renders a real value; the two empties render "—" — the
    // measured cost is never collapsed into the same glyph as "no data".
    expect(formatCostLabel(priced, 4.82)).toBe("$4.82");
    expect(formatCostLabel(unpriced, 0)).toBe("—");
    expect(formatCostLabel(neverRan, 0)).toBe("—");

    // The two "—" states are NOT collapsed: only the unavailable one explains WHY
    // (pricing gap), so the UI never lies that a worked session did nothing.
    expect(getCostTooltip(unpriced)).not.toBeNull();
    expect(getCostTooltip(neverRan)).toBeNull();
    expect(getCostTooltip(unpriced)).not.toBe(getCostTooltip(neverRan));
  });
});

describe("ISS-4407 multi-PR branch math never applied to single-PR cohorts", () => {
  it("the Median PR size KPI ignores a multi-PR branch, so adding one to the corpus does not move the single-PR median", () => {
    const base = makeBranchAnalytics({});
    const singlePrOnly = [
      makeWireRow({
        id: "s1",
        status: BranchStatus.Merged,
        multiPrWarning: false,
        additions: 40,
        deletions: 10,
      }), // 50
      makeWireRow({
        id: "s2",
        status: BranchStatus.Merged,
        multiPrWarning: false,
        additions: 20,
        deletions: 20,
      }), // 40
      makeWireRow({
        id: "s3",
        status: BranchStatus.Merged,
        multiPrWarning: false,
        additions: 90,
        deletions: 10,
      }), // 100
    ];
    // A giant multi-PR merged branch; folding its 1000 LOC into the single-PR
    // median would skew it. The row carries only the LATEST PR's LOC, so its size
    // is ambiguous and BOTH server producers exclude multi-PR branches.
    const withHugeMultiPr = [
      ...singlePrOnly,
      makeWireRow({
        id: "mp",
        status: BranchStatus.Merged,
        multiPrWarning: true,
        additions: 500,
        deletions: 500,
      }),
    ];

    // Drive the PRODUCTION Branches-summary derivation (the same code path the
    // page renders), not the orphan `medianPrSize` helper — that helper has no
    // production callers and `deriveFilteredBranchAnalytics` recomputes the KPI
    // independently, so exercising the helper would leave the real regression
    // uncovered.
    const before = deriveFilteredBranchAnalytics(
      base,
      singlePrOnly,
      DEFAULT_BRANCH_FILTERS
    ).medianPrSize;
    const after = deriveFilteredBranchAnalytics(
      base,
      withHugeMultiPr,
      DEFAULT_BRANCH_FILTERS
    ).medianPrSize;

    expect(before.state).toBe(BranchKpiState.Available);
    expect(before.value).toBe(50); // median of [40, 50, 100]
    // The multi-PR branch is excluded from the single-PR median cohort, so the
    // KPI state AND value are unchanged after adding it.
    expect(after.state).toBe(BranchKpiState.Available);
    expect(after.value).toBe(before.value);
  });
});

describe("ISS-4407 date-window cohort parity (summary cards == table population)", () => {
  it("summary KPIs re-derive over exactly the rows the ACTUAL date-window filter keeps; out-of-window rows never leak in", () => {
    const base = makeBranchAnalytics({});
    const windowStart = "2026-06-01T00:00:00.000Z";
    const inWindowActivity = "2026-06-10T12:00:00.000Z"; // after windowStart
    const outOfWindowActivity = "2026-05-01T12:00:00.000Z"; // BEFORE windowStart

    // The full server corpus: two rows active inside the window, one old row
    // whose last activity predates the window and must be dropped by the ACTUAL
    // windowing predicate (not manually omitted from the visible set).
    const inWindowA = makeWireRow({
      id: "w1",
      status: BranchStatus.Open,
      prState: GitHubPRState.Open,
      lastActivityAt: inWindowActivity,
    });
    const inWindowB = makeWireRow({
      id: "w2",
      status: BranchStatus.Merged,
      prState: GitHubPRState.Merged,
      mergedAt: "2026-06-06T00:00:00.000Z",
      lastActivityAt: inWindowActivity,
    });
    const outOfWindow = makeWireRow({
      id: "old",
      status: BranchStatus.Open,
      prState: GitHubPRState.Open,
      lastActivityAt: outOfWindowActivity,
    });
    const allWireRows = [inWindowA, inWindowB, outOfWindow];

    // The render rows carry the SAME activity timestamps, so the production
    // window filter has the data it keys on. All three are present — the filter,
    // not the fixture, decides which survive.
    const allRenderRows: RenderBranchRow[] = [
      makeRenderRow({
        id: "w1",
        status: BranchRowStatus.Open,
        lastActivityAt: inWindowActivity,
      }),
      makeRenderRow({
        id: "w2",
        status: BranchRowStatus.Merged,
        lastActivityAt: inWindowActivity,
      }),
      makeRenderRow({
        id: "old",
        status: BranchRowStatus.Open,
        lastActivityAt: outOfWindowActivity,
      }),
    ];

    // Drive the REAL wiring the page runs: window → recover wire rows by id →
    // derive. `filterBranchRowsByWindow` is the adapter under test; a regression
    // in its predicate (or in the selectVisibleWireRows hand-off) now fails here.
    const visibleRenderRows = filterBranchRowsByWindow(
      allRenderRows,
      windowStart
    );
    // The window predicate itself dropped the old row — assert that, not a
    // pre-omitted fixture.
    expect(visibleRenderRows.map((row) => row.id)).toEqual(["w1", "w2"]);

    const windowedWire = selectVisibleWireRows(allWireRows, visibleRenderRows);
    const summary = deriveFilteredBranchAnalytics(
      base,
      windowedWire,
      DEFAULT_BRANCH_FILTERS
    );
    // Truth computed over ONLY the two in-window rows the table renders.
    const truth = deriveFilteredBranchAnalytics(
      base,
      [inWindowA, inWindowB],
      DEFAULT_BRANCH_FILTERS
    );

    // The summary derived over the windowed selection equals the table's cohort.
    expect(expectAvailableKpiValue(summary, "activeBranchCount")).toBe(
      expectAvailableKpiValue(truth, "activeBranchCount")
    );
    // Exactly one active (open) row in the window — the out-of-window open row
    // does NOT inflate the summary card.
    expect(expectAvailableKpiValue(summary, "activeBranchCount")).toBe(1);
  });
});
