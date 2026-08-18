import {
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";

/** Persisted atom fields needed by the cloud canonical Last-active read. */
export type CanonicalCloudBranchActivityAtom = {
  version: number;
  source: string;
  sourceEventId: string;
  occurredAt: Date;
  attributionKind: string;
  pullRequestDetailId: string | null;
  completeness: string;
};

/** Source lanes approved by PRD-600 COMMON-004 for canonical activity reads. */
export const canonicalBranchActivitySources = [
  BranchActivitySource.GitHead,
  BranchActivitySource.PullRequestLifecycle,
  BranchActivitySource.PullRequestReview,
  BranchActivitySource.GitHubWebhook,
  BranchActivitySource.MonitoredSession,
] as const;

/** Completeness values that represent usable immutable evidence. */
export const canonicalBranchActivityCompleteness = [
  BranchActivityEvidenceCompleteness.Complete,
  BranchActivityEvidenceCompleteness.Partial,
] as const;

type CanonicalActivityOwner = {
  id: string;
  pullRequestDetails: readonly {
    id: string;
    branchArtifactId: string;
  }[];
  branch: { activityAtoms: readonly CanonicalCloudBranchActivityAtom[] };
};

/** Select the newest eligible atom without allowing malformed newer rows to mask it. */
export function latestEligibleCloudBranchActivityAtom(
  row: CanonicalActivityOwner
): CanonicalCloudBranchActivityAtom | undefined {
  return row.branch.activityAtoms
    .filter((atom) => isEligibleCloudBranchActivityAtom(row, atom))
    .sort(compareCanonicalActivityAtoms)[0];
}

function isEligibleCloudBranchActivityAtom(
  row: CanonicalActivityOwner,
  atom: CanonicalCloudBranchActivityAtom
): boolean {
  if (
    atom.version !== BranchActivityAtomVersion.V1 ||
    !canonicalBranchActivitySources.some((source) => source === atom.source) ||
    atom.sourceEventId.trim().length === 0 ||
    atom.sourceEventId !== atom.sourceEventId.trim() ||
    atom.sourceEventId.length > 512 ||
    !Number.isFinite(atom.occurredAt.getTime()) ||
    !canonicalBranchActivityCompleteness.some(
      (completeness) => completeness === atom.completeness
    )
  ) {
    return false;
  }
  if (atom.attributionKind === BranchActivityAttributionKind.Branch) {
    return atom.pullRequestDetailId === null;
  }
  if (
    atom.attributionKind !== BranchActivityAttributionKind.PullRequest ||
    atom.pullRequestDetailId === null
  ) {
    return false;
  }
  return row.pullRequestDetails.some(
    (pullRequest) =>
      pullRequest.id === atom.pullRequestDetailId &&
      pullRequest.branchArtifactId === row.id
  );
}

function compareCanonicalActivityAtoms(
  left: CanonicalCloudBranchActivityAtom,
  right: CanonicalCloudBranchActivityAtom
): number {
  const occurredAtDelta =
    right.occurredAt.getTime() - left.occurredAt.getTime();
  if (occurredAtDelta !== 0) {
    return occurredAtDelta;
  }
  const sourceDelta = compareStableText(left.source, right.source);
  return sourceDelta === 0
    ? compareStableText(left.sourceEventId, right.sourceEventId)
    : sourceDelta;
}

function compareStableText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
