import {
  BranchBaseBranchSource,
  BranchHeadShaSource,
} from "@repo/api/src/types/artifact";
import type { GitHubActorType } from "@repo/api/src/types/github-actor";
import type { Prisma, TransactionClient } from "@repo/database";
import { invalidateBranchStatusChecksForHeadChange } from "@/lib/branch-status-checks";
import {
  type GitHubFetchProvenance,
  gitHubFetchProvenanceData,
} from "@/lib/github-fetch-provenance";
import { isWithinTrustedFutureBoundary } from "@/lib/trusted-timestamp";
import { emitBranchDetailChanged } from "./branch-detail-signal";
import { ensurePullRequestAuthorIdentity } from "./pull-request-author-identity";
import {
  lockPullRequestActivityIdentityInTransaction,
  relinkPullRequestBranchInTransaction,
} from "./pull-request-branch-relink";
import {
  type PullRequestHeadRepositoryObservation,
  persistPullRequestHeadRepositoryAuthority,
} from "./pull-request-head-authority";
import { pullRequestLocData } from "./pull-request-loc-data";
import { reconcilePullRequestProviderIdentityInTransaction } from "./pull-request-provider-identity";
import { acquirePullRequestProviderIdentityLockInTransaction } from "./pull-request-provider-lock";

export type BranchPullRequestProjectionInput = {
  organizationId: string;
  // Nullable: repo-less desktop rows (PRD-510 D2, and the PLN-1535 tier-2
  // reconciler) genuinely carry no installation-repo surrogate id. App-repo
  // producers pass a real id; the update path never rewrites it. The create path
  // (upsertPullRequestDetailForBranch) requires a non-null id and throws on null,
  // so repo-less rows only ever reach the writer via update-by-id — a create
  // never actually persists null even though the column permits it.
  repositoryId: string | null;
  /** Normalized provider-independent repository coordinate used for locking. */
  repositoryFullName: string;
  githubId: string;
  number: number;
  title: string;
  body?: string | null;
  htmlUrl: string;
  headBranch: string;
  baseBranch: string;
  headSha?: string | null;
  prState: Prisma.PullRequestDetailUncheckedCreateWithoutBranchArtifactInput["prState"];
  isDraft: boolean;
  additions?: number | null;
  deletions?: number | null;
  changedFiles?: number | null;
  checksStatus?: Prisma.BranchDetailUpdateInput["checksStatus"];
  reviewDecision?: Prisma.PullRequestDetailUncheckedCreateWithoutBranchArtifactInput["reviewDecision"];
  // FEA-3552: GitHub PR createdAt — the true "PR opened" instant for the rail's
  // opened dot. Optional: omitted (undefined) leaves the persisted value untouched
  // on update so a later provenance-poorer projection can't clobber a known value.
  githubCreatedAt?: Date | null;
  // PLN-1535 M1: GitHub PR updated_at — the reconciler's watermark. Optional and
  // omission-preserving on update, like githubCreatedAt, so a provenance-poorer
  // projection can't null out a known value.
  githubUpdatedAt?: Date | null;
  closedAt?: Date | null;
  mergedAt?: Date | null;
  mergeCommitSha?: string | null;
  // The exact PR-head oid paired with `headBranch` at the provider-authority
  // compare-and-set boundary. This remains optional for version-skewed callers;
  // detail payload builders deliberately do not persist either member directly.
  headRefOid?: string | null;
  // PLN-1535 M3: the PR author's GitHub login. Optional & omission-preserving on
  // update (undefined preserves the stored value; the webhook passes a concrete
  // login). Lets the Postgres-served PR list render the real author.
  authorLogin?: string | null;
  /** Stable provider author ID and kind; undefined preserves, null clears. */
  authorProviderUserId?: string | null;
  authorActorType?: GitHubActorType | null;
  /** Provider-confirmed observation time to stamp on successful writes only. */
  verifiedAt?: Date;
  /** Optional provider-authoritative head repository snapshot. */
  headRepositoryObservation?: PullRequestHeadRepositoryObservation;
  fetchProvenance?: GitHubFetchProvenance;
};

export type ExistingBranchPullRequestProjectionTarget = {
  branchArtifactId: string;
  pullRequestDetailId?: string | null;
  pullRequestBranchArtifactId?: string | null;
  currentHeadSha?: string | null;
  branchProjectionMode?: BranchProjectionMode;
};

