import {
  type BranchCommit,
  BranchDataState,
  type BranchLinkedArtifact,
  BranchLinkedArtifactCollectionProvenance,
  BranchLinkedArtifactCollectionState,
  BranchLinkedArtifactEvidenceKind,
  type BranchPageDetail,
  BranchParticipationKind,
  type BranchRow,
  BranchTagAvailability,
  type BranchTagPermissions,
} from "@repo/api/src/types/branch";
import {
  BranchProjectionEvidenceDelivery,
  BranchProjectionVersion,
  type CanonicalBranchProjectionCommonV1,
  type CanonicalBranchProjectionListV1,
} from "@repo/api/src/types/branch-projection";
import { getRoutePrefixForType } from "@repo/api/src/types/document";
import { ReadSource } from "@repo/api/src/types/read-source";
import { expandSlugAliases } from "@repo/api/src/types/slug-prefix";
import { deriveLinkedArtifactsFromBranchName } from "@repo/lib/branches/linked-artifacts";
import { latestEligibleCloudBranchActivityAtom } from "../branch-activity-canonical-read";
import { projectCanonicalBranchActivityEvidence } from "../branch-activity-evidence";
import {
  projectCloudBranchAssociatedPullRequests,
  projectCloudBranchDetailAssociatedPullRequests,
  projectCloudReviewedParticipants,
  statusForSelectedCloudPullRequest,
} from "../branch-associated-pull-request-projection";
import { projectCloudCanonicalLastActive } from "../branch-canonical-metric-projection";
import { rawBranchCost } from "../branch-cost-attribution";
import { currentFileTotals, resolveDetailLoc } from "../branch-loc";
import type {
  SelectedBranchArtifact,
  SelectedBranchDetailArtifact,
  SelectedBranchPullRequestDetail,
} from "../branch-read-selects";
import { projectBranchTags } from "../branch-tag-projection";
import type { BranchIdentityProjection } from "./identity-attribution";
import { emptyUsage, type SessionUsage, toIso } from "./session-usage-window";

type BranchArtifactRow = SelectedBranchArtifact & {
  branch: NonNullable<SelectedBranchArtifact["branch"]>;
};

type BranchDetailArtifactRow = SelectedBranchDetailArtifact & {
  branch: NonNullable<SelectedBranchDetailArtifact["branch"]>;
};

type AssociatedPullRequests =
  | ReturnType<
      typeof projectCloudBranchAssociatedPullRequests<
        SelectedBranchArtifact["pullRequestDetails"][number]
      >
    >
  | ReturnType<
      typeof projectCloudBranchDetailAssociatedPullRequests<
        SelectedBranchDetailArtifact["pullRequestDetails"][number]
      >
    >;

/**
 * Project one cloud list row through the V1 canonical contract, then derive the
 * compatibility fields from the same values. The mapper is pure: all database,
 * provider, and bounded-enrichment work remains in the composition owner.
 */
export function projectCanonicalCloudBranchRow(
  row: BranchArtifactRow,
  organizationId: string,
  tagPermissions?: BranchTagPermissions,
  usage = emptyUsage(),
  identity: BranchIdentityProjection | undefined = undefined,
  attributedCostUsd: number | null | undefined = undefined
): BranchRow {
  return projectCanonicalCloudBranchRowWithAssociatedPullRequests(
    row,
    organizationId,
    tagPermissions,
    usage,
    identity,
    attributedCostUsd,
    projectCloudBranchAssociatedPullRequests(row)
  );
}

