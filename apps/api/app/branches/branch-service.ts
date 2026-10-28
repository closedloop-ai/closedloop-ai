import { randomUUID } from "node:crypto";
import {
  BranchBaseBranchSource,
  BranchFileCacheStatus,
  type BranchHeadShaSource,
  type BranchPushSource,
  BranchSyncStatus,
} from "@repo/api/src/types/artifact";
import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import type { GitHubPRState as GitHubPRStateValue } from "@repo/api/src/types/github";
import type { GitHubActorType } from "@repo/api/src/types/github-actor";
import type { PullRequestArtifactLinkResult } from "@repo/api/src/types/pull-request-artifact-link";
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
import { indexBranchArtifactAfterCommit } from "@/app/branches/branch-search-index";
import { writeBranchSourceLink } from "@/app/branches/branch-source-link";
import { parseStoredSnapshot } from "@/app/documents/repository-snapshot-helpers";
import { invalidateBranchStatusChecksForHeadChange } from "@/lib/branch-status-checks";
import { getPrismaErrorCode } from "@/lib/db-utils";
import {
  type GitHubFetchProvenance,
  gitHubFetchProvenanceData,
} from "@/lib/github-fetch-provenance";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";
import { deleteBranchArtifact } from "./branch-delete";
import { seedBranchOwners } from "./branch-owner-seed/branch-owner-seed";
import { bumpBranchActivity, stampBranchFirstPush } from "./branch-push-state";
import {
  applyDeleteTransition,
  applyHeadTransition,
  decideBranchStatus,
  type HeadTransitionResult,
  parseBranchBaseBranchSource,
  parseBranchHeadShaSource,
  resolveBaseProvenance,
  resolveDeletedAtUpdate,
  resolveUpdateBranchStatus,
  scheduleFileChangeCacheRefresh,
} from "./branch-state-transitions";
import {
  addsBranchSourceLink,
  type BranchUpsertField,
  branchUpsertChangedFields,
} from "./branch-upsert-changed-fields";
import { resolveCloudBranchWriteEligibility } from "./branch-write-eligibility";
import { ensurePullRequestAuthorIdentity } from "./pull-request-author-identity";
import { relinkPullRequestBranchInTransaction } from "./pull-request-branch-relink";
import {
  type PullRequestHeadRepositoryObservation,
  persistPullRequestHeadRepositoryAuthority,
} from "./pull-request-head-authority";
import { pullRequestLocData } from "./pull-request-loc-data";
import { reconcilePullRequestProviderIdentityInTransaction } from "./pull-request-provider-identity";
import {
  acquirePullRequestProviderIdentityLockInTransaction,
  pullRequestProviderLockTxOptions,
} from "./pull-request-provider-lock";

type BranchDetailWithCurrentPr = BranchDetail & {
  currentPullRequestDetail: PullRequestDetail | null;
};

type BranchArtifactRow = Artifact & {
  branch: BranchDetailWithCurrentPr | null;
  pullRequest: PullRequestDetail | null;
};

export type BranchArtifactWithDetail = BranchArtifactRow & {
  /**
   * ISS-10169: whether this call CREATED the row, rather than resolving the
   * existing branch for `(organizationId, repositoryFullName, branchName)`.
   * Reusing a branch is legitimate and common, but a caller handed back an id
   * with no way to tell the two apart cannot verify what it got.
   */
  created: boolean;
  /**
   * ISS-10169: the PRODUCES edges this call actually wrote, read back from the
   * write. Empty means none was REQUESTED — never that a requested one failed
   * to land, which rolls the transaction back instead.
   */
  linkedArtifacts: PullRequestArtifactLinkResult[];
};

/**
 * What a recorded upsert wrote, for its receipt (ISS-12552): for an
 * upsert onto an existing branch, the persisted fields it moved; empty for a
 * create and for an upsert that changed nothing.
 */
export type BranchUpsertWrite = BranchArtifactWithDetail & {
  changedFields: BranchUpsertField[];
};

