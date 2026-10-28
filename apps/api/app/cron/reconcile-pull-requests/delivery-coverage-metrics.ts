import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import type { GitHubAccessDenialReason } from "@repo/api/src/types/github";
import {
  commandDerivedSessionPrRefsFromMetadata,
  sessionPrIdentityKey,
} from "@repo/api/src/types/session-artifact-link";
import type { Prisma } from "@repo/database";
import { withDb } from "@repo/database";
import type { GitHubProviderResultStatus } from "@repo/github";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { FilterToken } from "@repo/observability/telemetry/filter-tokens";
import { emitTelemetryMetric } from "@repo/observability/telemetry/metrics";
import { ORIGIN, type Origin } from "@repo/observability/telemetry/origin";
import {
  GitHubRepoSyncDeferralReason,
  type GitHubRepoSyncTier,
} from "@/lib/github/github-repo-sync-state";
import {
  buildSessionPrAdmissionIndex,
  type SessionLinkedPrDetail,
  sessionLinkedBranches,
} from "@/lib/session-pr-links";
import { readInIdChunks } from "@/lib/session-pr-links-chunking";
import {
  type DeliveryCoverageLinkRow,
  type DeliveryCoverageLinkScanUnavailableContext,
  GITHUB_DELIVERY_COVERAGE_LINK_SCAN_LIMIT,
  GITHUB_DELIVERY_COVERAGE_SESSION_LINK_SCAN_LIMIT_EXCEEDED_REASON,
  readDeliveryCoverageLinks,
} from "./delivery-coverage-link-reader";
import {
  hasCompleteDeliveryCoverageLoc,
  isDeliveryCoverageCovered,
} from "./delivery-coverage-predicate";
import {
  ReconcileRepoStatus,
  type ReconcileRepoStatus as ReconcileRepoStatusType,
} from "./repo-reconcile-status";

const RECONCILE_LOG_PREFIX = "[reconcile-pull-requests]";
const GITHUB_DELIVERY_COVERAGE_SYNC_LANE = "reconcile_pull_requests";

export const GitHubDeliveryCoverageState = {
  Measured: "measured",
  NoSessionLinkedTargets: "no_session_linked_targets",
  Unavailable: "unavailable",
} as const;
export type GitHubDeliveryCoverageState =
  (typeof GitHubDeliveryCoverageState)[keyof typeof GitHubDeliveryCoverageState];

export const GitHubDeliveryCoverageUnavailableReason = {
  CoverageQueryFailed: "coverage_query_failed",
  SessionLinkScanLimitExceeded:
    GITHUB_DELIVERY_COVERAGE_SESSION_LINK_SCAN_LIMIT_EXCEEDED_REASON,
} as const;
export type GitHubDeliveryCoverageUnavailableReason =
  (typeof GitHubDeliveryCoverageUnavailableReason)[keyof typeof GitHubDeliveryCoverageUnavailableReason];

export type GitHubDeliveryCoverageTickInput = {
  organizationId: string;
  repositoryId: string | null;
  repositoryFullName: string;
  status: ReconcileRepoStatusType;
  tier?: GitHubRepoSyncTier;
  writtenCount: number;
  deferredReason: GitHubRepoSyncDeferralReason | null;
  resultReason?: GitHubProviderResultStatus | GitHubAccessDenialReason;
  fetchFailureCount: number;
  targetFetchFailureWriteCount: number;
  budgetDeferralCount: number;
  now: Date;
};

export type GitHubDeliveryCoverageCounts = {
  sessionLinkedPrCount: number;
  locEnrichedPrCount: number;
  visiblePromotedPrCount: number;
  trustedVerifiedPrCount: number;
  enrichedOrVisiblePrCount: number;
  excludedCandidateCount: number;
};
type GitHubDeliveryCoverageFieldCounts = Omit<
  GitHubDeliveryCoverageCounts,
  "sessionLinkedPrCount" | "excludedCandidateCount"
>;