function projectCanonicalCloudBranchRowWithAssociatedPullRequests(
  row: BranchArtifactRow,
  organizationId: string,
  tagPermissions: BranchTagPermissions | undefined,
  usage: SessionUsage,
  identity: BranchIdentityProjection | undefined,
  attributedCostUsd: number | null | undefined,
  associatedPullRequests: AssociatedPullRequests,
  includeCanonicalProjection = true
): BranchRow {
  const selectedPullRequest = associatedPullRequests.selected?.source ?? null;
  const status = statusForSelectedCloudPullRequest(
    row.status,
    selectedPullRequest
  );
  const fileTotals = currentFileTotals(
    row.branch.fileChanges,
    row.branch.fileCacheHeadSha,
    row.branch.headSha
  );
  const loc = resolveDetailLoc(fileTotals, selectedPullRequest);
  const tags = projectBranchTags(
    row.tagArtifacts,
    organizationId,
    tagPermissions
  );
  const canonicalLastActiveAt = projectCloudCanonicalLastActive(row);
  const dataState = deriveDataState(row, usage);
  const common: CanonicalBranchProjectionCommonV1 = {
    identity: {
      artifactId: row.id,
      projectId: row.projectId,
      branchName: row.branch.branchName,
      repositoryFullName:
        row.branch.repository?.fullName ??
        row.branch.repositoryFullName ??
        null,
    },
    membership: {
      sessionIds: usage.sessionIds,
      qualifyingSessionCount: usage.sessionIds.length,
    },
    people: {
      ...(identity ? { owner: identity.ownerIdentity } : {}),
      ...(identity ? { collaborators: identity.collaborators } : {}),
    },
    tags: {
      ...(tags.tags ? { items: tags.tags } : {}),
      availability: tags.tagAvailability ?? BranchTagAvailability.Unavailable,
      ...(tags.tagPermissions ? { permissions: tags.tagPermissions } : {}),
    },
    pullRequests: summarizeAssociatedPullRequests(associatedPullRequests),
    lastActiveAt: canonicalLastActiveAt,
    evidence: {
      comments: { delivery: BranchProjectionEvidenceDelivery.Lazy },
      checks: { delivery: BranchProjectionEvidenceDelivery.Lazy },
      files: { delivery: BranchProjectionEvidenceDelivery.Lazy },
      trace: { delivery: BranchProjectionEvidenceDelivery.Lazy },
    },
    provenance: { source: ReadSource.Cloud },
  };
  const list: CanonicalBranchProjectionListV1 = {
    status,
    dataState,
    selectedPullRequest: {
      id: associatedPullRequests.collection.selectedId,
      checksStatus: row.branch.checksStatus,
      checksPassed: null,
      checksTotal: row.branch.checksDetailTotalCount,
    },
    changes: {
      additions: loc.additions,
      deletions: loc.deletions,
      filesChanged: loc.filesChanged,
    },
    cost: {
      replicatedUsd: rawBranchCost(usage),
      ...(attributedCostUsd === undefined
        ? {}
        : { attributedUsd: attributedCostUsd }),
    },
  };

  return {
    id: common.identity.artifactId,
    artifactId: common.identity.artifactId,
    projectId: common.identity.projectId,
    ...tags,
    branchName: common.identity.branchName,
    baseBranch: row.branch.baseBranch,
    repoFullName: common.identity.repositoryFullName,
    owner:
      common.people.owner?.person?.displayName ??
      common.people.owner?.person?.login ??
      null,
    ...(common.people.owner ? { ownerIdentity: common.people.owner } : {}),
    ...(common.people.collaborators
      ? { collaborators: common.people.collaborators }
      : {}),
    status: list.status,
    prNumber: selectedPullRequest?.number ?? null,
    prTitle: selectedPullRequest?.title ?? null,
    prState: selectedPullRequest?.prState ?? null,
    mergedAt: selectedPullRequest?.mergedAt
      ? toIso(selectedPullRequest.mergedAt)
      : null,
    prUrl: selectedPullRequest?.htmlUrl ?? null,
    multiPrWarning: false,
    checksStatus: list.selectedPullRequest.checksStatus,
    checksPassed: list.selectedPullRequest.checksPassed,
    checksTotal: list.selectedPullRequest.checksTotal,
    reviewDecision: selectedPullRequest?.reviewDecision ?? null,
    ahead: null,
    behind: null,
    additions: list.changes.additions,
    deletions: list.changes.deletions,
    filesChanged: list.changes.filesChanged,
    analyticsAdditions: fileTotals.additions,
    analyticsDeletions: fileTotals.deletions,
    estimatedCostUsd: list.cost.replicatedUsd,
    ...(list.cost.attributedUsd === undefined
      ? {}
      : { attributedCostUsd: list.cost.attributedUsd }),
    // Compatibility consumers validate this string before rendering. Preserve
    // the canonical value when available and use the established invalid/empty
    // sentinel when it is unavailable; artifact creation/update time is not
    // authoritative Last-active evidence.
    lastActivityAt: canonicalLastActiveAt.value ?? "",
    canonicalLastActiveAt: common.lastActiveAt,
    canonicalActivityEvidence: projectCanonicalBranchActivityEvidence(
      latestEligibleCloudBranchActivityAtom(row)
    ),
    sessionIds: common.membership.sessionIds,
    dataState: list.dataState,
    ...(includeCanonicalProjection
      ? {
          canonicalProjection: {
            version: BranchProjectionVersion.V1,
            common,
            list,
          },
        }
      : {}),
  };
}

/** Build the compatibility detail row from the same canonical list projection. */
export function projectCanonicalCloudBranchDetail(
  row: BranchDetailArtifactRow,
  organizationId: string,
  tagPermissions?: BranchTagPermissions,
  usage: SessionUsage | null = null,
  commits: BranchCommit[] = [],
  identity: BranchIdentityProjection | undefined = undefined,
  selectedPullRequestDetail: SelectedBranchPullRequestDetail | null = null,
  resolvedAssociatedPullRequests?: AssociatedPullRequests
): BranchPageDetail {
  const associatedPullRequests =
    resolvedAssociatedPullRequests ??
    projectCloudBranchDetailAssociatedPullRequests(row);
  return projectCloudBranchDetail(
    row,
    organizationId,
    tagPermissions,
    usage,
    commits,
    identity,
    selectedPullRequestDetail,
    associatedPullRequests,
    true
  );
}

