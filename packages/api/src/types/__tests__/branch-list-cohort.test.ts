import { describe, expect, it } from "vitest";
import {
  BranchLastActiveClassification,
  BranchListCohortScope,
  branchLastActiveCohortSchema,
  branchListCohortKey,
  classifyBranchLastActive,
  completeBranchLastActiveCohort,
} from "../branch-list-cohort";
import {
  BranchListPageMode,
  BranchListSortDirection,
  BranchListSortKey,
} from "../branch-list-contract";
import { BranchMetricAvailability } from "../branch-metrics";

const NOW = new Date("2026-08-18T12:00:00.000Z");
const START = new Date("2026-08-11T12:00:00.000Z");

describe("Branch list cohort contract", () => {
  it("normalizes set-like filters and omits pagination inputs", () => {
    expect(
      branchListCohortKey({
        offset: 100,
        repo: ["b/repo", "a/repo"],
        limit: 20,
        pageMode: BranchListPageMode.Server,
        sortDir: BranchListSortDirection.Asc,
        sortKey: BranchListSortKey.Name,
        evaluationNow: NOW,
        startDate: START,
      })
    ).toBe(
      JSON.stringify({
        repo: ["a/repo", "b/repo"],
        startDate: START.toISOString(),
      })
    );
  });

  // The producer builds this key in Node and the consumer rebuilds it in a
  // browser, then `resolveBranchCohortNotice` compares the two. A locale-aware
  // sort makes those two runtimes disagree on the same filter set — `sv-SE`
  // orders "ä" after "z" where "en-US" orders it before — so the key would name
  // a different request and the cohort's counts would be dropped.
  it("orders repeated filter values the same under any host locale", () => {
    const values = ["z-repo", "ä-repo", "a-repo", "Z-repo"];
    const key = branchListCohortKey({ repositories: values });

    expect(key).toBe(
      JSON.stringify({ repositories: ["Z-repo", "a-repo", "z-repo", "ä-repo"] })
    );
    // Same corpus, opposite input order: normalization is what makes the key
    // comparable, so it must not carry the caller's ordering through.
    expect(branchListCohortKey({ repositories: [...values].reverse() })).toBe(
      key
    );
  });

  // ISS-7125: the Desktop IPC boundary parses through
  // `branchServerPageQuerySchema`, whose `z.string().trim()` is a TRANSFORM, so
  // main keys a trimmed facet value while the renderer keys whatever the URL
  // carried — a bookmarked `#/branches?tag=release+` decodes to `"release "`.
  // Folding whitespace here is what keeps the two keys equal by construction;
  // without it the equality gate drops the producer's counts and the notice
  // silently reverts to the page-scoped undercount, permanently and desktop-only.
  it("keys a padded facet value identically to its trimmed value", () => {
    expect(branchListCohortKey({ tags: ["release ", " hotfix"] })).toBe(
      branchListCohortKey({ tags: ["release", "hotfix"] })
    );
    expect(branchListCohortKey({ search: "  needle  " })).toBe(
      branchListCohortKey({ search: "needle" })
    );
  });

  it("normalizes scalar repeated filters to the server query shape", () => {
    expect(
      branchListCohortKey({
        projectId: "project-1",
        repo: "acme/web",
        status: "open",
      })
    ).toBe(
      branchListCohortKey({
        projectId: ["project-1"],
        repo: ["acme/web"],
        status: ["open"],
      })
    );
  });

  it("builds complete counts that reconcile exactly", () => {
    expect(
      completeBranchLastActiveCohort({
        scope: BranchListCohortScope.RequestFilters,
        cohortKey: "{}",
        evaluationNow: NOW,
        total: 21,
        retainedUnavailable: 2,
      })
    ).toMatchObject({
      knownInWindow: { state: BranchMetricAvailability.Complete, value: 19 },
      retainedUnavailable: {
        state: BranchMetricAvailability.Complete,
        value: 2,
      },
      total: 21,
    });
  });

  it.each([
    [
      {
        canonical: {
          state: BranchMetricAvailability.Complete,
          value: "2026-08-18T10:00:00.000Z",
        },
      },
      BranchLastActiveClassification.KnownInWindow,
    ],
    [
      {
        canonical: {
          state: BranchMetricAvailability.Partial,
          value: "2026-08-18T10:00:00.000Z",
        },
      },
      BranchLastActiveClassification.KnownInWindow,
    ],
    [
      {
        canonical: {
          state: BranchMetricAvailability.Complete,
          value: "2026-08-01T10:00:00.000Z",
        },
      },
      BranchLastActiveClassification.KnownOutOfWindow,
    ],
    [
      {
        canonical: { state: BranchMetricAvailability.Unavailable, value: null },
      },
      BranchLastActiveClassification.RetainedUnavailable,
    ],
    [
      {
        canonical: {
          state: BranchMetricAvailability.Complete,
          value: "2026-08-19T10:00:00.000Z",
        },
        legacy: "2026-08-18T10:00:00.000Z",
      },
      BranchLastActiveClassification.RetainedUnavailable,
    ],
    [
      { legacy: "2026-08-18T10:00:00.000Z" },
      BranchLastActiveClassification.KnownInWindow,
    ],
    [
      {
        canonical: { state: "future_state", value: "2026-08-18T10:00:00.000Z" },
      },
      BranchLastActiveClassification.RetainedUnavailable,
    ],
    [
      {
        canonical: {
          state: BranchMetricAvailability.Complete,
          value: "2026-08-18T10:00:00.000Z",
        },
        conflicting: true,
      },
      BranchLastActiveClassification.RetainedUnavailable,
    ],
  ])("classifies %o as %s", (evidence, expected) => {
    expect(
      classifyBranchLastActive(evidence, {
        evaluationNow: NOW,
        startDate: START,
        endDate: NOW,
      })
    ).toBe(expected);
  });

  it("keys a list holding two identical entries", () => {
    expect(branchListCohortKey({ names: ["dup-repo", "dup-repo"] })).toBe(
      JSON.stringify({ names: ["dup-repo", "dup-repo"] })
    );
  });

  it("throws when retainedUnavailable is negative", () => {
    expect(() =>
      completeBranchLastActiveCohort({
        scope: BranchListCohortScope.RequestFilters,
        cohortKey: "{}",
        evaluationNow: NOW,
        total: 21,
        retainedUnavailable: -1,
      })
    ).toThrow(RangeError);
  });

  it("throws when retainedUnavailable exceeds total", () => {
    expect(() =>
      completeBranchLastActiveCohort({
        scope: BranchListCohortScope.RequestFilters,
        cohortKey: "{}",
        evaluationNow: NOW,
        total: 5,
        retainedUnavailable: 6,
      })
    ).toThrow("retainedUnavailable must be an integer within total");
  });

  it("retains-unavailable when the window's own evaluationNow is unparseable", () => {
    expect(
      classifyBranchLastActive(
        { legacy: "2026-08-18T10:00:00.000Z" },
        { evaluationNow: "not-a-date", startDate: START, endDate: NOW }
      )
    ).toBe(BranchLastActiveClassification.RetainedUnavailable);
  });

  it("normalizes a nested-object repeated filter value and a scalar primitive", () => {
    expect(
      branchListCohortKey({
        lastActiveRanges: [{ from: "2026-01-01", to: "2026-02-01" }],
        locMin: 5,
      })
    ).toBe(
      JSON.stringify({
        lastActiveRanges: [{ from: "2026-01-01", to: "2026-02-01" }],
        locMin: 5,
      })
    );
  });

  it("classifies against a numeric evaluationNow window clock", () => {
    expect(
      classifyBranchLastActive(
        { legacy: "2026-08-18T10:00:00.000Z" },
        { evaluationNow: NOW.getTime(), startDate: START, endDate: NOW }
      )
    ).toBe(BranchLastActiveClassification.KnownInWindow);
  });

  it("rejects a complete envelope whose counts do not sum to total", () => {
    expect(
      branchLastActiveCohortSchema.safeParse({
        scope: BranchListCohortScope.RequestFilters,
        cohortKey: "{}",
        evaluationNow: NOW.toISOString(),
        knownInWindow: { state: BranchMetricAvailability.Complete, value: 19 },
        retainedUnavailable: {
          state: BranchMetricAvailability.Complete,
          value: 1,
        },
        total: 21,
      }).success
    ).toBe(false);
  });
});