type GitHubDeliveryCoverageMetric = {
  metric: typeof FilterToken.GitHubDeliveryCoverageRepoTick;
  origin: Origin;
  syncLane: typeof GITHUB_DELIVERY_COVERAGE_SYNC_LANE;
  organizationId: string;
  repositoryFullName: string;
  repositoryId?: string;
  syncTier?: GitHubRepoSyncTier;
  reconcileOutcome: ReconcileRepoStatusType;
  deferredReason?: GitHubRepoSyncDeferralReason;
  resultReason?: GitHubProviderResultStatus | GitHubAccessDenialReason;
  coverageState: GitHubDeliveryCoverageState;
  unavailableReason?: GitHubDeliveryCoverageUnavailableReason;
  sessionLinkScanLimit?: number;
  scannedSessionLinkCount?: number;
  value?: number;
  sessionLinkedPrCount?: number;
  locEnrichedPrCount?: number;
  visiblePromotedPrCount?: number;
  trustedVerifiedPrCount?: number;
  enrichedOrVisiblePrCount?: number;
  excludedCandidateCount?: number;
  writtenCount: number;
  fetchFailureCount: number;
  targetFetchFailureWriteCount: number;
  budgetDeferralCount: number;
  zeroWriteWithSessionLinkedTargets: boolean;
  actionableZeroWriteWithSessionLinkedTargets: boolean;
  timestamp: string;
};
type MetricBaseOverrides = Partial<GitHubDeliveryCoverageMetric> &
  Pick<
    GitHubDeliveryCoverageMetric,
    | "coverageState"
    | "zeroWriteWithSessionLinkedTargets"
    | "actionableZeroWriteWithSessionLinkedTargets"
  >;

type GitHubDeliveryCoverageCountInput = Pick<
  GitHubDeliveryCoverageTickInput,
  "organizationId" | "repositoryId" | "repositoryFullName"
>;

type DeliveryCoverageUnavailableContext = {
  reason: GitHubDeliveryCoverageUnavailableReason;
  sessionLinkScanLimit?: number;
  scannedSessionLinkCount?: number;
};

type DeliveryCoverageReadResult =
  | {
      counts: GitHubDeliveryCoverageCounts;
      scannedSessionLinkCount: number;
    }
  | { unavailable: DeliveryCoverageUnavailableContext };

const deliveryCoveragePullRequestSelect = {
  id: true,
  number: true,
  additions: true,
  deletions: true,
  changedFiles: true,
  isCurrent: true,
  lastVerifiedAt: true,
  repositoryFullName: true,
  repository: { select: { fullName: true } },
  branchArtifact: {
    select: {
      id: true,
      _count: { select: { pullRequestDetails: true } },
    },
  },
} as const satisfies Prisma.PullRequestDetailSelect;

type DeliveryCoveragePullRequestRow = Prisma.PullRequestDetailGetPayload<{
  select: typeof deliveryCoveragePullRequestSelect;
}> &
  SessionLinkedPrDetail;

type DeliveryCoverageTargetCollection = {
  targets: Map<string, DeliveryCoveragePullRequestRow | null>;
  admittedDetailIds: Set<string>;
};

type RepoScopeWhere =
  | { repositoryId: string }
  | { repositoryId: null; repositoryFullName: string };

type DeliveryCoverageCountContext = {
  links: readonly DeliveryCoverageLinkRow[];
  details: readonly DeliveryCoveragePullRequestRow[];
  repositoryFullName: string;
};

/** Emits best-effort PRD-683 delivery-coverage repo-tick telemetry. */
export async function reportGitHubDeliveryCoverageTick(
  input: GitHubDeliveryCoverageTickInput
): Promise<void> {
  try {
    const result = await readGitHubDeliveryCoverage(input);
    if ("unavailable" in result) {
      logDeliveryCoverageUnavailable(input, result.unavailable);
      emitGitHubDeliveryCoverageMetric(
        buildUnavailableMetric(input, result.unavailable)
      );
      return;
    }
    emitGitHubDeliveryCoverageMetric(
      buildMeasuredMetric(input, result.counts, result.scannedSessionLinkCount)
    );
  } catch (error) {
    log.warn(
      `${RECONCILE_LOG_PREFIX} delivery coverage telemetry unavailable`,
      {
        organizationId: input.organizationId,
        repositoryFullName: input.repositoryFullName,
        error: parseError(error),
      }
    );
    emitGitHubDeliveryCoverageMetric(
      buildUnavailableMetric(input, {
        reason: GitHubDeliveryCoverageUnavailableReason.CoverageQueryFailed,
      })
    );
  }
}

export async function readGitHubDeliveryCoverageCounts(
  input: GitHubDeliveryCoverageCountInput
): Promise<GitHubDeliveryCoverageCounts> {
  const result = await readGitHubDeliveryCoverage(input);
  if ("counts" in result) {
    return result.counts;
  }
  throw new Error(
    `Delivery coverage count unavailable: ${result.unavailable.reason}`
  );
}