/** Build an early refresh compatibility row without claiming V1 enrichment. */
export function projectCloudBranchRefreshDetail(
  row: BranchDetailArtifactRow,
  organizationId: string,
  tagPermissions?: BranchTagPermissions
): BranchPageDetail {
  return projectCloudBranchDetail(
    row,
    organizationId,
    tagPermissions,
    null,
    [],
    undefined,
    null,
    projectCloudBranchDetailAssociatedPullRequests(row),
    false
  );
}

function projectCloudBranchDetail(
  row: BranchDetailArtifactRow,
  organizationId: string,
  tagPermissions: BranchTagPermissions | undefined,
  usage: SessionUsage | null,
  commits: BranchCommit[],
  identity: BranchIdentityProjection | undefined,
  selectedPullRequestDetail: SelectedBranchPullRequestDetail | null,
  associatedPullRequests: AssociatedPullRequests,
  includeCanonicalProjection: boolean
): BranchPageDetail {
  const selectedPullRequest = associatedPullRequests.selected?.source ?? null;
  const selectedPullRequestItem = associatedPullRequests.collection.items.find(
    (item) => item.id === associatedPullRequests.collection.selectedId
  );
  const reviewedParticipants = projectCloudReviewedParticipants(
    selectedPullRequestDetail
  );
  const linkedArtifacts = projectLinkedArtifacts(row);
  const listRow = projectCanonicalCloudBranchRowWithAssociatedPullRequests(
    row,
    organizationId,
    tagPermissions,
    usage ?? emptyUsage(),
    identity,
    null,
    associatedPullRequests,
    includeCanonicalProjection
  );
  const canonicalActivityAt = listRow.canonicalLastActiveAt?.value ?? null;
  const detail: BranchPageDetail = {
    ...listRow,
    associatedPullRequests: associatedPullRequests.collection,
    selectedPullRequest:
      selectedPullRequest &&
      selectedPullRequestItem &&
      selectedPullRequestDetail
        ? {
            ...selectedPullRequestItem,
            body: selectedPullRequestDetail.body,
            headRefOid: selectedPullRequestDetail.headRefOid,
            mergeCommitSha: selectedPullRequestDetail.mergeCommitSha,
            changedFiles: selectedPullRequestDetail.changedFiles,
            additions: selectedPullRequestDetail.additions,
            deletions: selectedPullRequestDetail.deletions,
          }
        : null,
    prBody: selectedPullRequestDetail?.body ?? null,
    prBodyHtmlUrl: selectedPullRequest?.htmlUrl ?? null,
    headSha: selectedPullRequestDetail?.headRefOid ?? null,
    branchHeadSha: row.branch.headSha,
    mergeCommitSha: selectedPullRequestDetail?.mergeCommitSha ?? null,
    mergedAt: selectedPullRequest?.mergedAt
      ? toIso(selectedPullRequest.mergedAt)
      : null,
    closedAt: selectedPullRequest?.closedAt
      ? toIso(selectedPullRequest.closedAt)
      : null,
    openedAt: selectedPullRequest?.githubCreatedAt
      ? toIso(selectedPullRequest.githubCreatedAt)
      : null,
    commits,
    sessions: usage?.sessions ?? [],
    ...(reviewedParticipants.participants.length > 0
      ? { reviewedParticipants: reviewedParticipants.participants }
      : {}),
    ...(reviewedParticipants.truncated
      ? { reviewedParticipantsTruncated: true }
      : {}),
    mergedTrace: [],
    leadTime: {
      firstActivityT: canonicalActivityAt,
      lastActivityT: canonicalActivityAt,
      idleSpans: [],
    },
    linkedPrNumbers: selectedPullRequest ? [selectedPullRequest.number] : [],
    linkedArtifacts: linkedArtifacts.items,
    linkedArtifactsCollection: {
      state: linkedArtifacts.incomplete
        ? BranchLinkedArtifactCollectionState.Incomplete
        : BranchLinkedArtifactCollectionState.Complete,
      provenance: BranchLinkedArtifactCollectionProvenance.CloudPersisted,
    },
  };
  return detail;
}

