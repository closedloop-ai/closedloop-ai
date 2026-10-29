import assert from "node:assert/strict";
import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics";
import { GitHubPRState } from "@repo/api/src/types/github";
import { test } from "vitest";
import { projectDesktopCanonicalMetrics } from "../src/main/branch/branch-canonical-metric-projection.js";
import {
  makeBranchPrRowFixture,
  makeBranchRowFixture,
} from "./shared-branches-test-helpers.js";

const WINDOW = {
  startDate: "2026-07-27T00:00:00.000Z",
  endDate: "2026-08-03T00:00:00.000Z",
};
const BOUNDARY = new Date("2026-08-03T00:00:00.000Z");

test("ISS-9959: desktop clears a window whose only shortfall is an ambiguity among PRs it read", () => {
  const metrics = projectDesktopCanonicalMetrics(
    staleAmbiguousCohort(),
    [],
    staleAmbiguousPrRows(),
    WINDOW,
    BOUNDARY
  );

  // Two OPEN pull requests the twin read in full make the collection Incomplete,
  // but they hide no merge and no unmerged close — the shortfall is about WHICH
  // pull request represents the branch. Before ISS-9959 that flipped one
  // cohort-wide flag and both cards were Partial in every window, permanently.
  assert.equal(
    metrics.medianPrSize.current.state,
    BranchMetricAvailability.Complete
  );
  assert.equal(
    metrics.mergeRatePct.current.state,
    BranchMetricAvailability.Complete
  );
});

test("ISS-9959: desktop keeps every window short when a decided PR's instant was never read", () => {
  const metrics = projectDesktopCanonicalMetrics(
    staleAmbiguousCohort(),
    [],
    unreadTerminalPrRows(),
    WINDOW,
    BOUNDARY
  );

  // The regression codex caught on review. A CLOSED pull request with no terminal
  // instant IS a decision, taken at a time nobody read, and
  // `buildPullRequestLifecycleActivityRecords` emits no atom for it — so the
  // branch reads "last active 2026-06-01" while the unread close could have
  // landed inside this window. Anchoring the gap on that activity declared this
  // window Complete and published a merge rate quietly missing a decision.
  assert.equal(
    metrics.medianPrSize.current.state,
    BranchMetricAvailability.Partial
  );
  assert.equal(
    metrics.mergeRatePct.current.state,
    BranchMetricAvailability.Partial
  );
});

test("ISS-9959: desktop keeps every window short when PR coverage is incomplete", () => {
  const metrics = projectDesktopCanonicalMetrics(
    staleAmbiguousCohort(),
    [],
    staleAmbiguousPrRows(),
    WINDOW,
    BOUNDARY,
    [],
    new Map(),
    undefined,
    true,
    // A cohort-wide PR coverage shortfall belongs to no branch, so it carries no
    // instant and must keep poisoning every window.
    false
  );

  assert.equal(
    metrics.medianPrSize.current.state,
    BranchMetricAvailability.Partial
  );
  assert.equal(
    metrics.mergeRatePct.current.state,
    BranchMetricAvailability.Partial
  );
});

test("desktop does not star a window for a closed draft (operator ruling 2026-10-14)", () => {
  const metrics = projectDesktopCanonicalMetrics(
    staleAmbiguousCohort(),
    [],
    [
      makeBranchPrRowFixture(),
      {
        ...makeBranchPrRowFixture(),
        branchName: "feature/stale-branch",
        prNumber: 2,
        state: GitHubPRState.Closed,
        isDraft: true,
        mergedAt: null,
        closedAt: "2026-08-02T00:00:00.000Z",
        linesAdded: 1000,
        linesRemoved: 0,
      },
    ],
    WINDOW,
    BOUNDARY
  );

  assert.deepEqual(metrics.medianPrSize.current, {
    state: BranchMetricAvailability.Complete,
    value: 12,
  });
  assert.deepEqual(metrics.mergeRatePct.current, {
    state: BranchMetricAvailability.Complete,
    value: 100,
  });
});

/** One branch cleanly merged in-window, one stale carrying the short evidence. */
function staleAmbiguousCohort() {
  return [
    makeBranchRowFixture({
      id: "merged-branch",
      lastActivityAt: "2026-08-01T00:00:00.000Z",
      canonicalLastActiveAt: {
        state: BranchMetricAvailability.Complete,
        value: "2026-08-01T00:00:00.000Z",
      },
    }),
    makeBranchRowFixture({
      id: "stale-branch",
      lastActivityAt: "2026-06-01T00:00:00.000Z",
      canonicalLastActiveAt: {
        state: BranchMetricAvailability.Complete,
        value: "2026-06-01T00:00:00.000Z",
      },
    }),
  ];
}

/**
 * The merged branch's in-window pull request, plus TWO active ones on the stale
 * branch — `multiple_active`, an ambiguity among pull requests whose timestamps
 * were all read.
 */
function staleAmbiguousPrRows() {
  const active = {
    ...makeBranchPrRowFixture(),
    branchName: "feature/stale-branch",
    state: GitHubPRState.Open,
    mergedAt: null,
    closedAt: null,
  };
  return [
    makeBranchPrRowFixture(),
    { ...active, prNumber: 2 },
    { ...active, prNumber: 3 },
  ];
}

/**
 * The same merged pull request, plus a CLOSED one on the stale branch carrying
 * neither terminal timestamp — `missing_terminal_timestamp`, a decision whose
 * instant is unknown and therefore unplaceable in any window.
 */
function unreadTerminalPrRows() {
  return [
    makeBranchPrRowFixture(),
    {
      ...makeBranchPrRowFixture(),
      branchName: "feature/stale-branch",
      prNumber: 2,
      state: GitHubPRState.Closed,
      mergedAt: null,
      closedAt: null,
    },
  ];
}
