import { randomUUID } from "node:crypto";
import {
  BranchBaseBranchSource,
  BranchFileCacheStatus,
  BranchHeadShaSource,
  type BranchPushSource,
  BranchSyncStatus,
  LinkType,
} from "@repo/api/src/types/artifact";
import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import {
  GitHubPRState,
  type GitHubPRState as GitHubPRStateValue,
} from "@repo/api/src/types/github";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import {
  type Artifact,
  ArtifactSubtype,
  ArtifactType,
  type BranchDetail,
  ChecksStatus,
  type Prisma,
  type PullRequestDetail,
  type TransactionClient,
  withDb,
} from "@repo/database";
import { parseStoredSnapshot } from "@/app/documents/repository-snapshot-helpers";
import { invalidateBranchStatusChecksForHeadChange } from "@/lib/branch-status-checks";
import { getPrismaErrorCode } from "@/lib/db-utils";
import {
  type GitHubFetchProvenance,
  gitHubFetchProvenanceData,
} from "@/lib/github-fetch-provenance";
import { isUuid } from "@/lib/identifier-utils";
import { bumpBranchActivity, stampBranchFirstPush } from "./branch-push-state";
import { adoptRepolessPullRequestDetail } from "./github-projection-writer";
import { pullRequestLocData } from "./pull-request-loc-data";

type BranchDetailWithCurrentPr = BranchDetail & {
  currentPullRequestDetail: PullRequestDetail | null;
};

export type BranchArtifactWithDetail = Artifact & {
  branch: BranchDetailWithCurrentPr | null;
  pullRequest: PullRequestDetail | null;
};

export type UpsertBranchPullRequestInput = {
  githubId: string;
  number: number;
  title: string;
  htmlUrl: string;
  body?: string | null;
  state: GitHubPRStateValue;
  isDraft?: boolean;
  additions?: number | null;
  deletions?: number | null;
  changedFiles?: number | null;
  closedAt?: Date | null;
  mergedAt?: Date | null;
  mergeCommitSha?: string | null;
};

export type UpsertBranchArtifactInput = {
  organizationId: string;
  /**
   * Installation-repo surrogate id — optional enrichment (PRD-510 D2). App-repo
   * producers (webhook, loop, PR) pass it; the desktop producer omits it for
   * non-App branches. Branch identity keys on the org + normalized full name.
   */
  repositoryId?: string | null;
  repositoryFullName: string;
  branchName: string;
  defaultBranch?: string | null;
  projectId: string | null;
  createdById?: string | null;
  baseBranch?: string | null;
  baseBranchSource?: BranchBaseBranchSource | null;
  headSha?: string | null;
  headShaSource?: BranchHeadShaSource | null;
  headShaObservedAt?: Date | null;
  beforeSha?: string | null;
  /**
   * Explicit push evidence (PRD-510 FR2 / PLN-1099 Phase 2). When a producer has
   * verified the branch was pushed to its remote (a GitHub push/PR webhook, or a
   * C1-verified in-session push), it stamps `firstPushedAt` + `pushSource`. The
   * service applies these set-once/earliest-wins and NEVER derives them from
   * `headShaSource` or row existence. Absent (undefined/null) leaves any existing
   * push state untouched — an observation-only sync never clears it.
   */
  firstPushedAt?: Date | null;
  pushSource?: BranchPushSource | null;
  /**
   * GitHub push-created signal. Tombstoned branches use this with a zero
   * `beforeSha` to distinguish a real ref recreation from stale redelivery.
   */
  isCreate?: boolean;
  isDelete?: boolean;
  deletedAt?: Date | null;
  sourceArtifactId?: string | null;
  /**
   * Internal supplementary source-artifact repo authorization. Only
   * `createLoopBranchArtifact` may derive this after authenticated loop lookup,
   * `findAllowedLoopRepo`, and active repository lookup. Public request bodies,
   * webhooks, Electron, claude-plugins, and relay payloads must not provide it.
   */
  sourceArtifactTargetRepoAuthorization?: SourceArtifactTargetRepoAuthorization;
  pullRequest?: UpsertBranchPullRequestInput | null;
  fetchProvenance?: GitHubFetchProvenance;
};

export type HeadTransitionState = {
  headSha: string | null;
  headShaSource: BranchHeadShaSource | null;
  headShaObservedAt: Date | null;
  lastPushBeforeSha: string | null;
  deletedAt?: Date | null;
};

export type HeadTransitionResult = HeadTransitionState & {
  accepted: boolean;
  reason:
    | "no_head_input"
    | "first_observation"
    | "push_confirmed"
    | "sequential_push"
    | "duplicate_push"
    | "recreated_after_delete"
    | "stale_push"
    | "duplicate_harness_input"
    | "authoritative_refresh";
};

