import {
  BranchStatus,
  type BranchRow as WireBranchRow,
} from "@repo/api/src/types/branch";

/**
 * Shared fixtures for the `approved-*` branch-metrics suites
 * (`approved-branch-list-contract`, `approved-filtered-metrics`,
 * `approved-filtered-metrics-cost-companion`). All three drive the same wire
 * row and the same all-unavailable KPI bundle, so keeping one copy stops a new
 * field on `BranchRow` from landing in two of the three and leaving the third
 * quietly asserting the old shape.
 */

export function unavailableKpi() {
  return {
    value: null,
    state: "unavailable" as const,
    baseline30d: null,
    deltaPct: null,
  };
}

export function wireRow(overrides: Partial<WireBranchRow> = {}): WireBranchRow {
  return {
    id: "branch-1",
    branchName: "feature/one",
    baseBranch: "main",
    repoFullName: "closedloop-ai/closedloop-ai",
    owner: "Daveth Oakhurst",
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
    additions: 10,
    deletions: 5,
    filesChanged: 1,
    estimatedCostUsd: 3.5,
    lastActivityAt: "2026-08-05T12:00:00.000Z",
    sessionIds: ["session1"],
    ...overrides,
  };
}
