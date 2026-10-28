/**
 * ISS-11283 lane B — branch coverage for
 * `src/main/branch/branch-canonical-metric-projection.ts`.
 *
 * `branch-canonical-metric-projection.test.ts` drives the full
 * `projectDesktopCanonicalMetrics` aggregation extensively but never sets a
 * `SharedBranchesQuery` owner/search/loc filter, never calls
 * `selectExactBranchCohort` with an empty id list, and never calls
 * `attachDesktopCanonicalDetailMetrics` with a missing detail field or a
 * malformed PR row ahead of the real match.
 */
import { BranchStatus } from "@repo/api/src/types/branch";
import {
  BranchAssociatedPullRequestCompletenessState,
  BranchAssociatedPullRequestProvenance,
  BranchAssociatedPullRequestSelectionReason,
} from "@repo/api/src/types/branch-associated-pull-request";
import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics";
import { BranchPhaseAttributionCompleteness } from "@repo/api/src/types/branch-phase-attribution";
import { GitHubPRState } from "@repo/api/src/types/github";
import { describe, expect, it } from "vitest";
import {
  attachDesktopCanonicalDetailMetrics,
  filterCanonicalDesktopCohort,
  selectExactBranchCohort,
} from "../src/main/branch/branch-canonical-metric-projection.js";
import {
  makeBranchPrRowFixture,
  makeBranchRowFixture,
} from "./shared-branches-test-helpers.js";

describe("selectExactBranchCohort with no requested ids", () => {
  it("returns an empty cohort rather than the fail-open full list", () => {
    const items = [makeBranchRowFixture({ id: "a" })];

    expect(selectExactBranchCohort(items, [])).toEqual([]);
    // A list of only empty-string ids is the same "nothing requested" case.
    expect(selectExactBranchCohort(items, ["", ""])).toEqual([]);
  });

  it("positive control: returns the matching item when ids are actually requested", () => {
    const items = [
      makeBranchRowFixture({ id: "a" }),
      makeBranchRowFixture({ id: "b" }),
    ];

    expect(
      selectExactBranchCohort(items, ["b"]).map((item) => item.id)
    ).toEqual(["b"]);
  });
});

describe("filterCanonicalDesktopCohort owner filter", () => {
  it("keeps only branches owned by the requested owner", () => {
    const items = [
      makeBranchRowFixture({ id: "alice-branch", owner: "alice" }),
      makeBranchRowFixture({ id: "bob-branch", owner: "bob" }),
    ];

    const filtered = filterCanonicalDesktopCohort(items, { owner: "alice" });

    expect(filtered.map((item) => item.id)).toEqual(["alice-branch"]);
  });
});

describe("filterCanonicalDesktopCohort repo and status filters", () => {
  it("excludes a branch whose repo or status does not match, and resolves the short repo name from the LAST path segment", () => {
    const items = [
      makeBranchRowFixture({
        id: "matches-short-repo",
        repoFullName: "org/team/web",
        status: BranchStatus.Open,
      }),
      makeBranchRowFixture({
        id: "wrong-repo",
        repoFullName: "org/team/other",
        status: BranchStatus.Open,
      }),
      makeBranchRowFixture({
        id: "wrong-status",
        repoFullName: "org/team/web",
        status: BranchStatus.Merged,
      }),
    ];

    const filtered = filterCanonicalDesktopCohort(items, {
      repo: "web",
      status: BranchStatus.Open,
    });

    // A 3-segment repoFullName distinguishes the real `.at(-1)` (last
    // segment, "web") from a mutated `.at(1)` (second segment, "team") or a
    // `.split("")` (last CHARACTER, "b") — only the real derivation matches.
    expect(filtered.map((item) => item.id)).toEqual(["matches-short-repo"]);
  });

  it("also matches by the full repoFullName, not only the short name", () => {
    const items = [
      makeBranchRowFixture({ id: "full-match", repoFullName: "acme/web" }),
      makeBranchRowFixture({ id: "no-match", repoFullName: "acme/other" }),
    ];

    const filtered = filterCanonicalDesktopCohort(items, {
      repo: "acme/web",
    });

    expect(filtered.map((item) => item.id)).toEqual(["full-match"]);
  });
});