export const SourceArtifactTargetRepoAuthorizationProvenance = {
  LoopBranchArtifactCallback: "loop_branch_artifact_callback",
} as const;

export type SourceArtifactTargetRepoAuthorizationProvenance =
  (typeof SourceArtifactTargetRepoAuthorizationProvenance)[keyof typeof SourceArtifactTargetRepoAuthorizationProvenance];

export type SourceArtifactTargetRepoAuthorization = {
  provenance: SourceArtifactTargetRepoAuthorizationProvenance;
  repositoryFullNames: readonly string[];
};

const baseBranchSourcePriority: Record<BranchBaseBranchSource, number> = {
  [BranchBaseBranchSource.PullRequestBase]: 50,
  [BranchBaseBranchSource.HarnessInput]: 40,
  [BranchBaseBranchSource.McpInput]: 30,
  [BranchBaseBranchSource.MigrationPrBase]: 20,
  [BranchBaseBranchSource.RepositoryDefault]: 10,
};

const branchInclude = {
  branch: { include: { currentPullRequestDetail: true } },
  pullRequest: true,
} as const;

function parseBranchBaseBranchSource(
  value: string | null
): BranchBaseBranchSource | null {
  switch (value) {
    case BranchBaseBranchSource.PullRequestBase:
      return BranchBaseBranchSource.PullRequestBase;
    case BranchBaseBranchSource.HarnessInput:
      return BranchBaseBranchSource.HarnessInput;
    case BranchBaseBranchSource.McpInput:
      return BranchBaseBranchSource.McpInput;
    case BranchBaseBranchSource.MigrationPrBase:
      return BranchBaseBranchSource.MigrationPrBase;
    case BranchBaseBranchSource.RepositoryDefault:
      return BranchBaseBranchSource.RepositoryDefault;
    default:
      return null;
  }
}

function parseBranchHeadShaSource(
  value: string | null
): BranchHeadShaSource | null {
  switch (value) {
    case BranchHeadShaSource.PushWebhook:
      return BranchHeadShaSource.PushWebhook;
    case BranchHeadShaSource.PullRequestWebhook:
      return BranchHeadShaSource.PullRequestWebhook;
    case BranchHeadShaSource.HarnessInput:
      return BranchHeadShaSource.HarnessInput;
    case BranchHeadShaSource.McpInput:
      return BranchHeadShaSource.McpInput;
    case BranchHeadShaSource.ExplicitSync:
      return BranchHeadShaSource.ExplicitSync;
    case BranchHeadShaSource.MigrationPrHead:
      return BranchHeadShaSource.MigrationPrHead;
    default:
      return null;
  }
}

function parseGitHubPRState(value: string | null | undefined) {
  switch (value) {
    case GitHubPRState.Open:
      return GitHubPRState.Open;
    case GitHubPRState.Merged:
      return GitHubPRState.Merged;
    case GitHubPRState.Closed:
      return GitHubPRState.Closed;
    default:
      return null;
  }
}

/**
 * Maps branch, PR, and delete state to the parent artifact status without
 * changing cache state or mutating input.
 */
export function decideBranchStatus(input: {
  isDelete?: boolean;
  pullRequestState?: GitHubPRStateValue | null;
  currentStatus?: string | null;
}): GitHubPRStateValue {
  if (input.pullRequestState) {
    return input.pullRequestState;
  }
  if (input.isDelete) {
    return parseGitHubPRState(input.currentStatus) === GitHubPRState.Merged
      ? GitHubPRState.Merged
      : GitHubPRState.Closed;
  }
  return parseGitHubPRState(input.currentStatus) ?? GitHubPRState.Open;
}

/**
 * Applies base-branch source priority. Lower-priority observations cannot
 * overwrite stronger provenance already stored for the branch.
 */
export function resolveBaseProvenance(
  input: {
    baseBranch?: string | null;
    baseBranchSource?: BranchBaseBranchSource | null;
  },
  existing: {
    baseBranch: string | null;
    baseBranchSource: BranchBaseBranchSource | null;
  } | null
): {
  baseBranch: string | null;
  baseBranchSource: BranchBaseBranchSource | null;
} {
  if (!(input.baseBranch && input.baseBranchSource)) {
    return {
      baseBranch: existing?.baseBranch ?? null,
      baseBranchSource: existing?.baseBranchSource ?? null,
    };
  }

  const existingSource = existing?.baseBranchSource ?? null;
  if (
    existingSource &&
    baseBranchSourcePriority[existingSource] >
      baseBranchSourcePriority[input.baseBranchSource]
  ) {
    return {
      baseBranch: existing?.baseBranch ?? null,
      baseBranchSource: existingSource,
    };
  }

  return {
    baseBranch: input.baseBranch,
    baseBranchSource: input.baseBranchSource,
  };
}