/** Database-only predicate that must hold in the canonical write transaction. */
export type BranchArtifactWriteGuard = (
  tx: TransactionClient
) => Promise<boolean>;

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
  authorLogin?: string | null;
  authorProviderUserId?: string | null;
  authorActorType?: GitHubActorType | null;
  // FEA-3552: GitHub PR createdAt — anchors the rail's "PR opened" dot.
  githubCreatedAt?: Date | null;
  closedAt?: Date | null;
  mergedAt?: Date | null;
  mergeCommitSha?: string | null;
  headRepositoryObservation?: PullRequestHeadRepositoryObservation;
};

export type UpsertBranchArtifactInput = {
  organizationId: string;
  /**
   * Installation-repo surrogate id — optional enrichment (PRD-510 D2). App-repo
   * producers (webhook, PR) pass it; the desktop producer omits it for
   * non-App branches. Branch identity keys on the org + normalized full name.
   */
  repositoryId?: string | null;
  repositoryFullName: string;
  branchName: string;
  /** Compatibility-only caller assertion. Never used as authority. */
  defaultBranch?: string | null;
  /** Fresh provider observation. Present-but-unavailable never falls back. */
  repositoryDefaultObservation?: PullRequestHeadRepositoryObservation;
  /** Base installation repository retained as PullRequestDetail context. */
  pullRequestRepositoryId?: string | null;
  /** Verified PR base repository used for source-document authorization. */
  pullRequestBaseRepositoryFullName?: string;
  projectId: string | null;
  /**
   * ISS-10995 (operator ruling 2026-10-12): treat `projectId` as a FILL for
   * this producer — it files a branch that has none and never re-files one.
   * Set it on a SYNC-shaped producer, whose project is resolved lineage (the
   * push and PR webhooks, the loop callback, the PR-linkage retry). Leave it
   * off where `projectId` is a value the caller chose for this write: the
   * ruling constrains the sync, and discarding an explicit re-file would make
   * `POST /artifact-links/branches` and the Select-PR dialog return 200 for a
   * move they did not perform.
   */
  projectFillOnly?: boolean;
  createdById?: string | null;
  baseBranch?: string | null;
  baseBranchSource?: BranchBaseBranchSource | null;
  headSha?: string | null;
  headShaSource?: BranchHeadShaSource | null;
  headShaObservedAt?: Date | null;
  /**
   * Activity evidence carried by this write. Omit to preserve the historical
   * head-observation fallback; pass null when the producer can observe the head
   * but cannot prove when qualifying Branch activity occurred.
   */
  activityAt?: Date | null;
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
  pullRequest?: UpsertBranchPullRequestInput | null;
  fetchProvenance?: GitHubFetchProvenance;
};

type SourceArtifactEvidence = {
  createdById: string | null;
};

const branchInclude = {
  branch: { include: { currentPullRequestDetail: true } },
  pullRequest: true,
} as const;

function buildBranchTreeUrl(repositoryFullName: string, branchName: string) {
  return `https://github.com/${repositoryFullName}/tree/${encodeURIComponent(
    branchName
  )}`;
}