export const BranchProjectionMode = {
  Full: "full",
  PointerOnly: "pointer_only",
} as const;
export type BranchProjectionMode =
  (typeof BranchProjectionMode)[keyof typeof BranchProjectionMode];

/**
 * Builds the PR detail create shape used by branch artifact creation and
 * historical projection backfill. Optional provider-only fields stay omitted
 * unless the caller has durable evidence for the value.
 */
export function buildPullRequestDetailCreate(
  input: BranchPullRequestProjectionInput
): Prisma.PullRequestDetailUncheckedCreateWithoutBranchArtifactInput {
  const create: Prisma.PullRequestDetailUncheckedCreateWithoutBranchArtifactInput =
    {
      // FEA-2732: organizationId is the write-once org SSOT copy (NOT NULL). App
      // webhook rows carry the repo, but every PR row must still stamp the org so
      // it shares one identity space with repo-less desktop rows.
      organizationId: input.organizationId,
      repositoryId: input.repositoryId,
      githubId: input.githubId,
      number: input.number,
      title: input.title,
      htmlUrl: input.htmlUrl,
      body: input.body ?? null,
      prState: input.prState,
      isDraft: input.isDraft,
      ...pullRequestLocData(input),
      isCurrent: true,
      // FEA-3552: persist the GitHub PR createdAt on create (null when the
      // producer had no created_at, e.g. a partial refresh payload).
      githubCreatedAt: input.githubCreatedAt ?? null,
      githubUpdatedAt: input.githubUpdatedAt ?? null,
      closedAt: input.closedAt ?? null,
      mergedAt: input.mergedAt ?? null,
      mergeCommitSha: input.mergeCommitSha ?? null,
      authorLogin: input.authorLogin ?? null,
      authorProviderUserId: input.authorProviderUserId ?? null,
      authorActorType: input.authorActorType ?? null,
      baseRefName: input.baseBranch || null,
      lastVerifiedAt: input.verifiedAt ?? null,
      lastRefreshAttemptAt: input.verifiedAt ?? null,
      ...gitHubFetchProvenanceData(input.fetchProvenance),
    };
  if (input.reviewDecision !== undefined) {
    create.reviewDecision = input.reviewDecision;
  }
  return create;
}

/**
 * The subset of {@link BranchPullRequestProjectionInput} that feeds
 * PullRequestDetail COLUMNS. ISS-8155 split it out so the webhook's detail-only
 * lane (`pullRequestToDetailUpdate`) maps those columns through this builder
 * instead of a parallel literal that could drift field by field. Derived by
 * `Omit` so a field added to the projection input cannot go missing here.
 * `number` is the one member it still carries that the update payload does NOT
 * write — see the key-column note in `buildPullRequestDetailUpdate` (ISS-8243).
 */
export type PullRequestDetailFieldsInput = Omit<
  BranchPullRequestProjectionInput,
  | "checksStatus"
  | "githubId"
  | "headRefOid"
  | "headRepositoryObservation"
  | "headSha"
  | "headBranch"
  | "organizationId"
  | "repositoryFullName"
  | "repositoryId"
>;

/**
 * Builds the PR detail update shape shared by webhook writes and historical
 * backfill writes.
 *
 * `setCurrent` defaults to true (the webhook/backfill lanes establish the row as
 * the branch's current PR). The PLN-1535 reconciler passes `false`: it is a
 * data-freshness lane that must refresh a row's own fields without promoting a
 * superseded row to current — ownership of `isCurrent` stays with the
 * webhook/desktop-sync lanes.
 *
 * ISS-8243: `number` is deliberately NOT in this payload, while
 * {@link buildPullRequestDetailCreate} still writes it, and re-adding it here
 * reopens a production hazard. With the column present, the three ISS-6421
 * atom-barrier cases in
 * `__tests__/integration/non-webhook-pr-lifecycle-writers-realdb.test.ts` hang:
 * concurrent FK writers on the row (an atom INSERT taking `FOR KEY SHARE`)
 * block until they time out. They pass without it. Why the lock behaves that
 * way is still contested — the analysis lives in ISS-8243, so do not build on
 * it. Nothing needs the write: a row is created with its number and no producer
 * renumbers a PR. The trade this gives up is the silent self-heal of a wrong
 * stored number on the `id`/`githubId`-resolved lanes; accepted, since GitHub
 * PR numbers are immutable per repo for a given node id.
 */