/**
 * Applies the `lastPushBeforeSha` lifecycle. Push observations must be first,
 * sequential, or exact duplicate; stale pushes are rejected without clobbering
 * stored head or predecessor state. Non-push observations are authoritative
 * refreshes and clear stale push predecessor state. Harness callbacks are
 * idempotent when exact duplicates, but a new harness head is still accepted:
 * the loop materialization callback is the API acknowledgement of a branch
 * Desktop just pushed.
 */
export function applyHeadTransition(
  input: {
    headSha?: string | null;
    headShaSource?: BranchHeadShaSource | null;
    beforeSha?: string | null;
    observedAt?: Date | null;
    isCreate?: boolean;
  },
  existing: HeadTransitionState | null
): HeadTransitionResult {
  const current = existing ?? {
    headSha: null,
    headShaSource: null,
    headShaObservedAt: null,
    lastPushBeforeSha: null,
  };
  if (!input.headSha) {
    return { ...current, accepted: true, reason: "no_head_input" };
  }

  const observedAt = input.observedAt ?? new Date();
  if (isAcceptedGitHubRecreate(input, current)) {
    return {
      headSha: input.headSha,
      headShaSource: BranchHeadShaSource.PushWebhook,
      headShaObservedAt: observedAt,
      lastPushBeforeSha: input.beforeSha ?? null,
      accepted: true,
      reason: "recreated_after_delete",
    };
  }
  if (isStaleGitHubRecreate(input, current)) {
    return { ...current, accepted: false, reason: "stale_push" };
  }

  if (
    input.headShaSource === BranchHeadShaSource.HarnessInput &&
    current.headSha &&
    current.headSha === input.headSha
  ) {
    return { ...current, accepted: true, reason: "duplicate_harness_input" };
  }
  if (input.headShaSource !== BranchHeadShaSource.PushWebhook) {
    return {
      headSha: input.headSha,
      headShaSource: input.headShaSource ?? BranchHeadShaSource.ExplicitSync,
      headShaObservedAt: observedAt,
      lastPushBeforeSha: null,
      accepted: true,
      reason: "authoritative_refresh",
    };
  }

  if (!current.headSha) {
    return {
      headSha: input.headSha,
      headShaSource: BranchHeadShaSource.PushWebhook,
      headShaObservedAt: observedAt,
      lastPushBeforeSha: input.beforeSha ?? null,
      accepted: true,
      reason: "first_observation",
    };
  }

  if (
    current.headSha === input.headSha &&
    current.lastPushBeforeSha === (input.beforeSha ?? null)
  ) {
    return { ...current, accepted: true, reason: "duplicate_push" };
  }

  if (
    !current.deletedAt &&
    current.headSha === input.headSha &&
    current.headShaSource !== BranchHeadShaSource.PushWebhook
  ) {
    const confirmedObservedAt = latestDate(
      current.headShaObservedAt,
      observedAt
    );
    return {
      headSha: input.headSha,
      headShaSource: BranchHeadShaSource.PushWebhook,
      headShaObservedAt: confirmedObservedAt,
      lastPushBeforeSha: input.beforeSha ?? null,
      accepted: true,
      reason: "push_confirmed",
    };
  }

  if (current.headSha === input.beforeSha) {
    return {
      headSha: input.headSha,
      headShaSource: BranchHeadShaSource.PushWebhook,
      headShaObservedAt: observedAt,
      lastPushBeforeSha: input.beforeSha ?? null,
      accepted: true,
      reason: "sequential_push",
    };
  }

  return { ...current, accepted: false, reason: "stale_push" };
}

/**
 * Applies branch-delete state without forcing a file-cache refresh.
 */
export function applyDeleteTransition(input: {
  isDelete?: boolean;
  deletedAt?: Date | null;
  currentStatus?: string | null;
  beforeSha?: string | null;
  currentHeadSha?: string | null;
  currentHeadShaObservedAt?: Date | null;
}): { deletedAt: Date | null; status: GitHubPRStateValue } | null {
  if (!input.isDelete) {
    return null;
  }
  const deletedAt = input.deletedAt ?? new Date();
  if (isStaleGitHubDelete(input, deletedAt)) {
    return null;
  }
  return {
    deletedAt,
    status:
      parseGitHubPRState(input.currentStatus) === GitHubPRState.Merged
        ? GitHubPRState.Merged
        : GitHubPRState.Closed,
  };
}

/**
 * Initial scheduling state for background file-cache refresh. The actual
 * compare/fetch replacement is owned by the explicit sync/cache service.
 */