async function validateSourceArtifact(
  tx: TransactionClient,
  input: UpsertBranchArtifactInput
): Promise<Result<SourceArtifactEvidence, StatusCode>> {
  if (!input.sourceArtifactId) {
    return Result.ok({ createdById: null, snapshot: null });
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
    select: {
      createdById: true,
      document: { select: { repositorySnapshot: true } },
    },
  });
  if (!source) {
    return Result.err(Status.Forbidden);
  }
  // PLN-602: replace the legacy `targetRepo` column gate with a snapshot check.
  // A source with an empty snapshot has no repo constraint (analogous to the
  // old NULL case); otherwise the requested repo must appear in the snapshot.
  const snapshot = parseStoredSnapshot(source.document?.repositorySnapshot);
  const evidence = { createdById: source.createdById ?? null };
  if (!snapshot || snapshot.repositories.length === 0) {
    return Result.ok(evidence);
  }
  const authorizedRepositoryFullName =
    input.pullRequest &&
    input.pullRequestRepositoryId &&
    input.pullRequestBaseRepositoryFullName
      ? input.pullRequestBaseRepositoryFullName
      : input.repositoryFullName;
  const allowed = snapshot.repositories.some(
    (repo: { fullName: string }) =>
      normalizeRepoFullName(repo.fullName) ===
      normalizeRepoFullName(authorizedRepositoryFullName)
  );
  if (allowed) {
    return Result.ok(evidence);
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

function resolveBranchActivityAt(
  input: Pick<UpsertBranchArtifactInput, "activityAt">,
  headShaObservedAt: Date | null
): Date | null {
  return input.activityAt === undefined ? headShaObservedAt : input.activityAt;
}

function buildBranchCreateData(
  input: UpsertBranchArtifactInput,
  createdById: string | null,
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
    createdById,
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
        // Existing callers preserve the historical head-observation fallback.
        // Webhook producers with no authoritative occurrence timestamp pass an
        // explicit null so receipt time cannot fabricate Last active.
        lastActivityAt: resolveBranchActivityAt(
          input,
          headTransition.headShaObservedAt
        ),
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

/**
 * The base ref to stamp on the PR row — the caller's base ONLY where it says that
 * base came from a PR's own base ref. A branch base from a harness input, an MCP
 * input, or a repository default is not evidence about any pull request, and
 * ISS-8155 exists to stop the PR read borrowing values like that.
 */
function pullRequestBaseRef(
  input: Pick<UpsertBranchArtifactInput, "baseBranch" | "baseBranchSource">
): string | null {
  return input.baseBranchSource === BranchBaseBranchSource.PullRequestBase
    ? input.baseBranch || null
    : null;
}

async function upsertCurrentPullRequestDetail(
  tx: TransactionClient,
  artifactId: string,
  organizationId: string,
  repositoryId: string,
  repositoryFullName: string,
  input: UpsertBranchPullRequestInput,
  fetchProvenance: GitHubFetchProvenance | undefined,
  headRef: { name: string; oid: string | null },
  baseRefName: string | null
) {
  const detailId = randomUUID();
  const provenance = gitHubFetchProvenanceData(fetchProvenance);
  const existingPullRequestDetailId =
    await reconcilePullRequestProviderIdentityInTransaction(tx, {
      organizationId,
      repositoryId,
      repositoryFullName,
      githubId: input.githubId,
      number: input.number,
    });
  if (existingPullRequestDetailId) {
    await relinkPullRequestBranchInTransaction(tx, {
      organizationId,
      pullRequestDetailId: existingPullRequestDetailId,
      branchArtifactId: artifactId,
      repositoryFullName,
      pullRequestNumber: input.number,
    });
  }
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
      // FEA-3552: persist the GitHub PR createdAt for the rail's "PR opened" dot.
      githubCreatedAt: input.githubCreatedAt ?? null,
      closedAt: input.closedAt ?? null,
      mergedAt: input.mergedAt ?? null,
      mergeCommitSha: input.mergeCommitSha ?? null,
      authorLogin: input.authorLogin ?? null,
      authorProviderUserId: input.authorProviderUserId ?? null,
      authorActorType: input.authorActorType ?? null,
      baseRefName,
      ...provenance,
    },
    update: {
      title: input.title,
      htmlUrl: input.htmlUrl,
      body: input.body ?? null,
      prState: input.state,
      isDraft: input.isDraft ?? false,
      ...pullRequestLocData(input),
      isCurrent: true,
      // FEA-3552: keep the persisted createdAt fresh; the value is idempotent
      // (GitHub PR createdAt never changes), so a repeated projection is a no-op.
      githubCreatedAt: input.githubCreatedAt ?? null,
      closedAt: input.closedAt ?? null,
      mergedAt: input.mergedAt ?? null,
      mergeCommitSha: input.mergeCommitSha ?? null,
      ...pullRequestAuthorUpdateData(input),
      // Omission-preserving: a caller whose base did not come from a PR base has
      // no evidence about this PR and must not null a value that has some.
      ...(baseRefName === null ? {} : { baseRefName }),
      ...provenance,
    },
    select: { id: true, branchArtifactId: true },
  });
  await ensurePullRequestAuthorIdentity(tx, {
    organizationId,
    githubId: input.githubId,
    authorProviderUserId: input.authorProviderUserId,
    authorLogin: input.authorLogin,
    authorActorType: input.authorActorType,
  });
  await tx.pullRequestDetail.updateMany({
    where: {
      organizationId,
      branchArtifactId: artifactId,
      isCurrent: true,
      id: { not: detail.id },
    },
    data: { isCurrent: false },
  });
  if (detail.branchArtifactId !== artifactId) {
    throw new Error("pull request Branch ownership changed during upsert");
  }
  const pointed = await tx.branchDetail.updateMany({
    where: { artifactId, organizationId },
    data: { currentPullRequestDetailId: detail.id },
  });
  if (pointed.count !== 1) {
    throw new Error("pull request current pointer changed during upsert");
  }
  await persistPullRequestHeadRepositoryAuthority(
    tx,
    { organizationId, pullRequestDetailId: detail.id },
    input.headRepositoryObservation,
    headRef
  );
}

