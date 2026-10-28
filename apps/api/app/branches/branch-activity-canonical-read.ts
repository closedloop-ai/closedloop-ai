import {
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";
import { Prisma } from "@repo/database";
import {
  isWithinTrustedFutureBoundary,
  MAX_TRUSTED_FUTURE_SKEW_MS,
} from "@/lib/trusted-timestamp";

/** Persisted atom fields needed by the cloud canonical Last-active read. */
export type CanonicalCloudBranchActivityAtom = {
  version: number;
  source: string;
  sourceEventId: string;
  occurredAt: Date;
  activityKind?: string | null;
  compatibilityAliasForSourceEventId?: string | null;
  attributionKind: string;
  pullRequestDetailId: string | null;
  completeness: string;
  createdAt?: Date;
};

/**
 * Exhaustive by key, so a new `BranchActivitySource` member fails typecheck
 * here until someone classifies it, instead of defaulting silently to excluded
 * the way a hand-listed array does.
 */
const canonicalBranchActivitySourceAdmission: Record<
  BranchActivitySource,
  boolean
> = {
  [BranchActivitySource.GitHead]: true,
  [BranchActivitySource.PullRequestLifecycle]: true,
  [BranchActivitySource.PullRequestReview]: true,
  [BranchActivitySource.GitHubWebhook]: true,
  [BranchActivitySource.MonitoredSession]: true,
  // ISS-10009: a push is LOC evidence, not Last-active evidence. Admitting it
  // would let a push set `last_activity_at` and reorder the Branches list.
  [BranchActivitySource.PushLoc]: false,
  [BranchActivitySource.Unknown]: false,
};

/** Source lanes approved by PRD-600 COMMON-004 for canonical activity reads. */
export const canonicalBranchActivitySources: readonly BranchActivitySource[] =
  Object.values(BranchActivitySource).filter(
    (source) => canonicalBranchActivitySourceAdmission[source]
  );

/** Completeness values that represent usable immutable evidence. */
export const canonicalBranchActivityCompleteness = [
  BranchActivityEvidenceCompleteness.Complete,
  BranchActivityEvidenceCompleteness.Partial,
] as const;

/** Canonical persisted-row eligibility shared by readers and aggregates. */
export function canonicalBranchActivityAtomEligibilitySql(
  ownerOrganizationId: Prisma.Sql,
  ownerBranchArtifactId: Prisma.Sql
): Prisma.Sql {
  return Prisma.sql`
    atom.version = ${BranchActivityAtomVersion.V1}
    AND atom.compatibility_alias_for_source_event_id IS NULL
    AND atom.source IN (${Prisma.join(canonicalBranchActivitySources)})
    AND COALESCE(atom.source_event_id = btrim(atom.source_event_id), FALSE)
    AND COALESCE(length(atom.source_event_id) BETWEEN 1 AND 512, FALSE)
    AND COALESCE(isfinite(atom.occurred_at), FALSE)
    AND COALESCE(
      atom.occurred_at <= atom.created_at + (${MAX_TRUSTED_FUTURE_SKEW_MS} * interval '1 millisecond'),
      FALSE
    )
    AND COALESCE(
      atom.completeness IN (${Prisma.join(
        canonicalBranchActivityCompleteness
      )}),
      FALSE
    )
    AND COALESCE(
      (
        atom.attribution_kind = ${BranchActivityAttributionKind.Branch}
        AND atom.pull_request_detail_id IS NULL
      )
      OR (
        atom.attribution_kind = ${BranchActivityAttributionKind.PullRequest}
        AND atom.pull_request_detail_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM pull_request_detail activity_pr
          WHERE activity_pr.id = atom.pull_request_detail_id
            AND activity_pr.organization_id = ${ownerOrganizationId}
            AND activity_pr.branch_artifact_id = ${ownerBranchArtifactId}
        )
      ),
      FALSE
    )
  `;
}

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
    atom.compatibilityAliasForSourceEventId != null ||
    !canonicalBranchActivitySources.some((source) => source === atom.source) ||
    atom.sourceEventId.trim().length === 0 ||
    atom.sourceEventId !== atom.sourceEventId.trim() ||
    atom.sourceEventId.length > 512 ||
    !Number.isFinite(atom.occurredAt.getTime()) ||
    !isWithinTrustedFutureBoundary(
      atom.occurredAt,
      atom.createdAt ?? atom.occurredAt
    ) ||
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
