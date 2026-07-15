import { describe, expect, it } from "vitest";
import { makePr, makeRows, makeSession } from "./fixtures.test-helpers.ts";
import {
  NormalizedBranchStatus,
  NormalizedPrState,
} from "./normalized-rows.ts";
import {
  branchPopulations,
  prPopulations,
  sessionPopulations,
} from "./populations.ts";

describe("prPopulations", () => {
  it("mergedPrs selects only merged PRs with mergedAt in window", () => {
    const rows = makeRows({
      prs: [
        makePr({ state: NormalizedPrState.Merged, mergedAt: 200 }),
        makePr({
          state: NormalizedPrState.Closed,
          mergedAt: null,
          closedAt: 200,
        }),
        makePr({ state: NormalizedPrState.Open, mergedAt: null }),
      ],
    });
    expect(prPopulations.mergedPrs(rows)).toHaveLength(1);
  });

  it("mergedPrs excludes merges outside the window", () => {
    const rows = makeRows({
      prs: [makePr({ mergedAt: 50 })],
      window: { start: 100, end: 300 },
    });
    expect(prPopulations.mergedPrs(rows)).toHaveLength(0);
  });

  it("decidedPrs is merged ∪ closed", () => {
    const rows = makeRows({
      prs: [
        makePr({ state: NormalizedPrState.Merged, mergedAt: 200 }),
        makePr({
          state: NormalizedPrState.Closed,
          mergedAt: null,
          closedAt: 250,
        }),
        makePr({ state: NormalizedPrState.Open, mergedAt: null }),
        makePr({ state: NormalizedPrState.Draft, mergedAt: null }),
      ],
    });
    expect(prPopulations.decidedPrs(rows)).toHaveLength(2);
  });

  it("capturedPrs selects any PR created in window", () => {
    const rows = makeRows({
      prs: [
        makePr({ createdAt: 100 }),
        makePr({
          createdAt: 100,
          state: NormalizedPrState.Open,
          mergedAt: null,
        }),
      ],
    });
    expect(prPopulations.capturedPrs(rows)).toHaveLength(2);
  });

  it("activePrs selects open and draft, not merged/closed", () => {
    const rows = makeRows({
      prs: [
        makePr({
          state: NormalizedPrState.Open,
          mergedAt: null,
          observedAt: 200,
        }),
        makePr({
          state: NormalizedPrState.Draft,
          mergedAt: null,
          observedAt: 200,
        }),
        makePr({ state: NormalizedPrState.Merged, mergedAt: 200 }),
      ],
    });
    expect(prPopulations.activePrs(rows)).toHaveLength(2);
  });

  it("reviewBacklogPrs selects open only, excluding drafts", () => {
    const rows = makeRows({
      prs: [
        makePr({
          state: NormalizedPrState.Open,
          mergedAt: null,
          observedAt: 200,
        }),
        makePr({
          state: NormalizedPrState.Draft,
          mergedAt: null,
          observedAt: 200,
        }),
      ],
    });
    expect(prPopulations.reviewBacklogPrs(rows)).toHaveLength(1);
  });
});

describe("sessionPopulations", () => {
  it("sessions selects sessions started in window", () => {
    const rows = makeRows({
      prs: [],
      sessions: [
        makeSession({ startedAt: 100 }),
        makeSession({ startedAt: 5000 }),
      ],
      window: { start: 0, end: 1000 },
    });
    expect(sessionPopulations.sessions(rows)).toHaveLength(1);
  });
});

describe("branchPopulations", () => {
  it("sessionBranches excludes branches without a PR (false or unknown) and out-of-window branches", () => {
    const rows = makeRows({
      branches: [
        {
          status: NormalizedBranchStatus.Merged,
          additions: 1,
          deletions: 1,
          startedAt: 100,
          settledAt: 200,
          hasPr: true,
        },
        {
          status: NormalizedBranchStatus.Merged,
          additions: 1,
          deletions: 1,
          startedAt: 100,
          settledAt: 200,
          hasPr: false,
        },
        {
          // hasPr unknown (field omitted) — must NOT count toward the PR-only cohort.
          status: NormalizedBranchStatus.Merged,
          additions: 1,
          deletions: 1,
          startedAt: 100,
          settledAt: 200,
        },
        {
          status: NormalizedBranchStatus.Active,
          additions: 1,
          deletions: 1,
          startedAt: 9999,
          settledAt: null,
          hasPr: true,
        },
      ],
      window: { start: 0, end: 1000 },
    });
    expect(branchPopulations.sessionBranches(rows)).toHaveLength(1);
  });
});