async function createBranchArtifact(
  tx: TransactionClient,
  input: UpsertBranchArtifactInput,
  createdById: string | null
): Promise<Result<BranchArtifactRow, StatusCode>> {
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
      createdById,
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
  const pullRequestRepositoryId = resolvePullRequestRepositoryId(input);
  if (input.pullRequest && pullRequestRepositoryId) {
    await upsertCurrentPullRequestDetail(
      tx,
      created.id,
      input.organizationId,
      pullRequestRepositoryId,
      input.repositoryFullName,
      input.pullRequest,
      input.fetchProvenance,
      { name: input.branchName, oid: input.headSha ?? null },
      pullRequestBaseRef(input)
    );
  }
  return rereadBranchArtifact(tx, created.id);
}

async function updateBranchArtifact(
  tx: TransactionClient,
  artifactId: string,
  input: UpsertBranchArtifactInput,
  createdById: string | null,
  existing: BranchDetail,
  currentArtifact: { createdById: string | null; status: string | null }
): Promise<Result<BranchArtifactRow, StatusCode>> {
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
      ...branchProjectUpdateData(input),
      ...(createdById && !currentArtifact.createdById ? { createdById } : {}),
    },
    select: { id: true },
  });
  await fillBranchProject(tx, artifactId, input);
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
    select: { artifactId: true },
  });
  const activityAt = resolveBranchActivityAt(
    input,
    headTransition.headShaObservedAt
  );
  if (existing.headSha !== headTransition.headSha) {
    await invalidateBranchStatusChecksForHeadChange(tx, artifactId);
    // PLN-1034: a new head SHA means a commit was pushed — genuine activity.
    // Monotonic so a re-delivered/stale push can't regress the timestamp.
    await bumpBranchActivity(tx, artifactId, activityAt);
  } else if (
    shouldClearDeletedAt ||
    headTransition.reason === "push_confirmed"
  ) {
    // Recreating a deleted ref is genuine branch activity even when GitHub
    // recreates it at the same SHA. Same-SHA push confirmation is also genuine
    // remote activity for a previously local-only branch.
    await bumpBranchActivity(tx, artifactId, activityAt);
  }
  // See the create path: PR detail requires a non-null installation repo.
  const pullRequestRepositoryId =
    input.pullRequestRepositoryId ?? input.repositoryId;
  if (input.pullRequest && pullRequestRepositoryId) {
    await upsertCurrentPullRequestDetail(
      tx,
      artifactId,
      input.organizationId,
      pullRequestRepositoryId,
      input.repositoryFullName,
      input.pullRequest,
      input.fetchProvenance,
      { name: input.branchName, oid: input.headSha ?? null },
      pullRequestBaseRef(input)
    );
  }
  return rereadBranchArtifact(tx, artifactId);
}