export function buildPullRequestDetailUpdate(
  input: PullRequestDetailFieldsInput,
  options?: { setCurrent?: boolean }
): Prisma.PullRequestDetailUncheckedUpdateInput {
  const update: Prisma.PullRequestDetailUncheckedUpdateInput = {
    title: input.title,
    htmlUrl: input.htmlUrl,
    body: input.body ?? undefined,
    prState: input.prState,
    isDraft: input.isDraft,
    ...pullRequestLocData(input),
    ...(options?.setCurrent === false ? {} : { isCurrent: true }),
    ...gitHubFetchProvenanceData(input.fetchProvenance),
  };
  if (input.reviewDecision !== undefined) {
    update.reviewDecision = input.reviewDecision;
  }
  // FEA-3552: only write githubCreatedAt when the caller supplied it, so a
  // provenance-poorer projection that omits created_at can't null out a value an
  // earlier richer projection already persisted.
  if (input.githubCreatedAt !== undefined) {
    update.githubCreatedAt = input.githubCreatedAt;
  }
  if (input.githubUpdatedAt !== undefined) {
    update.githubUpdatedAt = input.githubUpdatedAt;
  }
  if (input.closedAt !== undefined) {
    update.closedAt = input.closedAt;
  }
  if (input.mergedAt !== undefined) {
    update.mergedAt = input.mergedAt;
  }
  if (input.mergeCommitSha !== undefined) {
    update.mergeCommitSha = input.mergeCommitSha;
  }
  // PLN-1535 M3: omission-preserving, like the timestamp fields above — a
  // provenance-poorer projection that omits the author never nulls a stored one.
  if (input.authorLogin !== undefined) {
    update.authorLogin = input.authorLogin;
  }
  if (input.authorProviderUserId !== undefined) {
    update.authorProviderUserId = input.authorProviderUserId;
  }
  if (input.authorActorType !== undefined) {
    update.authorActorType = input.authorActorType;
  }
  // ISS-8155: NULL is the column's only spelling of "unmeasured", and on CREATE
  // that is what an absent base ref stores. On UPDATE it is not the same fact:
  // `mapPullRequestNode` coalesces an absent GraphQL `baseRefName` to `""`, so
  // writing it unconditionally turned a provenance-poorer refresh into a
  // DESTRUCTIVE CLEAR of a base another producer had already measured. No
  // producer can express "this PR lost its base" — GitHub always has one — so
  // absence here means "nothing to say", never "clear it". Omission-preserving
  // like the fields above.
  if (input.baseBranch) {
    update.baseRefName = input.baseBranch;
  }
  if (input.verifiedAt !== undefined) {
    update.lastVerifiedAt = input.verifiedAt;
    update.lastRefreshAttemptAt = input.verifiedAt;
  }
  return update;
}

/**
 * Writes the branch and current PR projection for an already-owned BRANCH
 * artifact. This is the shared durable writer for webhook updates and internal
 * historical backfill; public backfill routes remain dry-run
 * unless an owner-approved internal caller invokes this path.
 */
