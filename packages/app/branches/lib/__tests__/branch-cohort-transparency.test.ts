import { BranchStatus } from "@repo/api/src/types/branch";
import {
  BranchListCohortScope,
  branchListCohortKey,
  completeBranchLastActiveCohort,
} from "@repo/api/src/types/branch-list-cohort";
import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
} from "@repo/api/src/types/branch-metrics";
import { describe, expect, it } from "vitest";
import {
  BranchCohortNoticeKind,
  resolveBranchCohortEvaluationNow,
  resolveBranchCohortNotice,
} from "../branch-cohort-transparency";
import { type BranchRow, BranchRowStatus } from "../branch-row";

const NOW = "2026-08-18T12:00:00.000Z";
/** The filter set the list is rendering, keyed exactly as both producers key it. */
const ACTIVE_FILTERS = {
  repositories: ["acme/web"],
  statuses: [BranchStatus.Open],
};
const ACTIVE_COHORT_KEY = branchListCohortKey(ACTIVE_FILTERS);

describe("resolveBranchCohortNotice", () => {
  it("does not claim a settled zero or unavailable cohort before data exists", () => {
    expect(
      resolveBranchCohortNotice({
        rows: [],
        total: 0,
        hasData: false,
        hasFiniteWindow: true,
        isPlaceholderData: false,
        placeholderFailed: false,
        completeCorpus: false,
        renderNow: NOW,
        cohortKey: ACTIVE_COHORT_KEY,
      }).kind
    ).toBe(BranchCohortNoticeKind.Hidden);
  });

  it("reconciles an exact fully loaded filtered cohort", () => {
    expect(
      resolveBranchCohortNotice({
        rows: [
          row({ lastActivityAt: "2026-08-18T10:00:00.000Z" }),
          row({ id: "unknown", lastActivityAt: undefined }),
        ],
        total: 2,
        hasData: true,
        hasFiniteWindow: true,
        isPlaceholderData: false,
        placeholderFailed: false,
        completeCorpus: true,
        renderNow: NOW,
        cohortKey: ACTIVE_COHORT_KEY,
      })
    ).toEqual({
      kind: BranchCohortNoticeKind.Complete,
      total: 2,
      knownInWindow: 1,
      retainedUnavailable: 1,
    });
  });

  it("shows no notice for a complete cohort with no retained rows", () => {
    expect(
      resolveBranchCohortNotice({
        rows: [row({ lastActivityAt: "2026-08-18T10:00:00.000Z" })],
        total: 1,
        hasData: true,
        hasFiniteWindow: true,
        isPlaceholderData: false,
        placeholderFailed: false,
        completeCorpus: true,
        renderNow: NOW,
        cohortKey: ACTIVE_COHORT_KEY,
      }).kind
    ).toBe(BranchCohortNoticeKind.Hidden);
  });

  it("distinguishes prior-key placeholder data from ordinary settled content", () => {
    expect(
      resolveBranchCohortNotice({
        rows: [],
        total: 21,
        hasData: true,
        hasFiniteWindow: true,
        isPlaceholderData: true,
        placeholderFailed: false,
        completeCorpus: true,
        renderNow: NOW,
        cohortKey: ACTIVE_COHORT_KEY,
      }).kind
    ).toBe(BranchCohortNoticeKind.Updating);
  });

  // ISS-7125: a bounded corpus is the case the producer cohort exists for — the
  // rendered page cannot see the other 20 rows, so a page-derived reading would
  // undercount. The cohort is built by the producers' own helper under the
  // producers' own scope const, so a scope rename on either side fails here.
  it("reports the producer's exact counts for a bounded page", () => {
    expect(
      resolveBranchCohortNotice({
        rows: [row({ lastActivityAt: "2026-08-18T10:00:00.000Z" })],
        total: 21,
        hasData: true,
        hasFiniteWindow: true,
        isPlaceholderData: false,
        placeholderFailed: false,
        completeCorpus: false,
        renderNow: NOW,
        cohortKey: ACTIVE_COHORT_KEY,
        producerCohort: producerCohort({ total: 21, retainedUnavailable: 3 }),
      })
    ).toEqual({
      kind: BranchCohortNoticeKind.Complete,
      total: 21,
      knownInWindow: 18,
      retainedUnavailable: 3,
    });
  });

  it("shows no notice when the producer retained nothing across the corpus", () => {
    expect(
      resolveBranchCohortNotice({
        rows: [row({ id: "unknown", lastActivityAt: undefined })],
        total: 21,
        hasData: true,
        hasFiniteWindow: true,
        isPlaceholderData: false,
        placeholderFailed: false,
        completeCorpus: false,
        renderNow: NOW,
        cohortKey: ACTIVE_COHORT_KEY,
        producerCohort: producerCohort({ total: 21, retainedUnavailable: 0 }),
      }).kind
    ).toBe(BranchCohortNoticeKind.Hidden);
  });

  it("fails closed when the producer counted a different population", () => {
    expect(
      resolveBranchCohortNotice({
        rows: [row({ lastActivityAt: "2026-08-18T10:00:00.000Z" })],
        // A cohort that counted a larger population than the list reports. No
        // caller produces this divergence today (`completeCorpus` short-circuits
        // the complete-list path, and the server page reports the producer's own
        // `total`), so this pins the reject-by-default floor directly.
        total: 4,
        hasData: true,
        hasFiniteWindow: true,
        isPlaceholderData: false,
        placeholderFailed: false,
        completeCorpus: false,
        renderNow: NOW,
        cohortKey: ACTIVE_COHORT_KEY,
        producerCohort: producerCohort({ total: 21, retainedUnavailable: 3 }),
      }).kind
    ).toBe(BranchCohortNoticeKind.Unavailable);
  });

  it("fails closed for a cohort scoped past the request's own filters", () => {
    expect(
      resolveBranchCohortNotice({
        rows: [row({ lastActivityAt: "2026-08-18T10:00:00.000Z" })],
        total: 21,
        hasData: true,
        hasFiniteWindow: true,
        isPlaceholderData: false,
        placeholderFailed: false,
        completeCorpus: false,
        renderNow: NOW,
        cohortKey: ACTIVE_COHORT_KEY,
        producerCohort: producerCohort({
          scope: BranchListCohortScope.AllActiveFacets,
          total: 21,
          retainedUnavailable: 3,
        }),
      }).kind
    ).toBe(BranchCohortNoticeKind.Unavailable);
  });

  // `scope` only says the producer counted the request's own filters — not that
  // it counted THIS request's. A response for a different filter set can carry
  // the same in-scope `total`, so `total` and `scope` together still admit
  // another population's counts; only the key rules it out.
  it("fails closed for an in-scope cohort answering a different filter set", () => {
    expect(
      resolveBranchCohortNotice({
        rows: [row({ lastActivityAt: "2026-08-18T10:00:00.000Z" })],
        total: 21,
        hasData: true,
        hasFiniteWindow: true,
        isPlaceholderData: false,
        placeholderFailed: false,
        completeCorpus: false,
        renderNow: NOW,
        cohortKey: ACTIVE_COHORT_KEY,
        producerCohort: producerCohort({
          cohortKey: branchListCohortKey({
            ...ACTIVE_FILTERS,
            statuses: [BranchStatus.Merged],
          }),
          total: 21,
          retainedUnavailable: 3,
        }),
      }).kind
    ).toBe(BranchCohortNoticeKind.Unavailable);
  });

  // The two keys are built from the same helper on both sides, so a filter that
  // only reorders — the shape a stale-response check must NOT reject — still
  // reads the producer's counts.
  it("reads a cohort whose key normalizes to the rendered filter set", () => {
    expect(
      resolveBranchCohortNotice({
        rows: [row({ lastActivityAt: "2026-08-18T10:00:00.000Z" })],
        total: 21,
        hasData: true,
        hasFiniteWindow: true,
        isPlaceholderData: false,
        placeholderFailed: false,
        completeCorpus: false,
        renderNow: NOW,
        cohortKey: ACTIVE_COHORT_KEY,
        producerCohort: producerCohort({
          cohortKey: branchListCohortKey({
            statuses: [BranchStatus.Open],
            repositories: ["acme/web"],
            limit: 25,
            offset: 50,
          }),
          total: 21,
          retainedUnavailable: 3,
        }),
      })
    ).toEqual({
      kind: BranchCohortNoticeKind.Complete,
      total: 21,
      knownInWindow: 18,
      retainedUnavailable: 3,
    });
  });

  // The wire schema admits partial and unavailable counts, so an in-scope,
  // size-matched cohort can still arrive without an exact breakdown. Reporting
  // a number then would invent one; the notice reports unavailable instead.
  // The visible row is deliberately RETAINED-UNAVAILABLE (its activity settles
  // after the evaluation clock), so the row-derived fallback would report
  // `Partial` here. That is what separates this case from the fallback:
  // replacing the inexact-counts arm with `return null` reads as Partial and
  // reds, instead of coinciding with the same `Unavailable` a clean row gives.
  it("declines to report a producer cohort whose counts are not exact", () => {
    expect(
      resolveBranchCohortNotice({
        rows: [row({ lastActivityAt: "2026-08-18T18:00:00.000Z" })],
        total: 21,
        hasData: true,
        hasFiniteWindow: true,
        isPlaceholderData: false,
        placeholderFailed: false,
        completeCorpus: false,
        renderNow: NOW,
        cohortKey: ACTIVE_COHORT_KEY,
        producerCohort: {
          ...producerCohort({ total: 21, retainedUnavailable: 3 }),
          knownInWindow: {
            state: BranchMetricAvailability.Partial,
            value: 18,
            disclosure: BranchMetricDisclosure.DefaultIncomplete,
          },
        },
      })
    ).toEqual({ kind: BranchCohortNoticeKind.Unavailable, total: 21 });
  });

  it("fails closed for a bounded page carrying no producer cohort", () => {
    expect(
      resolveBranchCohortNotice({
        rows: [row({ lastActivityAt: "2026-08-18T10:00:00.000Z" })],
        total: 21,
        hasData: true,
        hasFiniteWindow: true,
        isPlaceholderData: false,
        placeholderFailed: false,
        completeCorpus: false,
        renderNow: NOW,
        cohortKey: ACTIVE_COHORT_KEY,
      }).kind
    ).toBe(BranchCohortNoticeKind.Unavailable);
  });
});