export function scheduleFileChangeCacheRefresh(input: {
  isDelete?: boolean;
  headTransition: HeadTransitionResult;
}): { shouldSchedule: boolean; fileCacheStatus?: BranchFileCacheStatus } {
  if (input.headTransition.reason === "duplicate_harness_input") {
    return { shouldSchedule: false };
  }
  if (
    input.isDelete ||
    !input.headTransition.accepted ||
    !input.headTransition.headSha ||
    input.headTransition.headShaSource !== BranchHeadShaSource.PushWebhook
  ) {
    return { shouldSchedule: false };
  }
  return {
    shouldSchedule: true,
    fileCacheStatus: BranchFileCacheStatus.Scheduled,
  };
}

function buildBranchTreeUrl(repositoryFullName: string, branchName: string) {
  return `https://github.com/${repositoryFullName}/tree/${encodeURIComponent(
    branchName
  )}`;
}

async function validateSourceArtifact(
  tx: TransactionClient,
  input: UpsertBranchArtifactInput
): Promise<Result<null, StatusCode>> {
  if (!input.sourceArtifactId) {
    return Result.ok(null);
  }
  const sourceArtifactBaseWhere: Prisma.ArtifactWhereInput = {
    id: input.sourceArtifactId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    type: ArtifactType.DOCUMENT,
    subtype: {
      in: [
        ArtifactSubtype.PRD,
        ArtifactSubtype.IMPLEMENTATION_PLAN,
        ArtifactSubtype.FEATURE,
      ],
    },
  };
  const source = await tx.artifact.findFirst({
    where: sourceArtifactBaseWhere,
    select: { document: { select: { repositorySnapshot: true } } },
  });
  if (!source) {
    return Result.err(Status.Forbidden);
  }
  // PLN-602: replace the legacy `targetRepo` column gate with a snapshot check.
  // A source with an empty snapshot has no repo constraint (analogous to the
  // old NULL case); otherwise the requested repo must appear in the snapshot.
  const snapshot = parseStoredSnapshot(source.document?.repositorySnapshot);
  if (!snapshot || snapshot.repositories.length === 0) {
    return Result.ok(null);
  }
  const allowed = snapshot.repositories.some(
    (repo: { fullName: string }) => repo.fullName === input.repositoryFullName
  );
  if (allowed || hasSupplementarySourceRepoAuthorization(input)) {
    return Result.ok(null);
  }
  return Result.err(Status.Forbidden);
}

/**
 * Set-once / earliest-wins merge for explicit branch push evidence (PRD-510 FR2,
 * PLN-1099 Phase 2). Returns the `firstPushedAt`/`pushSource` columns to write,
 * or `null` for a no-op.
 *
 * Decoupled from `applyHeadTransition` by design: push state is NEVER inferred
 * from the volatile `headShaSource` (the `stale_push` trap) or from row
 * existence — a synced row means "observed", not "pushed" (PRD-510 D3). An
 * observation-only delivery (no `firstPushedAt`) never clears existing state,
 * and a later push never overwrites an earlier stamp, so out-of-order webhook /
 * session deliveries converge on the single earliest verified push.
 *
 * Note this only writes on the accepted create/update path. That is safe: a
 * head transition is rejected (`stale_push`) only when a prior push chain
 * already exists, which means an earlier accepted push already stamped
 * `firstPushedAt`; earliest-wins then makes the rejected redelivery a no-op.
 */
function resolvePushState(
  input: Pick<UpsertBranchArtifactInput, "firstPushedAt" | "pushSource">,
  existing: { firstPushedAt: Date | null; pushSource: string | null } | null
): { firstPushedAt: Date; pushSource: string | null } | null {
  const incoming = input.firstPushedAt;
  if (!incoming) {
    return null;
  }
  if (existing?.firstPushedAt && existing.firstPushedAt <= incoming) {
    return null;
  }
  return {
    firstPushedAt: incoming,
    pushSource: input.pushSource ?? existing?.pushSource ?? null,
  };
}

function buildBranchCreateData(
  input: UpsertBranchArtifactInput,
  headTransition: HeadTransitionResult,
  base: {
    baseBranch: string | null;
    baseBranchSource: BranchBaseBranchSource | null;
  },
  fileCacheStatus: BranchFileCacheStatus,
  status: GitHubPRStateValue,
  deletedAt: Date | null
): Prisma.ArtifactUncheckedCreateInput {
  return {
    type: ArtifactType.BRANCH,
    organizationId: input.organizationId,
    projectId: input.projectId,
    createdById: input.createdById ?? null,
    name: input.branchName,
    status,
    externalUrl: buildBranchTreeUrl(input.repositoryFullName, input.branchName),
    branch: {
      create: {
        // FR13: BranchDetail.organizationId is a write-once copy of the parent
        // Artifact.organizationId — both come from input.organizationId here, so
        // they match by construction (the invariant test guards drift).
        organizationId: input.organizationId,
        repositoryId: input.repositoryId,
        repositoryFullName: normalizeRepoFullName(input.repositoryFullName),
        branchName: input.branchName,
        baseBranch: base.baseBranch,
        baseBranchSource: base.baseBranchSource,
        headSha: headTransition.headSha,
        headShaSource: headTransition.headShaSource,
        headShaObservedAt: headTransition.headShaObservedAt,
        // PLN-1034: a freshly observed branch is active as of the push that
        // surfaced it. Null (branch created without a head) leaves readers to
        // fall back to the artifact's createdAt.
        lastActivityAt: headTransition.headShaObservedAt,
        lastPushBeforeSha: headTransition.lastPushBeforeSha,
        // PRD-510 FR2 / Phase 2: explicit push evidence, if the producer supplied
        // it. On create there is no prior state, so a producer-supplied push is
        // the earliest by definition (observation-only creates leave both null).
        ...(resolvePushState(input, null) ?? {}),
        deletedAt,
        checksStatus: ChecksStatus.UNKNOWN,
        fileCacheStatus,
        syncStatus: BranchSyncStatus.Idle,
        ...gitHubFetchProvenanceData(input.fetchProvenance),
      },
    },
  };
}