export async function writeExistingBranchPullRequestProjection(
  db: TransactionClient,
  target: ExistingBranchPullRequestProjectionTarget,
  input: BranchPullRequestProjectionInput
): Promise<{ id: string }> {
  const prepared = await preparePullRequestBranchAssociation(db, target, input);
  if (prepared.stale) {
    if (!prepared.pullRequestDetailId) {
      throw new Error("stale pull request projection has no owner");
    }
    return { id: prepared.pullRequestDetailId };
  }
  if (target.branchProjectionMode !== BranchProjectionMode.PointerOnly) {
    const updatedBranch = await db.branchDetail.updateMany({
      where: {
        artifactId: target.branchArtifactId,
        organizationId: input.organizationId,
      },
      data: {
        branchName: input.headBranch,
        baseBranch: input.baseBranch,
        baseBranchSource: BranchBaseBranchSource.PullRequestBase,
        headSha: input.headSha ?? null,
        headShaSource: input.headSha
          ? BranchHeadShaSource.PullRequestWebhook
          : null,
        ...(input.checksStatus === undefined
          ? {}
          : { checksStatus: input.checksStatus }),
        ...gitHubFetchProvenanceData(input.fetchProvenance),
      },
    });
    if (updatedBranch.count !== 1) {
      throw new Error("pull request projection target Branch changed");
    }
    if (prepared.currentHeadSha !== (input.headSha ?? null)) {
      await invalidateBranchStatusChecksForHeadChange(
        db,
        target.branchArtifactId
      );
    }
  }

  const prDetail = prepared.pullRequestDetailId
    ? await updatePullRequestDetail(db, prepared.pullRequestDetailId, input)
    : await upsertPullRequestDetailForBranch(
        db,
        target.branchArtifactId,
        input
      );

  await ensurePullRequestAuthorIdentity(db, {
    organizationId: input.organizationId,
    githubId: input.githubId,
    authorProviderUserId: input.authorProviderUserId,
    authorLogin: input.authorLogin,
    authorActorType: input.authorActorType,
  });

  await persistPullRequestHeadRepositoryAuthority(
    db,
    {
      organizationId: input.organizationId,
      pullRequestDetailId: prDetail.id,
    },
    input.headRepositoryObservation,
    {
      name: input.headBranch,
      oid: input.headRefOid === undefined ? input.headSha : input.headRefOid,
    }
  );

  const owned = await db.pullRequestDetail.findFirst({
    where: {
      id: prDetail.id,
      organizationId: input.organizationId,
      branchArtifactId: target.branchArtifactId,
    },
    select: { id: true },
  });
  if (!owned) {
    throw new Error("pull request projection Branch ownership changed");
  }
  await db.pullRequestDetail.updateMany({
    where: {
      organizationId: input.organizationId,
      branchArtifactId: target.branchArtifactId,
      isCurrent: true,
      id: { not: prDetail.id },
    },
    data: { isCurrent: false },
  });

  const pointed = await db.branchDetail.updateMany({
    where: {
      artifactId: target.branchArtifactId,
      organizationId: input.organizationId,
    },
    data: { currentPullRequestDetailId: prDetail.id },
  });
  if (pointed.count !== 1) {
    throw new Error("pull request projection current pointer changed");
  }

  await emitBranchDetailChanged(
    db,
    input.organizationId,
    target.branchArtifactId
  );
  if (prepared.previousBranchArtifactId) {
    await emitBranchDetailChanged(
      db,
      input.organizationId,
      prepared.previousBranchArtifactId
    );
  }
  return { id: prDetail.id };
}

async function preparePullRequestBranchAssociation(
  db: TransactionClient,
  target: ExistingBranchPullRequestProjectionTarget,
  input: BranchPullRequestProjectionInput
): Promise<PreparedPullRequestAssociation> {
  const targetBranch = await db.branchDetail.findFirst({
    where: {
      artifactId: target.branchArtifactId,
      organizationId: input.organizationId,
    },
    select: { artifactId: true, headSha: true },
  });
  if (!targetBranch) {
    throw new Error("pull request projection target Branch was not found");
  }
  const pullRequestDetailId = input.repositoryId
    ? await reconcilePullRequestProviderIdentityInTransaction(db, {
        organizationId: input.organizationId,
        repositoryId: input.repositoryId,
        repositoryFullName: input.repositoryFullName,
        githubId: input.githubId,
        number: input.number,
      })
    : await resolveRepoLessProjectionRow(db, input);
  if (!pullRequestDetailId) {
    return {
      pullRequestDetailId: null,
      currentHeadSha: targetBranch.headSha,
      stale: false,
    };
  }
  await lockPullRequestActivityIdentityInTransaction(
    db,
    input.organizationId,
    pullRequestDetailId
  );
  const current = await db.pullRequestDetail.findFirst({
    where: { id: pullRequestDetailId, organizationId: input.organizationId },
    select: {
      id: true,
      branchArtifactId: true,
      githubUpdatedAt: true,
      headRefName: true,
    },
  });
  if (!current) {
    throw new Error("pull request projection identity disappeared");
  }
  const stale = isStaleProjection(current, input);
  if (!stale && current.branchArtifactId !== target.branchArtifactId) {
    await relinkPullRequestBranchInTransaction(db, {
      organizationId: input.organizationId,
      pullRequestDetailId,
      branchArtifactId: target.branchArtifactId,
      repositoryFullName: input.repositoryFullName,
      pullRequestNumber: input.number,
    });
  }
  return {
    pullRequestDetailId,
    currentHeadSha: targetBranch.headSha,
    stale,
    ...(current.branchArtifactId &&
    current.branchArtifactId !== target.branchArtifactId
      ? { previousBranchArtifactId: current.branchArtifactId }
      : {}),
  };
}