async function rereadBranchArtifact(
  tx: TransactionClient,
  artifactId: string
): Promise<Result<BranchArtifactRow, StatusCode>> {
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

/**
 * Creates or updates a BRANCH artifact by the PRD-510 D2 identity key
 * `(organizationId, normalized repositoryFullName, branchName)` — uniform across
 * the desktop-sync and GitHub-webhook producers, independent of GitHub App
 * installation. Optional PR data is stored as current PR detail on the branch
 * artifact for compatibility while the destructive cutover is still pending.
 */
async function upsertBranchArtifact(
  input: UpsertBranchArtifactInput,
  recordWritten?: RecordWriteInTransaction<BranchUpsertWrite>
): Promise<Result<BranchArtifactWithDetail, StatusCode>> {
  const result = await runUpsertBranchArtifact(input, undefined, recordWritten);
  if (!result) {
    throw new Error("Unguarded Branch upsert was unexpectedly rejected");
  }
  if (result.ok) {
    // FEA-3930: fail-open, post-commit index of the branch + its current PR into
    // the unified-search projection. Never blocks or fails the branch write.
    indexBranchArtifactAfterCommit(result.value);
  }
  return result;
}

/**
 * Runs a database-only guard in the same transaction as the canonical Branch
 * write. A rejected guard returns null before any Product evidence is mutated.
 */
async function upsertBranchArtifactGuarded(
  input: UpsertBranchArtifactInput,
  guard: BranchArtifactWriteGuard
): Promise<Result<BranchArtifactWithDetail, StatusCode> | null> {
  const result = await runUpsertBranchArtifact(input, guard);
  if (result?.ok) {
    indexBranchArtifactAfterCommit(result.value);
  }
  return result;
}

function runUpsertBranchArtifact(
  input: UpsertBranchArtifactInput,
  guard?: BranchArtifactWriteGuard,
  recordWritten?: RecordWriteInTransaction<BranchUpsertWrite>
): Promise<Result<BranchArtifactWithDetail, StatusCode> | null> {
  return upsertBranchArtifactOnce(input, guard, recordWritten).catch(
    (error) => {
      if (getPrismaErrorCode(error) !== "P2002") {
        throw error;
      }
      return upsertBranchArtifactOnce(input, guard, recordWritten);
    }
  );
}

function upsertBranchArtifactOnce(
  input: UpsertBranchArtifactInput,
  guard?: BranchArtifactWriteGuard,
  recordWritten?: RecordWriteInTransaction<BranchUpsertWrite>
): Promise<Result<BranchArtifactWithDetail, StatusCode> | null> {
  // ISS-7130: raise the bounds only for the writes that can actually block on
  // the PR-provider advisory lock — the same predicate the acquisition below
  // uses, and both halves are pure functions of `input`. A lock-free producer (a
  // push webhook, the desktop branch lane) keeps Prisma's defaults rather than
  // inheriting a ceiling that would let a stalled write pin a pooled connection
  // for the whole waiter budget, which `pullRequestProviderLockTxOptions`
  // DERIVES from the holder ceiling and so is not restated as a number here.
  // Ignored entirely when a caller already has an ambient transaction
  // open — the options then live on that outer `withDb.tx`, which is why the
  // `pull_request` webhook carries the same bounds itself.
  const takesProviderLock = Boolean(
    input.pullRequest && resolvePullRequestRepositoryId(input)
  );
  return withDb.tx(
    async (tx) => {
      if (guard && !(await guard(tx))) {
        return null;
      }
      const eligibility = await resolveCloudBranchWriteEligibility(tx, input);
      if (eligibility.kind === "not_materialized") {
        return Result.err(Status.BadRequest);
      }
      // FEA-1749: a null projectId is legitimate, not a resolution failure. Branch
      // identity is (organizationId, repositoryFullName, branchName) — PRD-510 D2
      // — and has never included a project. `buildBranchCreateData` already takes
      // `string | null`. This used to fail closed here, which is what made the
      // desktop lane (the producer that by definition has no project) unable to
      // create a branch at all.
      const sourceResult = await validateSourceArtifact(tx, input);
      if (!sourceResult.ok) {
        return sourceResult;
      }
      const createdById = input.createdById ?? sourceResult.value.createdById;
      const pullRequestRepositoryId = resolvePullRequestRepositoryId(input);
      if (input.pullRequest && pullRequestRepositoryId) {
        await acquirePullRequestProviderIdentityLockInTransaction(tx, {
          organizationId: input.organizationId,
          repositoryFullName:
            input.pullRequestBaseRepositoryFullName ?? input.repositoryFullName,
          number: input.pullRequest.number,
        });
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
        include: {
          artifact: {
            select: { createdById: true, status: true, projectId: true },
          },
        },
      });

      const result = existing
        ? await updateBranchArtifact(
            tx,
            existing.artifactId,
            input,
            createdById,
            existing,
            existing.artifact
          )
        : await createBranchArtifact(tx, input, createdById);

      if (!result.ok) {
        return result;
      }
      // ISS-12552: read only for a caller that records the write, so an
      // upsert that gets no receipt issues exactly the queries it did before.
      const sourceLinkAdded =
        recordWritten !== undefined &&
        existing !== null &&
        (await addsBranchSourceLink(
          tx,
          input.sourceArtifactId,
          result.value.id
        ));
      // ISS-10169: the response's link echo used to be the REQUEST read back to
      // the caller, so it asserted a relationship nobody had looked at. This is
      // the write's own report, and it is the only thing the echo is built from.
      const linkedArtifacts = await writeBranchSourceLink(tx, {
        organizationId: input.organizationId,
        sourceArtifactId: input.sourceArtifactId ?? null,
        branchArtifactId: result.value.id,
      });
      await seedBranchOwners(tx, input.organizationId, [result.value.id]);
      const written = {
        ...result.value,
        created: !existing,
        linkedArtifacts,
      };
      await recordWritten?.(tx, {
        ...written,
        changedFields: existing
          ? branchUpsertChangedFields(
              { projectId: existing.artifact.projectId, branch: existing },
              result.value,
              sourceLinkAdded
            )
          : [],
      });
      return Result.ok(written);
    },
    takesProviderLock ? pullRequestProviderLockTxOptions : undefined
  );
}