describe("filterCanonicalDesktopCohort free-text search", () => {
  it("matches on branchName or repo independently, and never on prTitle", () => {
    const items = [
      makeBranchRowFixture({
        id: "by-branch-name",
        branchName: "feature/zzz-marker-branch",
        repoFullName: "acme/other",
      }),
      makeBranchRowFixture({
        id: "by-repo",
        branchName: "feature/unrelated",
        repoFullName: "acme/zzz-marker-repo",
      }),
      makeBranchRowFixture({
        // ISS-12719 counterfactual: the desktop store holds no PR title, so a
        // row whose ONLY hit is `prTitle` is excluded. A row like this is
        // unreachable in production (`BranchPrRow.title` maps to null); it
        // exists here so re-adding a prTitle search arm fails this case.
        id: "pr-title-only-is-excluded",
        branchName: "feature/unrelated-2",
        repoFullName: "acme/other2",
        prTitle: "Fix the zzz-marker bug",
      }),
      makeBranchRowFixture({
        id: "no-match",
        branchName: "feature/none",
        repoFullName: "acme/none",
      }),
    ];

    const filtered = filterCanonicalDesktopCohort(items, {
      search: "zzz-marker",
    });

    expect(filtered.map((item) => item.id).sort()).toEqual([
      "by-branch-name",
      "by-repo",
    ]);
  });
});

describe("filterCanonicalDesktopCohort LOC range filter", () => {
  it("computes LOC from whichever of additions/deletions is present, and bounds it on both sides", () => {
    const items = [
      makeBranchRowFixture({
        id: "additions-only",
        additions: 5,
        deletions: null,
      }),
      makeBranchRowFixture({
        id: "deletions-only",
        additions: null,
        deletions: 5,
      }),
      makeBranchRowFixture({
        id: "too-small",
        additions: 1,
        deletions: null,
      }),
      makeBranchRowFixture({
        id: "too-large",
        additions: 50,
        deletions: null,
      }),
      makeBranchRowFixture({
        id: "no-loc-at-all",
        additions: null,
        deletions: null,
      }),
    ];

    const filtered = filterCanonicalDesktopCohort(items, {
      locMin: 5,
      locMax: 5,
    });

    // Both "additions-only" and "deletions-only" compute loc=5 (the null side
    // contributes 0, not something else), so both pass an exact [5,5] window;
    // the too-small/too-large/no-loc rows are all excluded.
    expect(filtered.map((item) => item.id).sort()).toEqual([
      "additions-only",
      "deletions-only",
    ]);
  });

  it("treats unavailable LOC as excluded at a zero-valued boundary, not as a real zero", () => {
    const noLocRow = makeBranchRowFixture({
      id: "no-loc-at-all",
      additions: null,
      deletions: null,
    });

    // At locMin:0, a genuine loc of 0 would pass (0 >= 0); unavailable loc
    // (null) must still be excluded — proving the `loc !== null` guard is
    // real, not a `true &&` that lets `null >= 0` sneak through.
    expect(filterCanonicalDesktopCohort([noLocRow], { locMin: 0 })).toEqual([]);
    expect(filterCanonicalDesktopCohort([noLocRow], { locMax: 0 })).toEqual([]);
  });
});