async function readGitHubDeliveryCoverage(
  input: GitHubDeliveryCoverageCountInput
): Promise<DeliveryCoverageReadResult> {
  const repositoryFullName = normalizeRepoFullName(input.repositoryFullName);
  const detailRepoScope = detailRepoScopeWhere(
    input.repositoryId,
    repositoryFullName
  );
  return await withDb(async (db) => {
    const linkResult = await readDeliveryCoverageLinks(db, {
      organizationId: input.organizationId,
      repositoryId: input.repositoryId,
      repositoryFullName,
    });
    if ("unavailable" in linkResult) {
      return {
        unavailable: coverageUnavailableContext(linkResult.unavailable),
      };
    }
    const links = linkResult.links;
    const branchIds = [...new Set(links.map((link) => link.targetId))];
    const details = await readInIdChunks(branchIds, (chunk) =>
      db.pullRequestDetail.findMany({
        where: {
          organizationId: input.organizationId,
          ...detailRepoScope,
          branchArtifactId: { in: chunk },
        },
        select: deliveryCoveragePullRequestSelect,
      })
    );
    return {
      counts: countDeliveryCoverage({ links, details, repositoryFullName }),
      scannedSessionLinkCount: links.length,
    };
  });
}

function coverageUnavailableContext(
  context: DeliveryCoverageLinkScanUnavailableContext
): DeliveryCoverageUnavailableContext {
  return context;
}

function countDeliveryCoverage(
  context: DeliveryCoverageCountContext
): GitHubDeliveryCoverageCounts {
  const { targets, admittedDetailIds } = collectCoverageTargets(context);
  const fieldCounts = countCoverageFields(targets.values());
  return {
    sessionLinkedPrCount: targets.size,
    ...fieldCounts,
    excludedCandidateCount: countExcludedDetails(
      context.details,
      admittedDetailIds
    ),
  };
}

function collectCoverageTargets(
  context: DeliveryCoverageCountContext
): DeliveryCoverageTargetCollection {
  const targets = new Map<string, DeliveryCoveragePullRequestRow | null>();
  const detailsByBranchId = groupDetailsByBranchId(context.details);
  const pullRequestCountByBranchId = new Map(
    context.details.map((detail) => [
      detail.branchArtifact.id,
      detail.branchArtifact._count.pullRequestDetails,
    ])
  );
  const admissionByBranchId = buildSessionPrAdmissionIndex(
    context.links,
    pullRequestCountByBranchId
  );
  const admittedDetailIds = new Set<string>();
  rememberLinkTargets({
    targets,
    links: context.links,
    detailsByBranchId,
    repositoryFullName: context.repositoryFullName,
  });
  rememberAdmittedDetailTargets({
    targets,
    details: context.details,
    admissionByBranchId,
    admittedDetailIds,
  });
  return { targets, admittedDetailIds };
}

function rememberLinkTargets(input: {
  targets: Map<string, DeliveryCoveragePullRequestRow | null>;
  links: readonly DeliveryCoverageLinkRow[];
  detailsByBranchId: ReadonlyMap<
    string,
    readonly DeliveryCoveragePullRequestRow[]
  >;
  repositoryFullName: string;
}): void {
  for (const link of input.links) {
    const branchDetails = input.detailsByBranchId.get(link.targetId) ?? [];
    const detailsByIdentity = detailIdentityMap(branchDetails);
    for (const identity of linkIdentitiesForRepo(
      link,
      input.repositoryFullName
    )) {
      rememberCoverageTarget(
        input.targets,
        identity,
        detailsByIdentity.get(identity) ?? null
      );
    }
  }
}

function rememberAdmittedDetailTargets(input: {
  targets: Map<string, DeliveryCoveragePullRequestRow | null>;
  details: readonly DeliveryCoveragePullRequestRow[];
  admissionByBranchId: Parameters<typeof sessionLinkedBranches>[1];
  admittedDetailIds: Set<string>;
}): void {
  for (const detail of input.details) {
    if (sessionLinkedBranches(detail, input.admissionByBranchId).length === 0) {
      continue;
    }
    rememberCoverageTarget(
      input.targets,
      detailIdentity(detail) ?? detail.id,
      detail
    );
    input.admittedDetailIds.add(detail.id);
  }
}