async function upsertCurrentPullRequestDetail(
  tx: TransactionClient,
  artifactId: string,
  organizationId: string,
  repositoryId: string,
  input: UpsertBranchPullRequestInput,
  fetchProvenance: GitHubFetchProvenance | undefined
) {
  const detailId = randomUUID();
  const provenance = gitHubFetchProvenanceData(fetchProvenance);
  // FEA-2732: adopt any desktop-produced repo-less row for this branch+number
  // (fills repositoryId + githubId) so the githubId-keyed upsert below updates
  // that same row instead of inserting a duplicate.
  await adoptRepolessPullRequestDetail(tx, {
    branchArtifactId: artifactId,
    number: input.number,
    repositoryId,
    githubId: input.githubId,
  });
  const detail = await tx.pullRequestDetail.upsert({
    where: { githubId: input.githubId },
    create: {
      id: detailId,
      branchArtifactId: artifactId,
      // FEA-2732: write-once org SSOT copy (NOT NULL) — see PullRequestDetail.
      organizationId,
      repositoryId,
      githubId: input.githubId,
      number: input.number,
      title: input.title,
      htmlUrl: input.htmlUrl,
      body: input.body ?? null,
      prState: input.state,
      isDraft: input.isDraft ?? false,
      ...pullRequestLocData(input),
      isCurrent: true,
      closedAt: input.closedAt ?? null,
      mergedAt: input.mergedAt ?? null,
      mergeCommitSha: input.mergeCommitSha ?? null,
      ...provenance,
    },
    update: {
      branchArtifactId: artifactId,
      title: input.title,
      htmlUrl: input.htmlUrl,
      body: input.body ?? null,
      prState: input.state,
      isDraft: input.isDraft ?? false,
      ...pullRequestLocData(input),
      isCurrent: true,
      closedAt: input.closedAt ?? null,
      mergedAt: input.mergedAt ?? null,
      mergeCommitSha: input.mergeCommitSha ?? null,
      ...provenance,
    },
    select: { id: true },
  });
  await tx.pullRequestDetail.updateMany({
    where: {
      branchArtifactId: artifactId,
      isCurrent: true,
      id: { not: detail.id },
    },
    data: { isCurrent: false },
  });
  await tx.branchDetail.update({
    where: { artifactId },
    data: { currentPullRequestDetailId: detail.id },
  });
}

async function createBranchArtifact(
  tx: TransactionClient,
  input: UpsertBranchArtifactInput
): Promise<Result<BranchArtifactWithDetail, StatusCode>> {
  const base = resolveBaseProvenance(
    {
      baseBranch: input.baseBranch,
      baseBranchSource: input.baseBranchSource,
    },
    null
  );
  const headTransition = applyHeadTransition(
    {
      headSha: input.headSha,
      headShaSource: input.headShaSource,
      beforeSha: input.beforeSha,
      observedAt: input.headShaObservedAt,
      isCreate: input.isCreate,
    },
    null
  );
  const status = decideBranchStatus({
    isDelete: input.isDelete,
    pullRequestState: input.pullRequest?.state ?? null,
  });
  const deleteTransition = applyDeleteTransition({
    isDelete: input.isDelete,
    deletedAt: input.deletedAt,
    currentStatus: status,
    beforeSha: input.beforeSha,
  });
  const cacheSchedule = scheduleFileChangeCacheRefresh({
    isDelete: input.isDelete,
    headTransition,
  });
  const created = await tx.artifact.create({
    data: buildBranchCreateData(
      input,
      headTransition,
      base,
      cacheSchedule.fileCacheStatus ?? BranchFileCacheStatus.Absent,
      deleteTransition?.status ?? status,
      deleteTransition?.deletedAt ?? null
    ),
    include: branchInclude,
  });
  // A PullRequestDetail requires a (non-null) installation repo — PRs only exist
  // for App repos, which always carry repositoryId. Desktop non-App branches
  // arrive without a PR, so this simply doesn't run for them.
  if (input.pullRequest && input.repositoryId) {
    await upsertCurrentPullRequestDetail(
      tx,
      created.id,
      input.organizationId,
      input.repositoryId,
      input.pullRequest,
      input.fetchProvenance
    );
  }
  return rereadBranchArtifact(tx, created.id);
}