describe("attachDesktopCanonicalDetailMetrics with incomplete detail input", () => {
  it("does nothing when associatedPullRequests is absent, even with a valid phaseAttribution", () => {
    const detail: Parameters<typeof attachDesktopCanonicalDetailMetrics>[0] = {
      estimatedCostUsd: null,
      attributedCostUsd: null,
      associatedPullRequests: undefined,
      phaseAttribution: {
        segments: [],
        rollups: [],
        coverage: {
          completeness: BranchPhaseAttributionCompleteness.Complete,
          subtotalUsd: 0,
        },
      },
    };

    attachDesktopCanonicalDetailMetrics(detail, [makeBranchPrRowFixture()]);

    expect(detail.canonicalMetrics).toBeUndefined();
  });

  it("skips a malformed pull-request row ahead of the real match instead of throwing", () => {
    const detail: Parameters<typeof attachDesktopCanonicalDetailMetrics>[0] = {
      estimatedCostUsd: 10,
      attributedCostUsd: 10,
      associatedPullRequests: {
        items: [
          {
            id: "acme/web#1",
            repositoryFullName: "acme/web",
            number: 1,
            title: null,
            url: null,
            state: GitHubPRState.Merged,
            isDraft: false,
            reviewDecision: null,
            openedAt: "2026-07-30T00:00:00.000Z",
            closedAt: "2026-08-01T00:00:00.000Z",
            mergedAt: "2026-08-01T00:00:00.000Z",
          },
        ],
        selectedId: "acme/web#1",
        selectionReason:
          BranchAssociatedPullRequestSelectionReason.MostRecentTerminal,
        completeness: {
          state: BranchAssociatedPullRequestCompletenessState.Complete,
          reasons: [],
          provenance: BranchAssociatedPullRequestProvenance.PersistedDesktop,
        },
      },
      phaseAttribution: {
        segments: [],
        rollups: [],
        coverage: {
          completeness: BranchPhaseAttributionCompleteness.Complete,
          subtotalUsd: 20,
        },
      },
    };
    const malformedRow = {
      ...makeBranchPrRowFixture(),
      repoFullName: null,
      // Deliberately different LOC from the real row, so a wrong match (or a
      // crash inside the guard) would change locPerDollar's value below.
      linesAdded: 999,
      linesRemoved: 999,
    };
    const decoyValidRow = {
      // Valid identity (passes the guard) but the WRONG PR number, ordered
      // BEFORE the real row: a mutated equality check that always matches
      // would stop here and use this LOC instead of the real row's.
      ...makeBranchPrRowFixture(),
      prNumber: 999,
      linesAdded: 777,
      linesRemoved: 777,
    };
    const realRow = {
      ...makeBranchPrRowFixture(),
      branchName: "feature/active-branch",
      linesAdded: 50,
      linesRemoved: 50,
    };

    attachDesktopCanonicalDetailMetrics(detail, [
      malformedRow,
      decoyValidRow,
      realRow,
    ]);

    // additions(50) + deletions(50) over attributedCostUsd(10) = 10.
    expect(detail.canonicalMetrics?.locPerDollar).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 10,
    });
  });

  it("selects the second item by its own id, not merely the first item in the list", () => {
    const detail: Parameters<typeof attachDesktopCanonicalDetailMetrics>[0] = {
      estimatedCostUsd: 10,
      attributedCostUsd: 10,
      associatedPullRequests: {
        items: [
          {
            id: "acme/web#1",
            repositoryFullName: "acme/web",
            number: 1,
            title: null,
            url: null,
            state: GitHubPRState.Merged,
            isDraft: false,
            reviewDecision: null,
            openedAt: "2026-07-30T00:00:00.000Z",
            closedAt: "2026-08-01T00:00:00.000Z",
            mergedAt: "2026-08-01T00:00:00.000Z",
          },
          {
            id: "acme/web#2",
            repositoryFullName: "acme/web",
            number: 2,
            title: null,
            url: null,
            state: GitHubPRState.Merged,
            isDraft: false,
            reviewDecision: null,
            openedAt: "2026-07-30T00:00:00.000Z",
            closedAt: "2026-08-01T00:00:00.000Z",
            mergedAt: "2026-08-01T00:00:00.000Z",
          },
        ],
        selectedId: "acme/web#2",
        selectionReason:
          BranchAssociatedPullRequestSelectionReason.MostRecentTerminal,
        completeness: {
          state: BranchAssociatedPullRequestCompletenessState.Complete,
          reasons: [],
          provenance: BranchAssociatedPullRequestProvenance.PersistedDesktop,
        },
      },
      phaseAttribution: {
        segments: [],
        rollups: [],
        coverage: {
          completeness: BranchPhaseAttributionCompleteness.Complete,
          subtotalUsd: 20,
        },
      },
    };
    const rowForItem1 = {
      ...makeBranchPrRowFixture(),
      prNumber: 1,
      linesAdded: 999,
      linesRemoved: 999,
    };
    const rowForItem2 = {
      ...makeBranchPrRowFixture(),
      prNumber: 2,
      linesAdded: 50,
      linesRemoved: 50,
    };

    attachDesktopCanonicalDetailMetrics(detail, [rowForItem1, rowForItem2]);

    expect(detail.canonicalMetrics?.locPerDollar).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 10,
    });
  });

  it("does not throw when selectedId matches no item at all", () => {
    const detail: Parameters<typeof attachDesktopCanonicalDetailMetrics>[0] = {
      estimatedCostUsd: 10,
      attributedCostUsd: 10,
      associatedPullRequests: {
        items: [],
        selectedId: "acme/web#404",
        selectionReason:
          BranchAssociatedPullRequestSelectionReason.MostRecentTerminal,
        completeness: {
          state: BranchAssociatedPullRequestCompletenessState.Complete,
          reasons: [],
          provenance: BranchAssociatedPullRequestProvenance.PersistedDesktop,
        },
      },
      phaseAttribution: {
        segments: [],
        rollups: [],
        coverage: {
          completeness: BranchPhaseAttributionCompleteness.Complete,
          subtotalUsd: 20,
        },
      },
    };

    expect(() =>
      attachDesktopCanonicalDetailMetrics(detail, [makeBranchPrRowFixture()])
    ).not.toThrow();
    expect(detail.canonicalMetrics?.locPerDollar.state).toBe(
      BranchMetricAvailability.Unavailable
    );
  });
});
