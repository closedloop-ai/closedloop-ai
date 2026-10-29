import type { BranchPageDetail } from "@repo/api/src/types/branch";
import {
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";
import {
  BranchAssociatedPullRequestCompletenessState,
  BranchAssociatedPullRequestProvenance,
  BranchAssociatedPullRequestSelectionReason,
} from "@repo/api/src/types/branch-associated-pull-request";
import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
} from "@repo/api/src/types/branch-metrics";
import {
  BranchPhaseAttributionCompleteness,
  BranchVisibleLifecyclePhase,
} from "@repo/api/src/types/branch-phase-attribution";
import { GitHubPRState } from "@repo/api/src/types/github";
import { exactCohortMetricParityExpectation } from "@repo/lib/branches/__tests__/exact-cohort-metric-parity-fixture";
import { describe, expect, it } from "vitest";
import {
  cloudRow,
  costFactsFor,
  metricParitySubset,
  orgMergedAdmissionForPullRequests,
  orgMergedAdmissionForRows,
  pullRequestFactsFor,
  withCapturedPush,
} from "@/__tests__/support/branches/branch-canonical-metric-projection.test-helpers";
import {
  attachCanonicalDetailMetrics,
  projectCloudCanonicalLastActive,
  projectCloudCanonicalMetrics,
} from "./branch-canonical-metric-projection";
import { cloudPublicationLocEvidence } from "./branch-publication-loc-projection";

const SIZED_MERGED_PR = {
  merged: 1,
  sized: 1,
  medianSize: 12,
  closedUnmerged: 0,
  decidedIdentities: 1,
};

