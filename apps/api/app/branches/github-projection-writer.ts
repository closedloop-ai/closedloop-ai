import {
  BranchBaseBranchSource,
  BranchHeadShaSource,
} from "@repo/api/src/types/artifact";
import type { Prisma, TransactionClient } from "@repo/database";
import { invalidateBranchStatusChecksForHeadChange } from "@/lib/branch-status-checks";
import {
  type GitHubFetchProvenance,
  gitHubFetchProvenanceData,
} from "@/lib/github-fetch-provenance";
import { pullRequestLocData } from "./pull-request-loc-data";

export type BranchPullRequestProjectionInput = {
  organizationId: string;
  repositoryId: string;
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
  closedAt?: Date | null;
  mergedAt?: Date | null;
  mergeCommitSha?: string | null;
  fetchProvenance?: GitHubFetchProvenance;
};

export type ExistingBranchPullRequestProjectionTarget = {
  branchArtifactId: string;
  pullRequestDetailId?: string | null;
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
      closedAt: input.closedAt ?? null,
      mergedAt: input.mergedAt ?? null,
      mergeCommitSha: input.mergeCommitSha ?? null,
      ...gitHubFetchProvenanceData(input.fetchProvenance),
    };
  if (input.reviewDecision !== undefined) {
    create.reviewDecision = input.reviewDecision;
  }
  return create;
}

/**
 * Builds the PR detail update shape shared by webhook/read-repair writes and
 * historical backfill writes.
 */
