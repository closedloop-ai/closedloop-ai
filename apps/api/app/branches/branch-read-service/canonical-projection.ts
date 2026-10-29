import type { ArtifactParentSummary } from "@repo/api/src/types/artifact-parent";
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
  type BranchMembershipSession,
  BranchProjectionEvidenceDelivery,
  BranchProjectionVersion,
  type CanonicalBranchProjectionCommonV1,
  type CanonicalBranchProjectionListV1,
} from "@repo/api/src/types/branch-projection";
import { getRoutePrefixForType } from "@repo/api/src/types/document";
import { ReadSource } from "@repo/api/src/types/read-source";
import {
  isRecognizedSessionStatus,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import { expandSlugAliases } from "@repo/api/src/types/slug-prefix";
import { firstActivityTFromSessions } from "@repo/lib/branches/branch-lead-time-activity";
import { deriveLinkedArtifactsFromBranchName } from "@repo/lib/branches/linked-artifacts";
import {
  toBasicUser,
  toSourceArtifactDocumentType,
} from "@/app/agent-sessions/service/projections";
import { projectDisplayedSessionStatus } from "@/app/agent-sessions/service/session-status-projection";
import { latestEligibleCloudBranchActivityAtom } from "../branch-activity-canonical-read";
import { projectCanonicalBranchActivityEvidence } from "../branch-activity-evidence";
import {
  observedPrStateForSelectedCloudPullRequest,
  projectCloudOwnedBranchAssociatedPullRequests,
  projectCloudReviewedParticipants,
  statusForSelectedCloudPullRequest,
} from "../branch-associated-pull-request-projection";
import { projectCloudCanonicalLastActive } from "../branch-canonical-metric-projection";
import {
  drainBranchCanonicalDivergenceEmissions,
  reportBranchCanonicalPointerDivergence,
  reportBranchCanonicalPullRequestAmbiguity,
  resolveBranchCanonicalPullRequestId,
} from "../branch-canonical-pull-request";
import { rawBranchCost } from "../branch-cost-attribution";
import { currentFileTotals, resolveDetailLoc } from "../branch-loc";
import type {
  SelectedBranchArtifact,
  SelectedBranchDetailArtifact,
  SelectedBranchPullRequestDetail,
} from "../branch-read-selects";
import { projectBranchTags } from "../branch-tag-projection";
import { BRANCH_MEMBERSHIP_SESSION_LIMIT } from "./branch-membership-limit";
import { assigneeOwnerIdentity } from "./branch-owner-projection";
import type { BranchIdentityProjection } from "./identity-attribution";
import type {
  BranchArtifactRow,
  BranchDetailArtifactRow,
} from "./persisted-row-read";
import {
  type BranchDetailSelectedPullRequestChecks,
  projectSelectedPullRequestChecks,
} from "./selected-pull-request-checks-projection";
import { emptyUsage, type SessionUsage, toIso } from "./session-usage-window";

type AssociatedPullRequests =
  | ReturnType<
      typeof projectCloudOwnedBranchAssociatedPullRequests<
        SelectedBranchArtifact["pullRequestDetails"][number]
      >
    >
  | ReturnType<
      typeof projectCloudOwnedBranchAssociatedPullRequests<
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
    projectCloudOwnedBranchAssociatedPullRequests(row)
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
  includeCanonicalProjection = true,
  membershipSessionLimit: number | null = BRANCH_MEMBERSHIP_SESSION_LIMIT
): BranchRow {
  const selectedCandidate = associatedPullRequests.selected ?? null;
  const selectedPullRequest = selectedCandidate?.source ?? null;
  const status = statusForSelectedCloudPullRequest(
    row.status,
    selectedCandidate
  );
  const fileTotals = currentFileTotals(
    row.branch.fileChangeTotals,
    row.branch.fileCacheHeadSha,
    row.branch.headSha,
    row.branch.fileCacheCapped
  );
  const loc = resolveDetailLoc(fileTotals, selectedPullRequest);
  const tags = projectBranchTags(
    row.tagArtifacts,
    organizationId,
    tagPermissions
  );
  const canonicalLastActiveAt = projectCloudCanonicalLastActive(row);
  const membershipSessions = qualifyingMembershipSessions(usage);
  const membershipSessionIds = membershipSessions.map(
    (session) => session.sessionId
  );
  const dataState = deriveDataState(row, usage);
  const common: CanonicalBranchProjectionCommonV1 = {
    identity: {
      artifactId: row.id,
      projectId: row.projectId,
      projectName: resolveBranchProjectName(row),
      branchName: row.branch.branchName,
      repositoryFullName:
        row.branch.repository?.fullName ??
        row.branch.repositoryFullName ??
        null,
    },
    membership: {
      sessionIds: membershipSessionIds,
      qualifyingSessionCount: membershipSessionIds.length,
      ...optionalMembershipSessions(
        usage,
        membershipSessions,
        membershipSessionLimit
      ),
    },
    people: {
      owner:
        identity?.ownerIdentity ??
        rowAssigneeOwnerIdentity(row, organizationId),
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
    projectName: common.identity.projectName,
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
    // ISS-10332: `null` is a real value here (no priority) and IS serialized —
    // the contract declares the field nullable, and omission means "unknown".
    priority: row.priority,
    prNumber: selectedPullRequest?.number ?? null,
    prTitle: selectedPullRequest?.title ?? null,
    prState: observedPrStateForSelectedCloudPullRequest(selectedCandidate),
    mergedAt: selectedPullRequest?.mergedAt
      ? toIso(selectedPullRequest.mergedAt)
      : null,
    prUrl: selectedPullRequest?.htmlUrl ?? null,
    multiPrWarning: common.pullRequests.associatedCount > 1,
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
    projectCloudOwnedBranchAssociatedPullRequests(row);
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
    projectCloudOwnedBranchAssociatedPullRequests(row),
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
  reportDetailPointerDivergence(
    row,
    organizationId,
    selectedPullRequest?.id ?? null
  );
  const reviewedParticipants = projectCloudReviewedParticipants(
    selectedPullRequestDetail
  );
  const linkedArtifacts = projectLinkedArtifacts(row);
  const resolvedUsage = usage ?? emptyUsage();
  const listRow = projectCanonicalCloudBranchRowWithAssociatedPullRequests(
    row,
    organizationId,
    tagPermissions,
    resolvedUsage,
    identity,
    null,
    associatedPullRequests,
    includeCanonicalProjection,
    null
  );
  const canonicalActivityAt = listRow.canonicalLastActiveAt?.value ?? null;
  const measuredChecks = projectSelectedPullRequestChecks(
    row.branch,
    selectedPullRequestDetail?.headRefOid ?? null
  );
  const detail: BranchPageDetail = {
    ...listRow,
    // ISS-8241 Half A: the detail speaks about ONE pull request, so its checks
    // fields are that pull request's own measurement or nothing. `listRow`
    // carries the BRANCH's rollup, which the list is right to show as the
    // branch's and this surface would be presenting as the selected PR's.
    checksStatus: measuredChecks.checksStatus,
    checksPassed: measuredChecks.checksPassed,
    checksTotal: measuredChecks.checksTotal,
    ...(measuredChecks.checks
      ? { selectedPullRequestChecksProjection: measuredChecks.checks }
      : {}),
    ...selectedPullRequestChecksCanonicalProjection(listRow, measuredChecks),
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
            // ISS-8241: served straight from this PR's own columns. `row.branch`
            // holds the branch's CURRENT base, which a branch reused for a later
            // PR has already moved — reading it here would make every historical
            // PR claim the newer target as a measured value.
            baseRefName: selectedPullRequestDetail.baseRefName,
            authorLogin: selectedPullRequestDetail.authorLogin,
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
      // ISS-8821: this used to be `canonicalActivityAt`, so the branch's FIRST
      // activity was reported at the instant of its LAST.
      firstActivityT: firstActivityTFromSessions(resolvedUsage.sessions),
      lastActivityT: canonicalActivityAt,
      idleSpans: [],
    },
    linkedPrNumbers: selectedPullRequest ? [selectedPullRequest.number] : [],
    ...projectArtifactRowFields(row),
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

/**
 * ISS-12197: the Artifact row's generic Details-tab fields. Every nullable one
 * is served as an explicit `null` when the row holds nothing, which the wire
 * keeps apart from an older producer's omission.
 */
function projectArtifactRowFields(
  row: BranchDetailArtifactRow
): Pick<
  BranchPageDetail,
  | "slug"
  | "assignee"
  | "createdAt"
  | "createdBy"
  | "updatedAt"
  | "dueDate"
  | "projectName"
  | "parent"
> {
  return {
    slug: row.slug,
    assignee: row.assignee ? toBasicUser(row.assignee) : null,
    createdAt: toIso(row.createdAt),
    createdBy: row.createdBy ? toBasicUser(row.createdBy) : null,
    updatedAt: toIso(row.updatedAt),
    dueDate: row.dueDate ? toIso(row.dueDate) : null,
    projectName: resolveBranchProjectName(row),
    parent: projectBranchParent(row),
  };
}

/**
 * The artifact that PRODUCES this branch — the source of the earliest inbound
 * `PRODUCES` link, read off the relation the detail select already loads for
 * {@link projectLinkedArtifacts}.
 */
function projectBranchParent(
  row: BranchDetailArtifactRow
): ArtifactParentSummary | null {
  const source = (row.targetLinks ?? [])[0]?.source;
  if (!source) {
    return null;
  }
  return {
    id: source.id,
    name: source.name,
    slug: source.slug,
    type: source.type,
    documentType: toSourceArtifactDocumentType(source),
  };
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
  const detailSessionById = new Map(
    qualifyingSessions.map((session) => [session.sessionId, session])
  );
  // The detail path projects every qualifying membership entry before later
  // enrichers mutate `detail.sessions`. Key the refresh from those enriched
  // entries so reordering cannot discard display, owner, or lifecycle evidence.
  const membershipSessions = (
    projection.common.membership.sessions ?? []
  ).flatMap((existing) => {
    const session = detailSessionById.get(existing.artifactId);
    if (!session) {
      return [];
    }
    return [
      {
        ...existing,
        artifactId: session.sessionId,
        name: session.name,
        slug: session.slug,
        navigableRef: session.navigableRef ?? session.slug ?? session.sessionId,
        ...(session.externalSessionId
          ? { externalSessionId: session.externalSessionId }
          : {}),
      },
    ];
  });
  projection.common.membership.sessions = membershipSessions;
  projection.common.membership.sessionIds = membershipSessions.map(
    (session) => session.artifactId
  );
  projection.common.membership.qualifyingSessionCount =
    membershipSessions.length;
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
  let hasPricedCost = false;
  for (const session of sessions) {
    hasPricedCost ||= session.estimatedCostUsd !== null;
    total += session.estimatedCostUsd ?? 0;
  }
  return hasPricedCost ? total : null;
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

/**
 * ISS-8153: the detail page keeps the shared deterministic selector as its
 * selection (the branch-canonical fallback arm); a VALID maintained pointer
 * that disagrees is a repair signal, reported rather than silently resolved.
 * Validity is the resolver's own test (owned row, not an empty stub), so this
 * monitor and `resolveBranchCanonicalPullRequestId` share ONE divergence
 * definition — a healed-over stub or a foreign pointer is the fallback arm
 * working as designed, not a repair signal (cr-96292).
 */
function reportDetailPointerDivergence(
  row: BranchDetailArtifactRow,
  organizationId: string,
  ownedSetSelectedId: string | null
): void {
  // ISS-8902: the terminal path for the divergence/ambiguity emission bound.
  // EVERY branch-detail read reaches here, including the overwhelming majority
  // that do not diverge, so a burst on one branch followed by quiet is flushed
  // into its rollup by the next read from any org rather than waiting for that
  // same branch to diverge again. O(1) while nothing has expired.
  drainBranchCanonicalDivergenceEmissions(Date.now());
  const resolution = resolveBranchCanonicalPullRequestId({
    currentPullRequestDetailId:
      row.branch?.currentPullRequestDetail?.id ?? null,
    pullRequestDetails: row.pullRequestDetails,
    ownedSetSelectedId,
  });
  if (
    !(
      resolution.pointerDivergedFromOwnedSet &&
      resolution.pointerId &&
      ownedSetSelectedId
    )
  ) {
    return;
  }
  const signal = {
    organizationId,
    branchArtifactId: row.id,
    pointerId: resolution.pointerId,
    ownedSetSelectedId,
  };
  reportBranchCanonicalPointerDivergence(signal);
  if (resolution.ambiguous) {
    reportBranchCanonicalPullRequestAmbiguity(signal);
  }
}

/**
 * ISS-8241 Half A: carry the same measured answer into the canonical block.
 *
 * `canonicalProjection.list.selectedPullRequest` is the one place the branch's
 * rollup was named after the selected pull request in structure as well as
 * intent, and the top-level fields above are a compatibility copy of it — a
 * consumer that reads the canonical block instead would otherwise still be told
 * the branch's current answer under this pull request's name.
 */
function selectedPullRequestChecksCanonicalProjection(
  listRow: BranchRow,
  measured: BranchDetailSelectedPullRequestChecks
): Pick<BranchRow, "canonicalProjection"> | Record<string, never> {
  const canonical = listRow.canonicalProjection;
  if (!canonical) {
    return {};
  }
  return {
    canonicalProjection: {
      ...canonical,
      list: {
        ...canonical.list,
        selectedPullRequest: {
          ...canonical.list.selectedPullRequest,
          checksStatus: measured.checksStatus,
          checksPassed: measured.checksPassed,
          checksTotal: measured.checksTotal,
        },
      },
    },
  };
}

/**
 * ISS-8972 — the page's per-Session membership entries, or nothing.
 *
 * Emitted only when the usage actually carries Session rows, so a branch with no
 * linked Session keeps the field ABSENT rather than carrying `[]`. Absence is
 * also what a producer predating this emits, which is what lets the renderer
 * tell "this producer resolved no identities" from "this branch has none" — the
 * desktop's local read is exactly the first case, and it keeps its count chip
 * rather than rendering an empty cell over sessions it can prove exist.
 *
 * Built from one qualified sequence, so the entries and
 * `membership.sessionIds` describe the same population in the same order and
 * `qualifyingSessionCount` cannot disagree with what the column shows. List
 * callers cap described entries; detail callers retain the complete sequence.
 */
function optionalMembershipSessions(
  usage: SessionUsage,
  sessions: readonly SessionUsage["sessions"][number][],
  limit: number | null
): { sessions: BranchMembershipSession[] } | Record<string, never> {
  if (sessions.length === 0) {
    return {};
  }
  // ONE instant for every entry on this branch, so two chips in the same cell
  // cannot be judged against different staleness cutoffs.
  const now = new Date();
  // The list is bounded per branch; the detail path passes no limit because it
  // already showed every linked Session before this canonical projection.
  const described = limit === null ? sessions : sessions.slice(0, limit);
  return {
    sessions: described.map((s) => membershipSession(usage, s, now)),
  };
}

/** One membership entry: identity, plus whatever this producer resolved about it. */
function membershipSession(
  usage: SessionUsage,
  session: SessionUsage["sessions"][number],
  now: Date
): BranchMembershipSession {
  const sessionId = session.sessionId;
  const profile = usage.sessionOwnerProfileById.get(sessionId);
  const ownerId = usage.sessionOwnerById.get(sessionId) ?? null;
  const displayInputs = usage.sessionDisplayInputsById.get(sessionId);
  const lastInteractionAt = displayInputs?.lastActivityAt
    ? toIso(displayInputs.lastActivityAt)
    : undefined;
  const projectedStatus = displayInputs
    ? projectDisplayedSessionStatus(displayInputs, now)
    : undefined;
  return {
    artifactId: sessionId,
    name: session.name,
    slug: session.slug,
    navigableRef: session.navigableRef ?? session.slug ?? sessionId,
    ...(session.externalSessionId
      ? { externalSessionId: session.externalSessionId }
      : {}),
    // An unresolved owner stays ABSENT rather than becoming an empty name: the
    // renderer owns how "unattributed" reads, and a "" would render as a chip
    // with blank initials that looks like a resolved identity.
    ...(profile ? { ownerName: profile.name } : {}),
    ...(profile?.avatarUrl ? { ownerAvatarUrl: profile.avatarUrl } : {}),
    // A Session that HAS an owner nobody could resolve is not an ownerless one
    // (`apps/api/app/branches/AGENTS.md`): without this the chip says
    // "Unattributed" about a run that is attributed to someone we cannot name.
    ...(!profile && ownerId ? { ownerUnavailable: true } : {}),
    ...(displayInputs
      ? {
          // Derived per read, never stored, and through the SHARED projector so
          // a branch chip cannot tell a different story than the Sessions list
          // about the same row: it reconciles an ended run and folds an
          // unparseable or long-silent one to `active` (ISS-10364), exactly as
          // `projectDisplayedSessionStatus` always has here.
          //
          // The fallback is defensive rather than reachable: `projectedStatus`
          // is computed from `displayInputs` just above, inside this same
          // `displayInputs ?` branch, and `projectDisplayedSessionStatus` always
          // returns a recognized lifecycle value — so `isRecognizedSessionStatus`
          // never actually fails here. Kept as the vocabulary-wide fail-open
          // (never a fabricated "we don't know" word) in case that stops being
          // true.
          displayedStatus:
            projectedStatus && isRecognizedSessionStatus(projectedStatus)
              ? projectedStatus
              : SESSION_STATUS.ACTIVE,
          rawStatus: displayInputs.status,
        }
      : {}),
    ...(session.participation ? { participation: session.participation } : {}),
    ...(lastInteractionAt ? { lastInteractionAt } : {}),
  };
}

function qualifyingMembershipSessions(
  usage: SessionUsage
): SessionUsage["sessions"] {
  return usage.sessions.filter(
    (session) => session.participation !== BranchParticipationKind.Reviewed
  );
}

/** ISS-12453: the joined project's display name, or null for an unfiled branch. */
function resolveBranchProjectName(row: {
  project?: { name: string } | null;
}): string | null {
  return row.project?.name ?? null;
}

/**
 * The Owner when the identity read was skipped or failed (ISS-10297): the
 * assignee is on the row itself, so the Owner's person survives. Its GitHub
 * login and profile come only from the identity read's connection lookup, so
 * this fallback serves the ClosedLoop person. The organization check is the
 * list SQL's `users` join condition.
 */
function rowAssigneeOwnerIdentity(
  row: Pick<BranchArtifactRow, "assignee">,
  organizationId: string
) {
  const assignee =
    row.assignee?.organizationId === organizationId ? row.assignee : null;
  return assigneeOwnerIdentity(
    assignee?.id ?? null,
    new Map(),
    new Map(assignee ? [[assignee.id, assignee]] : [])
  );
}