describe("cloud canonical Branch metric projection", () => {
  it("takes the non-date cohort and reads Median PR size from the producer facts", () => {
    const rows = [
      cloudRow("merged", "2026-08-01T00:00:00.000Z", 1),
      {
        ...cloudRow("current", "2026-08-02T00:00:00.000Z", 2),
        pullRequestDetails: [],
      },
    ];
    const query = {
      startDate: new Date("2026-07-27T00:00:00.000Z"),
      endDate: new Date("2026-08-03T00:00:00.000Z"),
    };
    const now = new Date("2026-08-03T00:00:00.000Z");
    const metrics = projectCloudCanonicalMetrics(
      rows,
      query,
      now,
      orgMergedAdmissionForRows(...rows),
      undefined,
      pullRequestFactsFor(query, now, SIZED_MERGED_PR)
    );

    expect(metrics.cohortSize).toBe(2);
    expect(metrics.activeBranches.current.value).toBe(1);
    expect(metrics.medianPrSize.current.value).toBe(12);
    expect(metrics.aiSpendUsd.current.state).toBe(
      BranchMetricAvailability.Unavailable
    );
  });

  it("does not let a foreign default PR classify the Branch metric status", () => {
    const row = cloudRow("foreign", "2026-08-01T00:00:00.000Z", 1);
    const pullRequest = row.pullRequestDetails[0];
    if (!pullRequest) {
      throw new Error("Expected a pull request fixture");
    }
    pullRequest.repositoryId = "foreign-repository";
    pullRequest.repositoryFullName = "other/repository";
    pullRequest.repository = { fullName: "other/repository" };

    const metrics = projectCloudCanonicalMetrics(
      [row],
      {},
      new Date("2026-08-03T00:00:00.000Z"),
      orgMergedAdmissionForRows(row)
    );

    expect(metrics.activeBranches.current.value).toBe(1);
  });

  it("ignores a polluted compatibility aggregate and later PR projection", () => {
    const row = cloudRow("canonical", "2026-08-01T00:00:00.000Z", 1);
    Object.assign(row.branch, {
      lastActivityAt: new Date("2099-01-01T00:00:00.000Z"),
    });
    const pullRequest = row.pullRequestDetails[0];
    if (!pullRequest) {
      throw new Error("Expected a pull request fixture");
    }
    pullRequest.mergedAt = new Date("2026-08-02T00:00:00.000Z");

    expect(projectCloudCanonicalLastActive(row)).toMatchObject({
      state: BranchMetricAvailability.Partial,
      value: "2026-08-01T00:00:00.000Z",
    });
    expect(
      projectCloudCanonicalMetrics(
        [row],
        {},
        new Date("2026-08-03T00:00:00.000Z"),
        orgMergedAdmissionForRows(row)
      ).lastActiveAt
    ).toMatchObject({
      state: BranchMetricAvailability.Partial,
      value: "2026-08-01T00:00:00.000Z",
    });
  });

  it("reports Last active unavailable when no immutable atom exists", () => {
    const row = cloudRow("unavailable", "2026-08-01T00:00:00.000Z", 1);
    row.branch.activityAtoms = [];
    Object.assign(row.branch, {
      lastActivityAt: new Date("2099-01-01T00:00:00.000Z"),
    });

    expect(projectCloudCanonicalLastActive(row)).toEqual({
      state: BranchMetricAvailability.Unavailable,
      value: null,
    });
    expect(
      projectCloudCanonicalMetrics(
        [row],
        {},
        new Date("2026-08-03T00:00:00.000Z"),
        orgMergedAdmissionForRows(row)
      ).lastActiveAt
    ).toEqual({
      state: BranchMetricAvailability.Unavailable,
      value: null,
    });
  });

  it("skips malformed newer atoms and retains an older eligible atom", () => {
    const row = cloudRow("eligible", "2026-08-01T00:00:00.000Z", 1);
    row.branch.activityAtoms = [
      {
        version: BranchActivityAtomVersion.V1 + 1,
        source: "future_source",
        sourceEventId: "future-event",
        occurredAt: new Date("2099-01-01T00:00:00.000Z"),
        attributionKind: BranchActivityAttributionKind.Branch,
        pullRequestDetailId: null,
        completeness: BranchActivityEvidenceCompleteness.Complete,
      },
      ...row.branch.activityAtoms,
    ];

    expect(projectCloudCanonicalLastActive(row)).toMatchObject({
      state: BranchMetricAvailability.Partial,
      value: "2026-08-01T00:00:00.000Z",
    });
  });

  it.each([
    {
      label: "unknown source",
      override: { source: "future_source" },
    },
    {
      label: "empty event identity",
      override: { sourceEventId: "" },
    },
    {
      label: "invalid completeness",
      override: {
        completeness: BranchActivityEvidenceCompleteness.Unavailable,
      },
    },
    {
      label: "invalid attribution",
      override: { attributionKind: "future_attribution" },
    },
    {
      label: "branch attribution carrying a PR id",
      override: { pullRequestDetailId: "foreign-pr" },
    },
  ])("skips a newer atom with $label", ({ override }) => {
    const row = cloudRow("validation", "2026-08-01T00:00:00.000Z", 1);
    const eligible = row.branch.activityAtoms[0];
    if (!eligible) {
      throw new Error("Expected an eligible activity fixture");
    }
    row.branch.activityAtoms = [
      {
        ...eligible,
        sourceEventId: "newer-event",
        occurredAt: new Date("2099-01-01T00:00:00.000Z"),
        ...override,
      },
      eligible,
    ];

    expect(projectCloudCanonicalLastActive(row)).toMatchObject({
      state: BranchMetricAvailability.Partial,
      value: "2026-08-01T00:00:00.000Z",
    });
  });

  it("rejects PR attribution that does not belong to the same Branch", () => {
    const row = cloudRow("attribution", "2026-08-01T00:00:00.000Z", 1);
    row.branch.activityAtoms = [
      {
        version: BranchActivityAtomVersion.V1,
        source: BranchActivitySource.PullRequestLifecycle,
        sourceEventId: "foreign-pr-event",
        occurredAt: new Date("2099-01-01T00:00:00.000Z"),
        attributionKind: BranchActivityAttributionKind.PullRequest,
        pullRequestDetailId: "foreign-pr",
        completeness: BranchActivityEvidenceCompleteness.Complete,
      },
      ...row.branch.activityAtoms,
    ];

    expect(projectCloudCanonicalLastActive(row)).toMatchObject({
      state: BranchMetricAvailability.Partial,
      value: "2026-08-01T00:00:00.000Z",
    });
  });

  it("matches the exact-cohort cross-surface metric fixture", () => {
    const row = withCapturedPush(
      cloudRow("shared", "2026-08-01T00:00:00.000Z", 1),
      { additions: 100, deletions: 0 }
    );
    const query = {
      startDate: new Date("2026-07-27T00:00:00.000Z"),
      endDate: new Date("2026-08-03T00:00:00.000Z"),
    };
    const now = new Date("2026-08-03T00:00:00.000Z");
    const metrics = projectCloudCanonicalMetrics(
      [row],
      query,
      now,
      orgMergedAdmissionForRows(row),
      undefined,
      pullRequestFactsFor(query, now, SIZED_MERGED_PR),
      costFactsFor(query, now, { spendUsd: 10, included: 1, unusable: 0 })
    );

    expect(metricParitySubset(metrics)).toEqual(
      exactCohortMetricParityExpectation
    );
  });

  it("divides captured push LOC by the spend facts for an all-time cohort", () => {
    const row = withCapturedPush(
      cloudRow("lifetime", "2026-08-01T00:00:00.000Z", 1),
      { additions: 12, deletions: 0 }
    );
    const now = new Date("2026-08-03T00:00:00.000Z");

    const metrics = projectCloudCanonicalMetrics(
      [row],
      {},
      now,
      orgMergedAdmissionForRows(row),
      undefined,
      undefined,
      costFactsFor({}, now, { spendUsd: 10, included: 1, unusable: 0 })
    );

    expect(metrics.locPerDollar.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 1.2,
    });
    expect(metrics.canonicalLocPerDollar?.current).toEqual(
      metrics.locPerDollar.current
    );
  });

  // Ruling (ISS-12346, Cosimo Corrigan): merged PRs supply merged LOC only. A
  // branch whose lines no push observed has no LOC per $ to publish.
  it("leaves LOC per $ unavailable for a branch with a merged PR and no captured push", () => {
    const row = cloudRow("merged-only", "2026-08-01T00:00:00.000Z", 1);
    const now = new Date("2026-08-03T00:00:00.000Z");

    const metrics = projectCloudCanonicalMetrics(
      [row],
      {},
      now,
      orgMergedAdmissionForRows(row),
      undefined,
      undefined,
      costFactsFor({}, now, { spendUsd: 10, included: 1, unusable: 0 })
    );

    expect(metrics.locPerDollar.current.state).toBe(
      BranchMetricAvailability.Unavailable
    );
  });

  it("uses only admitted org merged PRs for Branch LOC evidence", () => {
    const row = cloudRow("reused", "2026-08-01T00:00:00.000Z", 1);
    const admitted = row.pullRequestDetails[0];
    if (!admitted) {
      throw new Error("Expected an admitted pull request fixture");
    }
    const unadmitted = {
      ...admitted,
      id: "unadmitted-pr",
      number: 2,
      additions: 80,
      deletions: 20,
      headRefOid: "b".repeat(40),
    };
    row.pullRequestDetails = [admitted, unadmitted];
    const admissionByBranchId = orgMergedAdmissionForPullRequests(row, [
      admitted,
    ]);

    const evidence = cloudPublicationLocEvidence([row], admissionByBranchId);

    expect(evidence.contributions).toContainEqual(
      expect.objectContaining({ sourceEventId: "merged-pr:pr-reused" })
    );
    expect(evidence.contributions).not.toContainEqual(
      expect.objectContaining({ sourceEventId: "merged-pr:unadmitted-pr" })
    );
    expect(evidence.coverageGaps).not.toContainEqual({
      sourceEventId: "merged-pr:unadmitted-pr",
      occurredAt: "2026-08-01T00:00:00.000Z",
    });
  });

  it("retains an old incomplete publication as a timed coverage gap", () => {
    const row = cloudRow("old-gap", "2026-08-01T00:00:00.000Z", 1);
    row.pullRequestDetails = [
      ...row.pullRequestDetails,
      {
        ...row.pullRequestDetails[0]!,
        id: "old-incomplete-pr",
        number: 2,
        headRefOid: "b".repeat(40),
        mergedAt: new Date("2026-06-01T00:00:00.000Z"),
        additions: null,
        deletions: null,
      },
    ];

    const evidence = cloudPublicationLocEvidence(
      [row],
      orgMergedAdmissionForRows(row)
    );

    expect(evidence.coverageGaps).toContainEqual({
      sourceEventId: "merged-pr:old-incomplete-pr",
      occurredAt: "2026-06-01T00:00:00.000Z",
    });
  });

  // ISS-10009 part 2 (operator ruling 2) retired the contract the three tests
  // that stood here covered: the current-head FILE CACHE is no longer read as a
  // push observation at all, so its truncation and provider-cap guards have no
  // publication-LOC arm left to fail closed. The cache's own capped/stale
  // behavior is still pinned on the DISPLAY LOC path by `branch-loc.test.ts`
  // and `branch-read-service.capped-loc.test.ts`; push evidence is now pinned by
  // `branch-push-loc-projection.test.ts`.

  // The production wiring: deleting the `costFacts` argument from the
  // `projectCanonicalBranchListMetrics` call reddens this and nothing else.
  it("publishes the producer's spend facts as AI spend", () => {
    const row = cloudRow("spend", "2026-08-01T00:00:00.000Z", 1);
    const query = {
      startDate: new Date("2026-07-27T00:00:00.000Z"),
      endDate: new Date("2026-08-03T00:00:00.000Z"),
    };
    const now = new Date("2026-08-03T00:00:00.000Z");

    const metrics = projectCloudCanonicalMetrics(
      [row],
      query,
      now,
      orgMergedAdmissionForRows(row),
      undefined,
      undefined,
      costFactsFor(query, now, { spendUsd: 7.5, included: 3, unusable: 1 })
    );

    expect(metrics.aiSpendUsd.current).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 7.5,
      disclosure: BranchMetricDisclosure.CostIncomplete,
    });
  });

  it("retains the compatibility selected-PR fallback without lifetime evidence", () => {
    const detail: Pick<
      BranchPageDetail,
      | "associatedPullRequests"
      | "canonicalMetrics"
      | "estimatedCostUsd"
      | "attributedCostUsd"
    > & { additions: number; deletions: number } = {
      additions: 1000,
      deletions: 1000,
      estimatedCostUsd: 20,
      attributedCostUsd: 20,
      associatedPullRequests: {
        items: [
          {
            id: "org/repo#1",
            repositoryFullName: "org/repo",
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
        selectedId: "org/repo#1",
        selectionReason:
          BranchAssociatedPullRequestSelectionReason.MostRecentTerminal,
        completeness: {
          state: BranchAssociatedPullRequestCompletenessState.Complete,
          reasons: [],
          provenance: BranchAssociatedPullRequestProvenance.PersistedCloud,
        },
      },
    };

    attachCanonicalDetailMetrics(
      detail,
      {
        segments: [],
        rollups: [
          {
            phase: BranchVisibleLifecyclePhase.Build,
            estimatedCostUsd: 20,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            durationMs: 0,
            sessionCount: 1,
          },
        ],
        coverage: {
          completeness: BranchPhaseAttributionCompleteness.Complete,
          subtotalUsd: 20,
        },
      },
      { additions: 50, deletions: 50 }
    );

    expect(detail.canonicalMetrics?.locPerDollar.value).toBe(5);
  });

  it("ISS-6949: feeds the detail's attributed cost into the metric bundle", () => {
    // The card total must be the branch's canonical attributed cost, not the
    // phase-rollup residue. Deleting the `attributedCostUsd` argument in
    // `attachCanonicalDetailMetrics` reddens this.
    const detail: Pick<
      BranchPageDetail,
      | "associatedPullRequests"
      | "canonicalMetrics"
      | "estimatedCostUsd"
      | "attributedCostUsd"
    > = {
      // Replicated over-count, deliberately different from the attributed share.
      estimatedCostUsd: 48,
      attributedCostUsd: 24,
      associatedPullRequests: undefined,
    };

    attachCanonicalDetailMetrics(
      detail,
      {
        segments: [],
        rollups: [
          {
            phase: BranchVisibleLifecyclePhase.Build,
            estimatedCostUsd: 8,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            durationMs: 0,
            sessionCount: 1,
          },
        ],
        coverage: {
          completeness: BranchPhaseAttributionCompleteness.Complete,
          subtotalUsd: 8,
        },
      },
      null
    );

    expect(detail.canonicalMetrics?.totalCostUsd.value).toBe(24);
    expect(detail.canonicalMetrics?.totalCostUsd.value).not.toBe(8);
    expect(detail.canonicalMetrics?.totalCostUsd.value).not.toBe(48);
  });

  it("ISS-9814: threads the Pensero numerator into the bundle over the same cost", () => {
    // The route→service→projection hop. Dropping the `penseroPoints` argument
    // here leaves every unit test of the fold and the kernel green while the
    // feature silently renders LOC/$ for everyone.
    const detail = penseroDetail();

    attachCanonicalDetailMetrics(
      detail,
      penseroPhaseAttribution(),
      null,
      null,
      undefined,
      undefined,
      {
        points: 40,
        hasFailedAcquisitionDay: false,
        hasAmbiguousPoints: false,
        hasUnreadablePointValues: false,
      }
    );

    // 40 points over the SAME $20 the LOC ratio would divide by.
    expect(detail.canonicalMetrics?.penseroPointsPerDollar?.value).toBe(2);
    expect(detail.canonicalMetrics?.totalCostUsd.value).toBe(20);
  });

  it("ISS-9814: omits the Pensero field entirely when no numerator was read", () => {
    const detail = penseroDetail();

    attachCanonicalDetailMetrics(detail, penseroPhaseAttribution(), null);

    expect(
      Object.hasOwn(detail.canonicalMetrics ?? {}, "penseroPointsPerDollar")
    ).toBe(false);
  });

  it("stars the facts-fold metrics when one branch withholds a decided PR (ISS-9959)", () => {
    const whole = cloudRow("whole", "2026-08-01T00:00:00.000Z", 1);
    const withholding = cloudRow("withholding", "2026-08-01T00:00:00.000Z", 2);
    const hidden = withholding.pullRequestDetails[0];
    if (!hidden) {
      throw new Error("Expected a pull request fixture");
    }
    // A merged pull request whose terminal instant was never read:
    // `MissingTerminalTimestamp`, which hides the merge from any decision fold.
    hidden.mergedAt = null;
    hidden.closedAt = null;
    const rows = [whole, withholding];
    const now = new Date("2026-08-03T00:00:00.000Z");
    const facts = pullRequestFactsFor({}, now, {
      merged: 2,
      sized: 2,
      medianSize: 12,
      closedUnmerged: 0,
      decidedIdentities: 2,
    });

    const starred = projectCloudCanonicalMetrics(
      rows,
      {},
      now,
      orgMergedAdmissionForRows(...rows),
      undefined,
      facts
    );
    const clean = projectCloudCanonicalMetrics(
      [whole],
      {},
      now,
      orgMergedAdmissionForRows(whole),
      undefined,
      facts
    );

    expect(clean.medianPrSize.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 12,
    });
    expect(starred.medianPrSize.current).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 12,
      disclosure: BranchMetricDisclosure.PrCoverageIncomplete,
    });
    expect(starred.mergeRatePct.current).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 100,
      disclosure: BranchMetricDisclosure.PrCoverageIncomplete,
    });
  });

  it("degrades only the fact-backed cards when the facts read had no answer", () => {
    const row = withCapturedPush(
      {
        ...cloudRow("degraded", "2026-08-01T00:00:00.000Z", 1),
        pullRequestDetails: [],
      },
      { additions: 100, deletions: 0 }
    );
    const now = new Date("2026-08-03T00:00:00.000Z");

    // H2: the shape `settle` hands the projection when the facts read failed.
    const metrics = projectCloudCanonicalMetrics(
      [row],
      {},
      now,
      orgMergedAdmissionForRows(row),
      undefined,
      undefined,
      undefined
    );

    expect(metrics.activeBranches.current.value).toBe(1);
    expect(metrics.lastActiveAt.value).toBe("2026-08-01T00:00:00.000Z");
    expect(metrics.totalLocPushed?.current.value).toBe(100);
    for (const metric of [
      metrics.medianPrSize,
      metrics.mergeRatePct,
      metrics.aiSpendUsd,
      metrics.locPerDollar,
    ]) {
      expect(metric.current.state).toBe(BranchMetricAvailability.Unavailable);
    }
  });

  it("keeps a deleted Branch out of Active but inside every other metric (ISS-12309)", () => {
    const row = cloudRow("deleted-draft", "2026-08-01T00:00:00.000Z", 1);
    const pullRequest = row.pullRequestDetails[0];
    if (!pullRequest) {
      throw new Error("Expected a pull request fixture");
    }
    // A delete-only event: the artifact closes, the PR keeps `isDraft`, and
    // `toBranchStatus` ranks draft above closed — so the status says Draft.
    row.status = GitHubPRState.Closed;
    pullRequest.isDraft = true;
    pullRequest.prState = GitHubPRState.Open;
    pullRequest.mergedAt = null;
    pullRequest.closedAt = null;
    const live = { ...row, branch: { ...row.branch, deletedAt: null } };
    const deleted = {
      ...row,
      branch: {
        ...row.branch,
        deletedAt: new Date("2026-08-02T00:00:00.000Z"),
      },
    };
    const now = new Date("2026-08-03T00:00:00.000Z");
    const project = (candidate: typeof row) =>
      projectCloudCanonicalMetrics(
        [candidate],
        {},
        now,
        orgMergedAdmissionForRows(candidate)
      );

    expect(project(live).activeBranches.current.value).toBe(1);
    const metrics = project(deleted);
    expect(metrics.activeBranches.current.value).toBe(0);
    // Still in the cohort, and still carrying its own Last active.
    expect(metrics.cohortSize).toBe(1);
    expect(metrics.lastActiveAt.value).toBe("2026-08-01T00:00:00.000Z");
  });
});

/** A branch whose whole $20 lifetime cost is attributed. */
function penseroDetail(): Pick<
  BranchPageDetail,
  | "associatedPullRequests"
  | "canonicalMetrics"
  | "estimatedCostUsd"
  | "attributedCostUsd"
> {
  return {
    estimatedCostUsd: 20,
    attributedCostUsd: 20,
    associatedPullRequests: undefined,
  };
}

/** One complete Build phase worth that $20. */
function penseroPhaseAttribution() {
  return {
    segments: [],
    rollups: [
      {
        phase: BranchVisibleLifecyclePhase.Build,
        estimatedCostUsd: 20,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        durationMs: 0,
        sessionCount: 1,
      },
    ],
    coverage: {
      completeness: BranchPhaseAttributionCompleteness.Complete,
      subtotalUsd: 20,
    },
  };
}