async function updateBranchArtifact(
  tx: TransactionClient,
  artifactId: string,
  input: UpsertBranchArtifactInput,
  existing: BranchDetail,
  currentArtifact: { createdById: string | null; status: string | null }
): Promise<Result<BranchArtifactWithDetail, StatusCode>> {
  // PRD-510 FR2 / PLN-1099 Phase 2: apply explicit push evidence with the atomic,
  // DB-guarded earliest-wins stamp — NOT an app-computed read-then-write, which
  // under READ COMMITTED lets two concurrent/redelivered pushes both read the
  // same stale row and clobber the earlier timestamp. Running it before the
  // head-transition gate below means a push rejected as `stale_push` (an
  // out-of-order — therefore earlier — push) still contributes its verified
  // timestamp; the guard keeps the earliest either way.
  if (input.firstPushedAt && input.pushSource) {
    await stampBranchFirstPush(
      tx,
      artifactId,
      input.firstPushedAt,
      input.pushSource
    );
  }
  const base = resolveBaseProvenance(
    {
      baseBranch: input.baseBranch,
      baseBranchSource: input.baseBranchSource,
    },
    {
      baseBranch: existing.baseBranch,
      baseBranchSource: parseBranchBaseBranchSource(existing.baseBranchSource),
    }
  );
  const headTransition = applyHeadTransition(
    {
      headSha: input.headSha,
      headShaSource: input.headShaSource,
      beforeSha: input.beforeSha,
      observedAt: input.headShaObservedAt,
      isCreate: input.isCreate,
    },
    {
      headSha: existing.headSha,
      headShaSource: parseBranchHeadShaSource(existing.headShaSource),
      headShaObservedAt: existing.headShaObservedAt,
      lastPushBeforeSha: existing.lastPushBeforeSha,
      deletedAt: existing.deletedAt,
    }
  );
  if (!headTransition.accepted) {
    return Result.err(Status.Conflict);
  }

  const deleteTransition = applyDeleteTransition({
    isDelete: input.isDelete,
    deletedAt: input.deletedAt,
    currentStatus: currentArtifact.status,
    beforeSha: input.beforeSha,
    currentHeadSha: existing.headSha,
    currentHeadShaObservedAt: existing.headShaObservedAt,
  });
  if (input.isDelete && !deleteTransition) {
    return Result.err(Status.Conflict);
  }
  const cacheSchedule = scheduleFileChangeCacheRefresh({
    isDelete: input.isDelete,
    headTransition,
  });
  const shouldClearDeletedAt =
    headTransition.reason === "recreated_after_delete";
  const status = resolveUpdateBranchStatus({
    deleteTransition,
    shouldClearDeletedAt,
    pullRequestState: input.pullRequest?.state ?? null,
    currentStatus: currentArtifact.status,
  });

  await tx.artifact.update({
    where: { id: artifactId },
    data: {
      name: input.branchName,
      status,
      externalUrl: buildBranchTreeUrl(
        input.repositoryFullName,
        input.branchName
      ),
      projectId: input.projectId,
      ...(input.createdById && !currentArtifact.createdById
        ? { createdById: input.createdById }
        : {}),
    },
  });
  await tx.branchDetail.update({
    where: { artifactId },
    data: {
      baseBranch: base.baseBranch,
      baseBranchSource: base.baseBranchSource,
      headSha: headTransition.headSha,
      headShaSource: headTransition.headShaSource,
      headShaObservedAt: headTransition.headShaObservedAt,
      lastPushBeforeSha: headTransition.lastPushBeforeSha,
      deletedAt: resolveDeletedAtUpdate(deleteTransition, shouldClearDeletedAt),
      // PRD-510 D2/FR8: a branch first surfaced by the desktop producer is
      // created with repositoryId=null (non-App at first sight). When a later
      // App/webhook producer resolves the same D2 key WITH a concrete
      // installation-repo id, adopt it — upgrade only, never clear (identity
      // keys on the normalized full name, not this enrichment id).
      ...(input.repositoryId ? { repositoryId: input.repositoryId } : {}),
      ...gitHubFetchProvenanceData(input.fetchProvenance),
      ...(cacheSchedule.fileCacheStatus
        ? { fileCacheStatus: cacheSchedule.fileCacheStatus }
        : {}),
    },
  });
  if (existing.headSha !== headTransition.headSha) {
    await invalidateBranchStatusChecksForHeadChange(tx, artifactId);
    // PLN-1034: a new head SHA means a commit was pushed — genuine activity.
    // Monotonic so a re-delivered/stale push can't regress the timestamp.
    await bumpBranchActivity(tx, artifactId, headTransition.headShaObservedAt);
  } else if (
    shouldClearDeletedAt ||
    headTransition.reason === "push_confirmed"
  ) {
    // Recreating a deleted ref is genuine branch activity even when GitHub
    // recreates it at the same SHA. Same-SHA push confirmation is also genuine
    // remote activity for a previously local-only branch.
    await bumpBranchActivity(tx, artifactId, headTransition.headShaObservedAt);
  }
  // See the create path: PR detail requires a non-null installation repo.
  if (input.pullRequest && input.repositoryId) {
    await upsertCurrentPullRequestDetail(
      tx,
      artifactId,
      input.organizationId,
      input.repositoryId,
      input.pullRequest,
      input.fetchProvenance
    );
  }
  return rereadBranchArtifact(tx, artifactId);
}