export function buildPullRequestDetailUpdate(
  input: BranchPullRequestProjectionInput
): Prisma.PullRequestDetailUncheckedUpdateInput {
  const update: Prisma.PullRequestDetailUncheckedUpdateInput = {
    number: input.number,
    title: input.title,
    htmlUrl: input.htmlUrl,
    body: input.body ?? undefined,
    prState: input.prState,
    isDraft: input.isDraft,
    ...pullRequestLocData(input),
    isCurrent: true,
    ...gitHubFetchProvenanceData(input.fetchProvenance),
  };
  if (input.reviewDecision !== undefined) {
    update.reviewDecision = input.reviewDecision;
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
  return update;
}

/**
 * Writes the branch and current PR projection for an already-owned BRANCH
 * artifact. This is the shared durable writer for webhook/read-repair updates
 * and internal historical backfill; public backfill routes remain dry-run
 * unless an owner-approved internal caller invokes this path.
 */
export async function writeExistingBranchPullRequestProjection(
  db: TransactionClient,
  target: ExistingBranchPullRequestProjectionTarget,
  input: BranchPullRequestProjectionInput
): Promise<{ id: string }> {
  if (target.branchProjectionMode !== BranchProjectionMode.PointerOnly) {
    await db.branchDetail.update({
      where: { artifactId: target.branchArtifactId },
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
    if (target.currentHeadSha !== (input.headSha ?? null)) {
      await invalidateBranchStatusChecksForHeadChange(
        db,
        target.branchArtifactId
      );
    }
  }

  const prDetail = target.pullRequestDetailId
    ? await updatePullRequestDetail(db, target.pullRequestDetailId, input)
    : await upsertPullRequestDetailForBranch(
        db,
        target.branchArtifactId,
        input
      );

  await db.pullRequestDetail.updateMany({
    where: {
      branchArtifactId: target.branchArtifactId,
      isCurrent: true,
      id: { not: prDetail.id },
    },
    data: { isCurrent: false },
  });

  await db.branchDetail.update({
    where: { artifactId: target.branchArtifactId },
    data: { currentPullRequestDetailId: prDetail.id },
  });

  return { id: prDetail.id };
}

async function updatePullRequestDetail(
  db: TransactionClient,
  pullRequestDetailId: string,
  input: BranchPullRequestProjectionInput
): Promise<{ id: string }> {
  await db.pullRequestDetail.update({
    where: { id: pullRequestDetailId },
    data: buildPullRequestDetailUpdate(input),
  });
  return { id: pullRequestDetailId };
}

/**
 * FEA-2732: when the GitHub App projection (webhook or fetch) runs after the
 * desktop already synced this PR, adopt the desktop row for this branch+number
 * by stamping its githubId (and repositoryId), so the githubId-keyed upsert in
 * `upsertCurrentPullRequestDetail` updates THAT row instead of CREATE-ing a
 * duplicate and colliding on the `repositoryId_number` unique index (P2002).
 *
 * Scoped to `githubId IS NULL` — only the App/webhook path ever writes githubId,
 * so this matches exactly the desktop's own not-yet-stamped rows and never
 * touches an already-adopted App row. This deliberately covers BOTH a repo-less
 * desktop row (repositoryId null, synced before the App install) AND one that
 * already carries a repositoryId (resolved from the org's active App
 * installation at sync time) — the latter is the case the earlier
 * `repositoryId IS NULL` scope missed, letting the App-repo desktop row be
 * shadowed by a duplicate create. The desktop writer is *supposed* to dedup on
 * (organizationId, branchArtifactId, number), but that is writer discipline, not
 * a DB constraint — no PullRequestDetail unique prevents two githubId=null rows
 * on the same (branchArtifactId, number). FEA-3212: a bare `updateMany` here
 * would stamp the SAME githubId onto every matched row, and if two such rows
 * exist it violates the `github_id` unique (P2002) and rolls back the whole
 * webhook/branch-sync transaction. So we adopt exactly ONE row per call: select a
 * single deterministic target (ordered by `id`, the only always-present column;
 * PullRequestDetail has no createdAt) and stamp it with a `githubId: null`-guarded
 * `updateMany` on its unique `id` — the guard keeps the write atomic so a
 * concurrent adopt on the same row degrades to a safe no-op instead of a blind
 * overwrite. Any additional duplicate row is left untouched — it can't take this
 * githubId anyway, and the upsert that follows resolves the current pointer. A
 * no-op when none exists.
 */
export async function adoptRepolessPullRequestDetail(
  db: TransactionClient,
  input: {
    branchArtifactId: string;
    number: number;
    repositoryId: string;
    githubId: string;
  }
): Promise<void> {
  const target = await db.pullRequestDetail.findFirst({
    where: {
      branchArtifactId: input.branchArtifactId,
      number: input.number,
      githubId: null,
    },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  if (!target) {
    return;
  }
  // Keep `githubId: null` in the WHERE clause so the write stays atomic: if a
  // concurrent adopt stamped this row between our findFirst and update, the
  // guarded updateMany matches 0 rows and degrades to a safe no-op rather than
  // blindly overwriting the winner's githubId.
  await db.pullRequestDetail.updateMany({
    where: { id: target.id, githubId: null },
    data: { repositoryId: input.repositoryId, githubId: input.githubId },
  });
}

/**
 * FEA-2732: adopt a desktop-produced repo-less PullRequestDetail row by its
 * producer-independent D2 identity `(organizationId, repositoryFullName,
 * number)` — used by the webhook path, which knows the repo but not the branch
 * artifact. Stamps repositoryId + githubId on the PR row AND repositoryId on its
 * parent branch (so repo-scoped branch reads stay consistent), then returns
 * whether a row was adopted. Callers MUST only invoke this when no App-owned row
 * exists yet for `(repositoryId, number)`, so filling repositoryId can't clash
 * with the `repositoryId_number` unique index. A no-op when no repo-less row
 * matches.
 */
export async function adoptRepolessPullRequestByRepoIdentity(
  db: TransactionClient,
  input: {
    organizationId: string;
    repositoryFullName: string;
    number: number;
    repositoryId: string;
    githubId: string;
  }
): Promise<boolean> {
  const existing = await db.pullRequestDetail.findFirst({
    where: {
      organizationId: input.organizationId,
      repositoryFullName: input.repositoryFullName,
      number: input.number,
      repositoryId: null,
    },
    select: { id: true, branchArtifactId: true },
  });
  if (!existing) {
    return false;
  }
  await db.pullRequestDetail.update({
    where: { id: existing.id },
    data: { repositoryId: input.repositoryId, githubId: input.githubId },
  });
  await db.branchDetail.updateMany({
    where: { artifactId: existing.branchArtifactId, repositoryId: null },
    data: { repositoryId: input.repositoryId },
  });
  return true;
}

async function upsertPullRequestDetailForBranch(
  db: TransactionClient,
  branchArtifactId: string,
  input: BranchPullRequestProjectionInput
): Promise<{ id: string }> {
  await adoptRepolessPullRequestDetail(db, {
    branchArtifactId,
    number: input.number,
    repositoryId: input.repositoryId,
    githubId: input.githubId,
  });
  return db.pullRequestDetail.upsert({
    where: {
      repositoryId_number: {
        repositoryId: input.repositoryId,
        number: input.number,
      },
    },
    create: {
      branchArtifactId,
      ...buildPullRequestDetailCreate(input),
      lastVerifiedAt: new Date(),
      lastRefreshAttemptAt: new Date(),
    },
    update: {
      branchArtifactId,
      ...buildPullRequestDetailUpdate(input),
      isCurrent: true,
      lastVerifiedAt: new Date(),
      lastRefreshAttemptAt: new Date(),
    },
    select: { id: true },
  });
}