async function updatePullRequestDetail(
  db: TransactionClient,
  pullRequestDetailId: string,
  input: BranchPullRequestProjectionInput
): Promise<{ id: string }> {
  const updated = await db.pullRequestDetail.updateMany({
    where: {
      id: pullRequestDetailId,
      organizationId: input.organizationId,
    },
    data: buildPullRequestDetailUpdate(input),
  });
  if (updated.count !== 1) {
    throw new Error("pull request projection row changed");
  }
  return { id: pullRequestDetailId };
}

function upsertPullRequestDetailForBranch(
  db: TransactionClient,
  branchArtifactId: string,
  input: BranchPullRequestProjectionInput
): Promise<{ id: string }> {
  // This create-or-update keys on the (repositoryId, number) unique, so it is
  // the App-repo path only. Repo-less rows (null repositoryId) must reach the
  // writer with a pullRequestDetailId and take the update-by-id branch instead
  // — an internal invariant, not a user-facing error.
  const { repositoryId } = input;
  if (repositoryId === null) {
    throw new Error(
      "upsertPullRequestDetailForBranch requires a repositoryId; a repo-less row must update by pullRequestDetailId"
    );
  }
  const verifiedAt = input.verifiedAt ?? new Date();
  return db.pullRequestDetail.upsert({
    where: {
      repositoryId_number: {
        repositoryId,
        number: input.number,
      },
    },
    create: {
      branchArtifactId,
      ...buildPullRequestDetailCreate(input),
      lastVerifiedAt: verifiedAt,
      lastRefreshAttemptAt: verifiedAt,
    },
    update: {
      ...buildPullRequestDetailUpdate(input),
      isCurrent: true,
      lastVerifiedAt: verifiedAt,
      lastRefreshAttemptAt: verifiedAt,
    },
    select: { id: true },
  });
}

async function resolveRepoLessProjectionRow(
  db: TransactionClient,
  input: BranchPullRequestProjectionInput
): Promise<string | null> {
  await acquirePullRequestProviderIdentityLockInTransaction(db, {
    organizationId: input.organizationId,
    repositoryFullName: input.repositoryFullName,
    number: input.number,
  });
  const row = await db.pullRequestDetail.findFirst({
    where: repoLessProjectionRowWhere(input),
    orderBy: { id: "asc" },
    select: { id: true },
  });
  return row?.id ?? null;
}

/**
 * Which row the repo-less lane owns, as ONE predicate (#6038 review).
 *
 * `repositoryId: null` is load-bearing and was missing: an org that carries both
 * an installation-backed row and a repo-less row for the same
 * `(fullName, number)` would otherwise let this resolver hand back the
 * App-backed row and stamp repo-less-lane provenance onto it. Reached only when
 * the caller's own `repositoryId` is null, so narrowing it cannot affect the
 * App lane.
 *
 * Exported so a caller that PRE-CHECKS for this row tests the same condition.
 * When the two predicates differ, a pre-check can find a row this resolver then
 * misses, and the write falls through to a create path that refuses a null
 * `repositoryId` by design — turning an intended skip into a thrown sweep.
 */
export function repoLessProjectionRowWhere(input: {
  organizationId: string;
  repositoryFullName: string;
  number: number;
  githubId: string;
}) {
  return {
    organizationId: input.organizationId,
    repositoryId: null,
    repositoryFullName: input.repositoryFullName,
    number: input.number,
    OR: [{ githubId: input.githubId }, { githubId: null }],
  };
}

function isStaleProjection(
  current: {
    githubUpdatedAt: Date | null;
    headRefName: string | null;
  },
  input: BranchPullRequestProjectionInput
): boolean {
  const incoming = input.githubUpdatedAt;
  if (incoming === undefined || incoming === null) {
    return false;
  }
  if (!isWithinTrustedFutureBoundary(incoming, new Date())) {
    throw new Error("pull request projection timestamp is not trustworthy");
  }
  if (!current.githubUpdatedAt) {
    return false;
  }
  if (incoming.getTime() < current.githubUpdatedAt.getTime()) {
    return true;
  }
  return (
    incoming.getTime() === current.githubUpdatedAt.getTime() &&
    current.headRefName !== null &&
    current.headRefName !== input.headBranch
  );
}

type PreparedPullRequestAssociation = {
  previousBranchArtifactId?: string;
  pullRequestDetailId: string | null;
  currentHeadSha: string | null;
  stale: boolean;
};