async function rereadBranchArtifact(
  tx: TransactionClient,
  artifactId: string
): Promise<Result<BranchArtifactWithDetail, StatusCode>> {
  const artifact = await tx.artifact.findUnique({
    where: { id: artifactId },
    include: branchInclude,
  });
  return artifact
    ? Result.ok({
        ...artifact,
        pullRequest:
          artifact.pullRequest ??
          artifact.branch?.currentPullRequestDetail ??
          null,
      })
    : Result.err(Status.NotFound);
}

async function linkSourceIfRequested(
  tx: TransactionClient,
  input: UpsertBranchArtifactInput,
  branchArtifactId: string
) {
  if (!input.sourceArtifactId) {
    return;
  }
  await tx.artifactLink.upsert({
    where: {
      sourceId_targetId_linkType: {
        sourceId: input.sourceArtifactId,
        targetId: branchArtifactId,
        linkType: LinkType.Produces,
      },
    },
    create: {
      organizationId: input.organizationId,
      sourceId: input.sourceArtifactId,
      targetId: branchArtifactId,
      linkType: LinkType.Produces,
    },
    update: {},
  });
}

/**
 * Creates or updates a BRANCH artifact by the PRD-510 D2 identity key
 * `(organizationId, normalized repositoryFullName, branchName)` — uniform across
 * the desktop-sync and GitHub-webhook producers, independent of GitHub App
 * installation. Optional PR data is stored as current PR detail on the branch
 * artifact for compatibility while the destructive cutover is still pending.
 */
async function upsertBranchArtifact(
  input: UpsertBranchArtifactInput
): Promise<Result<BranchArtifactWithDetail, StatusCode>> {
  try {
    return await upsertBranchArtifactOnce(input);
  } catch (error) {
    if (getPrismaErrorCode(error) !== "P2002") {
      throw error;
    }
    return upsertBranchArtifactOnce(input);
  }
}

function upsertBranchArtifactOnce(
  input: UpsertBranchArtifactInput
): Promise<Result<BranchArtifactWithDetail, StatusCode>> {
  return withDb.tx(async (tx) => {
    if (input.defaultBranch && input.branchName === input.defaultBranch) {
      return Result.err(Status.BadRequest);
    }
    // Artifact.projectId is nullable at the schema level solely for SESSION
    // artifacts (FEA-1699). Branch artifacts must stay project-parented, so
    // fail closed rather than create or unparent a projectless branch when an
    // upstream resolution unexpectedly yields null.
    if (input.projectId === null) {
      return Result.err(Status.BadRequest);
    }
    const sourceResult = await validateSourceArtifact(tx, input);
    if (!sourceResult.ok) {
      return sourceResult;
    }

    // PRD-510 D2: resolve by the org-scoped full-name key, uniform across
    // producers and independent of App installation. `existing` is normalized
    // the same way it was written (buildBranchCreateData), so the lookup is
    // casing/`.git`-insensitive.
    const existing = await tx.branchDetail.findUnique({
      where: {
        organizationId_repositoryFullName_branchName: {
          organizationId: input.organizationId,
          repositoryFullName: normalizeRepoFullName(input.repositoryFullName),
          branchName: input.branchName,
        },
      },
      include: { artifact: { select: { createdById: true, status: true } } },
    });

    const result = existing
      ? await updateBranchArtifact(
          tx,
          existing.artifactId,
          input,
          existing,
          existing.artifact
        )
      : await createBranchArtifact(tx, input);

    if (result.ok) {
      await linkSourceIfRequested(tx, input, result.value.id);
    }
    return result;
  });
}

