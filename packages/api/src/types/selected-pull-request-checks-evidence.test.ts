import { describe, expect, it } from "vitest";
import {
  SelectedPullRequestCheckCategory,
  SelectedPullRequestCheckSourceKind,
  SelectedPullRequestChecksCompleteness,
  type SelectedPullRequestChecksEvidence,
  type SelectedPullRequestChecksEvidenceResult,
  SelectedPullRequestChecksHistoryMode,
  SelectedPullRequestChecksPartialReason,
} from "./selected-pull-request-checks-evidence";
import {
  SelectedPullRequestEvidenceAvailability,
  SelectedPullRequestEvidenceUnavailableReason,
} from "./selected-pull-request-evidence";

describe("selected pull-request checks evidence contract", () => {
  it("represents complete mixed-source evidence with reconciling counts", () => {
    const evidence = makeEvidence();

    expect(evidence.counts.total).toBe(evidence.checks.length);
    expect(
      evidence.counts.successful +
        evidence.counts.failing +
        evidence.counts.pending +
        evidence.counts.neutral
    ).toBe(evidence.counts.total);
    expect(evidence.coverage).toEqual({
      completeness: SelectedPullRequestChecksCompleteness.Complete,
      reasons: [],
    });
  });

  it("keeps partial provenance and unavailable evidence distinct", () => {
    const partial = makeEvidence({
      coverage: {
        completeness: SelectedPullRequestChecksCompleteness.Partial,
        reasons: [SelectedPullRequestChecksPartialReason.CountMismatch],
      },
    });
    const unavailable = {
      status: SelectedPullRequestEvidenceAvailability.Unavailable,
      reason:
        SelectedPullRequestEvidenceUnavailableReason.SelectedRevisionMissingOrInaccessible,
    } satisfies SelectedPullRequestChecksEvidenceResult;

    expect(partial.coverage.completeness).toBe(
      SelectedPullRequestChecksCompleteness.Partial
    );
    expect(unavailable).not.toHaveProperty("value");
  });
});

function makeEvidence(
  overrides: Partial<SelectedPullRequestChecksEvidence> = {}
): SelectedPullRequestChecksEvidence {
  return {
    identity: {
      githubId: "123",
      repositoryFullName: "acme/widgets",
      number: 42,
      url: "https://github.com/acme/widgets/pull/42",
    },
    revision: { headSha: "a".repeat(40) },
    checks: [
      {
        providerId: "check-node-1",
        sourceIdentity: "check_run:app-node:test",
        sourceKind: SelectedPullRequestCheckSourceKind.CheckRun,
        sourceApp: {
          nodeId: "app-node",
          databaseId: 7,
          slug: "ci",
          name: "CI",
          url: "https://github.com/apps/ci",
        },
        name: "test",
        providerStatus: "COMPLETED",
        providerConclusion: "SUCCESS",
        category: SelectedPullRequestCheckCategory.Successful,
        createdAt: null,
        startedAt: "2026-08-04T20:00:00Z",
        completedAt: "2026-08-04T20:01:00Z",
        targetUrl: "https://github.com/acme/widgets/actions/runs/1",
      },
      {
        providerId: "status_context:deploy:2026-08-04T20:02:00Z:PENDING",
        sourceIdentity: "status_context:deploy",
        sourceKind: SelectedPullRequestCheckSourceKind.StatusContext,
        sourceApp: null,
        name: "deploy",
        providerStatus: "PENDING",
        providerConclusion: null,
        category: SelectedPullRequestCheckCategory.Pending,
        createdAt: "2026-08-04T20:02:00Z",
        startedAt: null,
        completedAt: null,
        targetUrl: null,
      },
    ],
    counts: {
      providerExpected: 2,
      providerReturned: 2,
      normalizedAttempts: 2,
      emitted: 2,
      total: 2,
      successful: 1,
      failing: 0,
      pending: 1,
      neutral: 0,
    },
    pagination: {
      pageSize: 100,
      pagesFetched: 1,
      acquisitionMaximum: 10_000,
      reachedAcquisitionMaximum: false,
    },
    history: {
      mode: SelectedPullRequestChecksHistoryMode.LatestPerSourceFromProviderRollup,
      providerLimit: null,
      rawAttempts: 2,
      emittedSources: 2,
    },
    coverage: {
      completeness: SelectedPullRequestChecksCompleteness.Complete,
      reasons: [],
    },
    ...overrides,
  };
}