function countCoverageFields(
  targets: Iterable<DeliveryCoveragePullRequestRow | null>
): GitHubDeliveryCoverageFieldCounts {
  let locEnrichedPrCount = 0;
  let visiblePromotedPrCount = 0;
  let trustedVerifiedPrCount = 0;
  let enrichedOrVisiblePrCount = 0;
  for (const detail of targets) {
    if (!detail) {
      continue;
    }
    if (hasCompleteDeliveryCoverageLoc(detail)) {
      locEnrichedPrCount += 1;
    }
    if (detail.isCurrent) {
      visiblePromotedPrCount += 1;
    }
    if (detail.lastVerifiedAt !== null) {
      trustedVerifiedPrCount += 1;
    }
    if (isDeliveryCoverageCovered(detail)) {
      enrichedOrVisiblePrCount += 1;
    }
  }
  return {
    locEnrichedPrCount,
    visiblePromotedPrCount,
    trustedVerifiedPrCount,
    enrichedOrVisiblePrCount,
  };
}

function countExcludedDetails(
  details: readonly DeliveryCoveragePullRequestRow[],
  admittedDetailIds: ReadonlySet<string>
): number {
  return details.filter((detail) => !admittedDetailIds.has(detail.id)).length;
}

function groupDetailsByBranchId(
  details: readonly DeliveryCoveragePullRequestRow[]
): Map<string, DeliveryCoveragePullRequestRow[]> {
  const byBranchId = new Map<string, DeliveryCoveragePullRequestRow[]>();
  for (const detail of details) {
    const existing = byBranchId.get(detail.branchArtifact.id) ?? [];
    existing.push(detail);
    byBranchId.set(detail.branchArtifact.id, existing);
  }
  return byBranchId;
}

function detailIdentityMap(
  details: readonly DeliveryCoveragePullRequestRow[]
): Map<string, DeliveryCoveragePullRequestRow> {
  const byIdentity = new Map<string, DeliveryCoveragePullRequestRow>();
  for (const detail of details) {
    const identity = detailIdentity(detail);
    if (identity) {
      byIdentity.set(identity, detail);
    }
  }
  return byIdentity;
}

function linkIdentitiesForRepo(
  link: DeliveryCoverageLinkRow,
  repositoryFullName: string
): string[] {
  return commandDerivedSessionPrRefsFromMetadata(link.metadata)
    .filter(
      (ref) =>
        normalizeRepoFullName(ref.repositoryFullName) === repositoryFullName
    )
    .map((ref) => sessionPrIdentityKey(ref.repositoryFullName, ref.prNumber));
}

function detailIdentity(
  detail: Pick<
    SessionLinkedPrDetail,
    "number" | "repository" | "repositoryFullName"
  >
): string | null {
  const repositoryFullName =
    detail.repository?.fullName ?? detail.repositoryFullName ?? null;
  return repositoryFullName && detail.number !== null
    ? sessionPrIdentityKey(repositoryFullName, detail.number)
    : null;
}

function rememberCoverageTarget(
  targets: Map<string, DeliveryCoveragePullRequestRow | null>,
  identity: string,
  detail: DeliveryCoveragePullRequestRow | null
): void {
  if (!targets.has(identity)) {
    targets.set(identity, detail);
    return;
  }
  const existing = targets.get(identity);
  if (detail !== null && existing === null) {
    targets.set(identity, detail);
  }
}

function buildMeasuredMetric(
  input: GitHubDeliveryCoverageTickInput,
  counts: GitHubDeliveryCoverageCounts,
  scannedSessionLinkCount: number
): GitHubDeliveryCoverageMetric {
  const coverageState =
    counts.sessionLinkedPrCount > 0
      ? GitHubDeliveryCoverageState.Measured
      : GitHubDeliveryCoverageState.NoSessionLinkedTargets;
  const coverageRatio =
    counts.sessionLinkedPrCount > 0
      ? counts.enrichedOrVisiblePrCount / counts.sessionLinkedPrCount
      : undefined;
  const zeroWriteWithSessionLinkedTargets =
    input.writtenCount === 0 && counts.sessionLinkedPrCount > 0;
  return metricBase(input, {
    coverageState,
    ...(coverageRatio === undefined ? {} : { value: coverageRatio }),
    sessionLinkScanLimit: GITHUB_DELIVERY_COVERAGE_LINK_SCAN_LIMIT,
    scannedSessionLinkCount,
    sessionLinkedPrCount: counts.sessionLinkedPrCount,
    locEnrichedPrCount: counts.locEnrichedPrCount,
    visiblePromotedPrCount: counts.visiblePromotedPrCount,
    trustedVerifiedPrCount: counts.trustedVerifiedPrCount,
    enrichedOrVisiblePrCount: counts.enrichedOrVisiblePrCount,
    excludedCandidateCount: counts.excludedCandidateCount,
    zeroWriteWithSessionLinkedTargets,
    actionableZeroWriteWithSessionLinkedTargets:
      zeroWriteWithSessionLinkedTargets && isZeroWriteActionable(input, counts),
  });
}