/** Build the wire cohort exactly as both producers do, via their own helper. */
function producerCohort(input: {
  scope?: BranchListCohortScope;
  cohortKey?: string;
  total: number;
  retainedUnavailable: number;
}) {
  return completeBranchLastActiveCohort({
    scope: input.scope ?? BranchListCohortScope.RequestFilters,
    cohortKey: input.cohortKey ?? ACTIVE_COHORT_KEY,
    evaluationNow: new Date(NOW),
    total: input.total,
    retainedUnavailable: input.retainedUnavailable,
  });
}

function row(over: Partial<BranchRow>): BranchRow {
  return {
    id: over.id ?? "id",
    branchName: "agent/x",
    baseBranch: "main",
    repo: "acme/web",
    owner: "Alex",
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
    lastActivityLabel: "1h ago",
    ...over,
  };
}

describe("resolveBranchCohortEvaluationNow", () => {
  const cohortNow = "2026-08-18T12:00:00.000Z";
  const envelopeNow = "2026-08-18T11:00:00.000Z";
  const localNow = Date.parse("2020-01-01T00:00:00.000Z");

  it("prefers the cohort's own evaluation instant", () => {
    expect(
      resolveBranchCohortEvaluationNow(cohortNow, envelopeNow, localNow)
    ).toBe(Date.parse(cohortNow));
  });

  it("falls back to the envelope instant the same producer stamped", () => {
    expect(
      resolveBranchCohortEvaluationNow(undefined, envelopeNow, localNow)
    ).toBe(Date.parse(envelopeNow));
  });

  it("reaches the local clock only when the producer stated neither", () => {
    expect(
      resolveBranchCohortEvaluationNow(undefined, undefined, localNow)
    ).toBe(localNow);
  });

  it("does not let an unparseable producer instant win over a usable one", () => {
    expect(
      resolveBranchCohortEvaluationNow("not-a-timestamp", envelopeNow, localNow)
    ).toBe(Date.parse(envelopeNow));
  });
});
