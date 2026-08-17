import { buildCanonicalCostEvidence } from "../branch-cost-fixtures";
import {
  type BranchRow,
  BranchStatus,
  type BranchStatus as BranchStatusValue,
  branchRows,
  DateRange,
  Provenance,
  PrState,
} from "../mock";
import type { BranchMetricEvidence } from "./branch-list-metric-types";

export const BRANCH_METRIC_FIXTURE_NOW = new Date("2026-07-29T00:00:00.000Z");

const METRIC_ANCHORS = [
  "2026-07-27T12:00:00.000Z",
  "2026-07-19T12:00:00.000Z",
  "2026-07-09T12:00:00.000Z",
  "2026-06-09T12:00:00.000Z",
  "2026-05-09T12:00:00.000Z",
  "2026-03-09T12:00:00.000Z",
] as const;

/** Deterministic producer-named evidence for the handed-off Branches prototype. */
export const branchMetricEvidence = buildMetricEvidence(branchRows);

const reviewRows = [...branchRows, ...buildGeneratedBranchFixture(38).rows].map(
  (row) => withRelativeActivityLabel(row, BRANCH_METRIC_FIXTURE_NOW)
);

/** Multi-page runtime cohort used for visual review without replacing the authored rows. */
export const branchPrototypeReviewFixture = {
  rows: reviewRows,
  evidence: buildMetricEvidence(reviewRows),
};

/** Builds uncapped 100/101 fixtures through the same row and evidence factories. */
export function buildGeneratedBranchFixture(count: number): {
  rows: BranchRow[];
  evidence: BranchMetricEvidence;
} {
  const rows = Array.from({ length: count }, (_, index) =>
    createGeneratedBranchRow(index)
  );
  return { rows, evidence: buildMetricEvidence(rows) };
}

function buildMetricEvidence(rows: readonly BranchRow[]): BranchMetricEvidence {
  const costEvidence = buildCanonicalCostEvidence(rows);
  return {
    statusSnapshots: rows.map((row, index) => ({
      branchId: row.id,
      currentActive: branchActiveState(row.status),
      priorActiveByRange: {
        [DateRange.SevenDays]: index % 4 !== 0,
        [DateRange.ThirtyDays]: index % 5 !== 0,
        [DateRange.NinetyDays]: index % 6 !== 0,
      },
    })),
    locContributions: rows.flatMap((row, index) => {
      if (!hasKnownChanges(row)) {
        return [];
      }
      return METRIC_ANCHORS.map((occurredAt, anchorIndex) => ({
        sourceEventId: `github-push:${row.id}:${anchorIndex}`,
        branchId: row.id,
        occurredAt,
        additions: row.additions + index + anchorIndex,
        deletions: row.deletions,
      }));
    }),
    locCompleteBranchIds: rows.filter(hasKnownChanges).map((row) => row.id),
    costContributions: costEvidence.contributions,
    costIncompleteContributions: costEvidence.incompleteContributions,
    costCompleteBranchIds: costEvidence.completeBranchIds,
    pullRequests: rows.flatMap((row, index) =>
      row.prNumber === null
        ? []
        : METRIC_ANCHORS.flatMap((occurredAt, anchorIndex) => {
            return [
              {
                identity: `github-pr:${row.id}:merged:${anchorIndex}`,
                branchId: row.id,
                mergedAt: occurredAt,
                closedAt: occurredAt,
                isDraft: false,
                additions:
                  row.additions === null ? null : row.additions + index,
                deletions:
                  row.deletions === null ? null : row.deletions + anchorIndex,
              },
              {
                identity: `github-pr:${row.id}:closed:${anchorIndex}`,
                branchId: row.id,
                mergedAt: null,
                closedAt: occurredAt,
                isDraft: false,
                additions:
                  row.additions === null ? null : row.additions + index,
                deletions:
                  row.deletions === null ? null : row.deletions + anchorIndex,
              },
            ];
          })
    ),
    pullRequestCoverageComplete: true,
  };
}

function hasKnownChanges(
  row: BranchRow
): row is BranchRow & { additions: number; deletions: number } {
  return row.additions !== null && row.deletions !== null;
}

function withRelativeActivityLabel(row: BranchRow, now: Date): BranchRow {
  const occurredAt = Date.parse(row.lastActivityAt);
  const ageMs = now.getTime() - occurredAt;
  if (!Number.isFinite(occurredAt) || ageMs < 0) {
    return { ...row, lastActivityLabel: "Unavailable" };
  }
  const minutes = Math.floor(ageMs / (60 * 1000));
  if (minutes < 60) {
    return { ...row, lastActivityLabel: `${minutes}m ago` };
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return { ...row, lastActivityLabel: `${hours}h ago` };
  }
  return {
    ...row,
    lastActivityLabel: `${Math.floor(hours / 24)}d ago`,
  };
}

/** Exhaustive canonical stock classifier used by current fixture snapshots. */
export function branchActiveState(
  status: BranchStatusValue | string | null | undefined
): boolean | null {
  switch (status) {
    case BranchStatus.Merged:
    case BranchStatus.Closed:
    case BranchStatus.Canceled:
      return false;
    case BranchStatus.Open:
    case BranchStatus.Draft:
    case BranchStatus.Review:
    case BranchStatus.Blocked:
      return true;
    default:
      return null;
  }
}

function createGeneratedBranchRow(index: number): BranchRow {
  const ordinal = String(index + 1).padStart(3, "0");
  return {
    id: `generated-branch-${ordinal}`,
    branchName: `agent/generated-branch-${ordinal}`,
    baseBranch: "main",
    repo: "closedloop-ai/symphony-alpha",
    owner: index % 2 === 0 ? "Alex Rivera" : "Sam Chen",
    status: generatedStatus(index),
    provenance: Provenance.Agent,
    prNumber: 2000 + index,
    prTitle: `Generated branch ${ordinal}`,
    prUrl: `https://github.com/closedloop-ai/symphony-alpha/pull/${2000 + index}`,
    prState: index % 5 === 0 ? PrState.Merged : PrState.Open,
    checksPassed: 10,
    checksTotal: 10,
    additions: 100 + index,
    deletions: 10,
    sessionCount: 1,
    commentCount: null,
    lastActivityAt: "2026-07-28T12:00:00.000Z",
    lastActivityLabel: "12h ago",
    collaborators: [],
    tags: ["generated"],
  };
}

function generatedStatus(index: number): BranchStatusValue {
  if (index % 11 === 0) {
    return BranchStatus.Canceled;
  }
  if (index % 7 === 0) {
    return BranchStatus.Closed;
  }
  if (index % 5 === 0) {
    return BranchStatus.Merged;
  }
  return BranchStatus.Open;
}