function hasSupplementarySourceRepoAuthorization(
  input: UpsertBranchArtifactInput
): boolean {
  const authorization = input.sourceArtifactTargetRepoAuthorization;
  return (
    authorization?.provenance ===
      SourceArtifactTargetRepoAuthorizationProvenance.LoopBranchArtifactCallback &&
    authorization.repositoryFullNames.some(
      (repositoryFullName) => repositoryFullName === input.repositoryFullName
    )
  );
}

function resolveDeletedAtUpdate(
  deleteTransition: { deletedAt: Date | null } | null,
  shouldClearDeletedAt: boolean
): Date | null | undefined {
  if (deleteTransition) {
    return deleteTransition.deletedAt;
  }
  if (shouldClearDeletedAt) {
    return null;
  }
  return undefined;
}

function resolveUpdateBranchStatus(input: {
  deleteTransition: { status: GitHubPRStateValue } | null;
  shouldClearDeletedAt: boolean;
  pullRequestState: GitHubPRStateValue | null;
  currentStatus: string | null;
}): GitHubPRStateValue {
  if (input.deleteTransition) {
    return input.deleteTransition.status;
  }
  if (input.pullRequestState) {
    return input.pullRequestState;
  }
  if (
    input.shouldClearDeletedAt &&
    parseGitHubPRState(input.currentStatus) !== GitHubPRState.Merged
  ) {
    return GitHubPRState.Open;
  }
  return decideBranchStatus({ currentStatus: input.currentStatus });
}

function isGitHubZeroSha(value: string | null | undefined): boolean {
  return value === "0000000000000000000000000000000000000000";
}

function isAcceptedGitHubRecreate(
  input: {
    beforeSha?: string | null;
    observedAt?: Date | null;
    isCreate?: boolean;
  },
  current: HeadTransitionState
): boolean {
  return Boolean(
    current.deletedAt &&
      input.isCreate &&
      isGitHubZeroSha(input.beforeSha) &&
      isAfter(input.observedAt, current.deletedAt)
  );
}

function isStaleGitHubRecreate(
  input: {
    beforeSha?: string | null;
    observedAt?: Date | null;
    isCreate?: boolean;
  },
  current: HeadTransitionState
): boolean {
  return Boolean(
    current.deletedAt &&
      input.isCreate &&
      isGitHubZeroSha(input.beforeSha) &&
      !isAfter(input.observedAt, current.deletedAt)
  );
}

function isStaleGitHubDelete(
  input: {
    beforeSha?: string | null;
    currentHeadSha?: string | null;
    currentHeadShaObservedAt?: Date | null;
  },
  deletedAt: Date
): boolean {
  if (!input.currentHeadSha) {
    return false;
  }
  if (input.beforeSha && input.beforeSha !== input.currentHeadSha) {
    return true;
  }
  return Boolean(
    input.currentHeadShaObservedAt &&
      !isAfter(deletedAt, input.currentHeadShaObservedAt)
  );
}

function isAfter(candidate: Date | null | undefined, reference: Date): boolean {
  return candidate ? candidate.getTime() > reference.getTime() : false;
}

function latestDate(first: Date | null, second: Date): Date {
  if (!first) {
    return second;
  }
  return first.getTime() > second.getTime() ? first : second;
}

/**
 * Delete a branch artifact (and its nested PR state) by id, scoped to the
 * caller's organization. Mirrors document deletion: it removes the platform
 * record only — it does NOT touch the underlying git branch or GitHub PR.
 *
 * The DB cascade handles every dependent row: `BranchDetail`,
 * `BranchStatusCheck`, `BranchFileChange`, `PullRequestDetail` (FK
 * `branch_artifact_id` is ON DELETE CASCADE), `ArtifactLink`, `LinearSubtask`,
 * and favorites. `DeploymentDetail.branchArtifactId` is ON DELETE SET NULL, so
 * deployment records are preserved and merely unlinked.
 *
 * Returns `true` when a branch artifact was deleted, `false` when no branch
 * artifact with that id exists in the organization (so the route can answer
 * 404 without deleting documents or deployments through this endpoint).
 */
async function deleteBranchArtifact(
  id: string,
  organizationId: string
): Promise<boolean> {
  // Branch artifacts carry no slug; they are referenced by UUID only. A
  // non-UUID id can never match, and would otherwise blow up the `@db.Uuid`
  // column comparison.
  if (!isUuid(id)) {
    return false;
  }
  // Single atomic query: the type guard lives in the WHERE clause, so there is
  // no check-then-delete race, and `deleteMany` is idempotent — a concurrent
  // double-delete yields `count: 0` (mapped to 404 by the route) instead of a
  // P2025 throw.
  const result = await withDb((db) =>
    db.artifact.deleteMany({
      where: { id, organizationId, type: ArtifactType.BRANCH },
    })
  );
  return result.count > 0;
}

export const branchService = {
  upsertBranchArtifact,
  deleteBranchArtifact,
};