function resolvePullRequestRepositoryId(
  input: UpsertBranchArtifactInput
): string | null {
  return input.pullRequestRepositoryId ?? input.repositoryId ?? null;
}

export const branchService = {
  upsertBranchArtifact,
  upsertBranchArtifactGuarded,
  deleteBranchArtifact,
};

/** Preserve old producer omissions instead of clearing measured PR authors. */
function pullRequestAuthorUpdateData(input: UpsertBranchPullRequestInput) {
  return {
    ...(input.authorLogin === undefined
      ? {}
      : { authorLogin: input.authorLogin }),
    ...(input.authorProviderUserId === undefined
      ? {}
      : { authorProviderUserId: input.authorProviderUserId }),
    ...(input.authorActorType === undefined
      ? {}
      : { authorActorType: input.authorActorType }),
  };
}

/**
 * The project an UNCONDITIONAL update arm writes: the one a caller chose for
 * this write. A sync-shaped producer's lineage project is left to
 * {@link fillBranchProject}, and FEA-1749's "never clear" holds on both paths —
 * a null `input.projectId` writes nothing.
 */
function branchProjectUpdateData(input: UpsertBranchArtifactInput): {
  projectId?: string;
} {
  return input.projectId && !input.projectFillOnly
    ? { projectId: input.projectId }
    : {};
}

/**
 * File a sync-shaped producer's branch that has no project, in ONE statement
 * whose predicate the database evaluates.
 *
 * Not an app-computed read-then-write, for the reason
 * {@link updateBranchArtifact} states about the push stamp: these transactions
 * run READ COMMITTED, the branch row is not locked by the `findUnique` that
 * resolves it, and `POST /artifact-links/batch-move` — the Details Project
 * row's writer — takes `FOR NO KEY UPDATE` and commits inside that window
 * (ISS-10995, davetho review on PR #8735). A decision made from the earlier
 * read would overwrite the user's committed move with lineage.
 */
async function fillBranchProject(
  tx: TransactionClient,
  artifactId: string,
  input: UpsertBranchArtifactInput
): Promise<void> {
  if (!(input.projectId && input.projectFillOnly)) {
    return;
  }
  await tx.artifact.updateMany({
    where: { id: artifactId, projectId: null },
    data: { projectId: input.projectId },
  });
}