function buildUnavailableMetric(
  input: GitHubDeliveryCoverageTickInput,
  context: DeliveryCoverageUnavailableContext
): GitHubDeliveryCoverageMetric {
  return metricBase(input, {
    coverageState: GitHubDeliveryCoverageState.Unavailable,
    unavailableReason: context.reason,
    ...(context.sessionLinkScanLimit === undefined
      ? {}
      : { sessionLinkScanLimit: context.sessionLinkScanLimit }),
    ...(context.scannedSessionLinkCount === undefined
      ? {}
      : { scannedSessionLinkCount: context.scannedSessionLinkCount }),
    zeroWriteWithSessionLinkedTargets: false,
    actionableZeroWriteWithSessionLinkedTargets: false,
  });
}

function logDeliveryCoverageUnavailable(
  input: GitHubDeliveryCoverageTickInput,
  context: DeliveryCoverageUnavailableContext
): void {
  log.warn(`${RECONCILE_LOG_PREFIX} delivery coverage telemetry unavailable`, {
    organizationId: input.organizationId,
    repositoryFullName: input.repositoryFullName,
    unavailableReason: context.reason,
    ...(context.sessionLinkScanLimit === undefined
      ? {}
      : { sessionLinkScanLimit: context.sessionLinkScanLimit }),
    ...(context.scannedSessionLinkCount === undefined
      ? {}
      : { scannedSessionLinkCount: context.scannedSessionLinkCount }),
  });
}

function metricBase(
  input: GitHubDeliveryCoverageTickInput,
  overrides: MetricBaseOverrides
): GitHubDeliveryCoverageMetric {
  return {
    metric: FilterToken.GitHubDeliveryCoverageRepoTick,
    origin: ORIGIN,
    syncLane: GITHUB_DELIVERY_COVERAGE_SYNC_LANE,
    organizationId: input.organizationId,
    repositoryFullName: normalizeRepoFullName(input.repositoryFullName),
    ...(input.repositoryId ? { repositoryId: input.repositoryId } : {}),
    ...(input.tier === undefined ? {} : { syncTier: input.tier }),
    reconcileOutcome: input.status,
    ...(input.deferredReason === null
      ? {}
      : { deferredReason: input.deferredReason }),
    ...(input.resultReason === undefined
      ? {}
      : { resultReason: input.resultReason }),
    writtenCount: input.writtenCount,
    fetchFailureCount: input.fetchFailureCount,
    targetFetchFailureWriteCount: input.targetFetchFailureWriteCount,
    budgetDeferralCount: input.budgetDeferralCount,
    timestamp: input.now.toISOString(),
    ...overrides,
  };
}

function detailRepoScopeWhere(
  repositoryId: string | null,
  repositoryFullName: string
): RepoScopeWhere {
  return repositoryId
    ? { repositoryId }
    : { repositoryId: null, repositoryFullName };
}

function emitGitHubDeliveryCoverageMetric(
  metric: GitHubDeliveryCoverageMetric
): void {
  try {
    emitTelemetryMetric<GitHubDeliveryCoverageMetric>(metric);
  } catch {
    // Best-effort telemetry only; there is no secondary sink safer than log.
  }
}

// ISS-12033: a deferral is not a failed sweep. Contention is timing-only
// (GitHubAccessDenialReason.Contention) and never pages; a budget deferral, like
// a sweep, pages only while coverage is incomplete.
function isZeroWriteActionable(
  input: GitHubDeliveryCoverageTickInput,
  counts: GitHubDeliveryCoverageCounts
): boolean {
  const coverageIncomplete =
    counts.enrichedOrVisiblePrCount < counts.sessionLinkedPrCount;
  switch (input.deferredReason) {
    case null:
      return input.status !== ReconcileRepoStatus.Swept || coverageIncomplete;
    case GitHubRepoSyncDeferralReason.Budget:
      return coverageIncomplete;
    case GitHubRepoSyncDeferralReason.Contention:
      return false;
    default: {
      const exhaustive: never = input.deferredReason;
      return exhaustive;
    }
  }
}