/** Project branch-name evidence plus exact permission-filtered Document→Branch links. */
function projectLinkedArtifacts(row: BranchDetailArtifactRow): {
  incomplete: boolean;
  items: BranchLinkedArtifact[];
} {
  const linked: BranchLinkedArtifact[] = deriveLinkedArtifactsFromBranchName(
    row.branch.branchName
  ).map((artifact) => ({
    ...artifact,
    evidence: { kind: BranchLinkedArtifactEvidenceKind.BranchNameSlug },
  }));
  const indexBySlug = new Map(
    linked.map((artifact, index) => [
      linkedArtifactIdentity(artifact.slug),
      index,
    ])
  );
  let incomplete = false;
  for (const link of row.targetLinks ?? []) {
    const source = link.source;
    const slug = source.slug;
    const prefix = source.subtype
      ? getRoutePrefixForType(source.subtype)
      : null;
    if (!(slug && prefix)) {
      incomplete = true;
      continue;
    }
    const artifact: BranchLinkedArtifact = {
      artifactId: source.id,
      slug,
      label: source.name,
      href: `/${prefix}/${slug}`,
      evidence: {
        kind: BranchLinkedArtifactEvidenceKind.DocumentProducesBranch,
        linkId: link.id,
      },
    };
    const identity = linkedArtifactIdentity(slug);
    const existingIndex = indexBySlug.get(identity);
    if (existingIndex === undefined) {
      indexBySlug.set(identity, linked.length);
      linked.push(artifact);
    } else {
      linked[existingIndex] = artifact;
    }
  }
  return { incomplete, items: linked };
}

/** Canonical alias-aware key so FEA-* and ISS-* evidence dedupe. */
function linkedArtifactIdentity(slug: string): string {
  return (
    expandSlugAliases(slug)
      .map((candidate) => candidate.toLocaleUpperCase())
      .sort()[0] ?? slug.toLocaleUpperCase()
  );
}

/**
 * Attach detail-only canonical fields after bounded enrichment completes.
 * Heavy comments, checks, files, and trace payloads remain dedicated lazy reads.
 */
export function finalizeCanonicalCloudBranchDetail(
  detail: BranchPageDetail
): void {
  const projection = detail.canonicalProjection;
  if (!projection) {
    return;
  }
  const qualifyingSessions = detail.sessions.filter(
    (session) => session.participation !== BranchParticipationKind.Reviewed
  );
  projection.common.membership.sessionIds = qualifyingSessions.map(
    (session) => session.sessionId
  );
  projection.common.membership.qualifyingSessionCount =
    qualifyingSessions.length;
  projection.common.membership.sessions = qualifyingSessions.map((session) => ({
    artifactId: session.sessionId,
    name: session.name,
    slug: session.slug,
    navigableRef: session.navigableRef ?? session.slug ?? session.sessionId,
    ...(session.externalSessionId
      ? { externalSessionId: session.externalSessionId }
      : {}),
  }));
  projection.detail = {
    ...(detail.phaseAttribution
      ? { phaseAttribution: detail.phaseAttribution }
      : {}),
    ...(detail.canonicalMetrics ? { metrics: detail.canonicalMetrics } : {}),
    ...(detail.lifecyclePhaseStacks
      ? { lifecyclePhaseStacks: detail.lifecyclePhaseStacks }
      : {}),
  };
  if (projection.list.dataState !== BranchDataState.AwaitingSync) {
    projection.list.dataState =
      qualifyingSessions.length > 0
        ? BranchDataState.Ready
        : BranchDataState.NoSessions;
  }
  projection.list.cost.replicatedUsd =
    replicatedCostForQualifyingSessions(qualifyingSessions);
  projection.list.cost.attributedUsd =
    attributedCostForQualifyingSessions(qualifyingSessions);
}

function replicatedCostForQualifyingSessions(
  sessions: readonly BranchPageDetail["sessions"][number][]
): number | null {
  let total = 0;
  for (const session of sessions) {
    total += session.estimatedCostUsd ?? 0;
  }
  return total > 0 ? total : null;
}

function attributedCostForQualifyingSessions(
  sessions: readonly BranchPageDetail["sessions"][number][]
): number | null {
  let total = 0;
  let hasPricedCost = false;
  for (const session of sessions) {
    hasPricedCost ||= session.evenSplitCostUsd != null;
    total += session.evenSplitCostUsd ?? 0;
  }
  return hasPricedCost ? total : null;
}

function summarizeAssociatedPullRequests(
  associatedPullRequests: AssociatedPullRequests
): CanonicalBranchProjectionCommonV1["pullRequests"] {
  const { collection } = associatedPullRequests;
  return {
    associatedCount: collection.items.length,
    selected:
      collection.items.find((item) => item.id === collection.selectedId) ??
      null,
    selectionReason: collection.selectionReason,
    completeness: collection.completeness,
  };
}

function deriveDataState(
  row: BranchArtifactRow,
  usage: SessionUsage
): BranchDataState {
  if (row.branch.syncStatus !== "idle" && !row.branch.lastSyncCompletedAt) {
    return BranchDataState.AwaitingSync;
  }
  if (usage.sessionIds.length === 0) {
    return BranchDataState.NoSessions;
  }
  return BranchDataState.Ready;
}
