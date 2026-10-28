import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import {
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
} from "@repo/api/src/types/branch-activity";
import { Prisma, type TransactionClient } from "@repo/database";
import { relinkPullRequestComments } from "@/app/comments/service/github/relink-pull-request-comments";
import { recomputeBranchActivityAggregatesInTransaction } from "./branch-activity-aggregate";
import { emitBranchDetailChanged } from "./branch-detail-signal";
import { acquirePullRequestProviderIdentityLockInTransaction } from "./pull-request-provider-lock";
import { relinkPullRequestSessionLinksInTransaction } from "./pull-request-session-link-relink";

type PullRequestBranchRelinkClient = Pick<
  TransactionClient,
  | "$executeRaw"
  | "$queryRaw"
  | "artifactLink"
  | "branchActivityAtom"
  | "branchDetail"
  | "commentThread"
  | "gitHubCommentProjection"
  | "gitHubCommentThreadProjection"
  | "pullRequestDetail"
>;

type RelinkableActivityAtom = {
  id: string;
  version: number;
  source: string;
  sourceEventId: string;
  occurredAt: Date;
  activityKind: string | null;
  attributionKind: string;
  pullRequestDetailId: string | null;
  completeness: string;
  createdAt: Date;
  branchArtifactId: string;
};

type LockedPullRequest = {
  branchArtifactId: string;
  organizationId: string;
  repositoryFullName: string | null;
  number: number;
};

/** Lock PR ownership rows while Branch-attributed evidence is validated. */
export async function lockPullRequestBranchAttributionsInTransaction(
  tx: Pick<TransactionClient, "$executeRaw" | "$queryRaw">,
  input: {
    organizationId: string;
    pullRequestDetailIds: readonly string[];
  }
): Promise<Map<string, string>> {
  const pullRequestDetailIds = [...new Set(input.pullRequestDetailIds)].sort();
  if (pullRequestDetailIds.length === 0) {
    return new Map();
  }
  for (const pullRequestDetailId of pullRequestDetailIds) {
    await lockPullRequestActivityIdentityInTransaction(
      tx,
      input.organizationId,
      pullRequestDetailId
    );
  }
  const rows = await tx.$queryRaw<
    { id: string; branchArtifactId: string }[]
  >(Prisma.sql`
    SELECT id, branch_artifact_id AS "branchArtifactId"
    FROM pull_request_detail
    WHERE organization_id = ${input.organizationId}::uuid
      AND id IN (${Prisma.join(pullRequestDetailIds)})
    ORDER BY id
    FOR SHARE
  `);
  return new Map(rows.map((row) => [row.id, row.branchArtifactId]));
}

/**
 * Reassign a PR to its authoritative Branch and carry only that PR's immutable
 * activity with it. The activity-identity advisory lock serializes concurrent
 * ingestion before PR and Branch rows are locked; Branch rows use id order so
 * competing repairs cannot deadlock. Conflicting source identities reject the
 * surrounding transaction.
 */
export async function relinkPullRequestBranchInTransaction(
  tx: PullRequestBranchRelinkClient,
  input: {
    organizationId: string;
    pullRequestDetailId: string;
    branchArtifactId: string;
    repositoryFullName: string;
    pullRequestNumber: number;
  }
): Promise<boolean> {
  const repositoryFullName = normalizeRepoFullName(input.repositoryFullName);
  await acquirePullRequestProviderIdentityLockInTransaction(tx, {
    organizationId: input.organizationId,
    repositoryFullName,
    number: input.pullRequestNumber,
  });
  await lockPullRequestActivityIdentityInTransaction(
    tx,
    input.organizationId,
    input.pullRequestDetailId
  );
  const [pullRequest] = await tx.$queryRaw<LockedPullRequest[]>`
    SELECT
      pr.branch_artifact_id AS "branchArtifactId",
      pr.organization_id AS "organizationId",
      COALESCE(pr.repository_full_name, repository.full_name) AS "repositoryFullName",
      pr.number
    FROM pull_request_detail AS pr
    LEFT JOIN github_installation_repositories AS repository
      ON repository.id = pr.repository_id
    WHERE pr.id = ${input.pullRequestDetailId}::uuid
      AND pr.organization_id = ${input.organizationId}::uuid
    FOR UPDATE OF pr
  `;
  if (!pullRequest) {
    throw new Error("pull request branch relink target was not found");
  }
  if (
    pullRequest.number !== input.pullRequestNumber ||
    !pullRequest.repositoryFullName ||
    normalizeRepoFullName(pullRequest.repositoryFullName) !== repositoryFullName
  ) {
    throw new Error("pull request branch relink provider identity changed");
  }
  const atomBranchRows = await tx.$queryRaw<{ branchArtifactId: string }[]>`
      SELECT DISTINCT branch_artifact_id AS "branchArtifactId"
      FROM branch_activity_atoms
      WHERE organization_id = ${input.organizationId}::uuid
        AND pull_request_detail_id = ${input.pullRequestDetailId}::uuid
        AND attribution_kind = ${BranchActivityAttributionKind.PullRequest}
      ORDER BY branch_artifact_id
    `;
  const branchArtifactIds = [
    ...new Set([
      pullRequest.branchArtifactId,
      input.branchArtifactId,
      ...atomBranchRows.map((row) => row.branchArtifactId),
    ]),
  ].sort();
  const branches: { artifactId: string }[] = [];
  for (const branchArtifactId of branchArtifactIds) {
    // NO KEY UPDATE, not UPDATE (ISS-10349): a concurrent atom writer holds FK
    // KEY SHARE on this row, which plain FOR UPDATE conflicts with, and the
    // two acquire the Branch and its atoms in opposite orders. This lock is an
    // ownership barrier serializing relinks against recompute -- which takes
    // NO KEY UPDATE since ISS-10331 -- and NO KEY UPDATE still excludes that.
    // Nothing on this path writes a branch_detail key column.
    const rows = await tx.$queryRaw<{ artifactId: string }[]>`
      SELECT artifact_id AS "artifactId"
      FROM branch_detail
      WHERE organization_id = ${input.organizationId}::uuid
        AND artifact_id = ${branchArtifactId}::uuid
      FOR NO KEY UPDATE
    `;
    branches.push(...rows);
  }
  if (branches.length !== branchArtifactIds.length) {
    throw new Error("pull request branch relink ownership check failed");
  }

  const activityAtoms = await loadPullRequestActivityAtoms(tx, {
    organizationId: input.organizationId,
    targetBranchArtifactId: input.branchArtifactId,
    pullRequestDetailId: input.pullRequestDetailId,
  });
  const { canonicalUpdates, duplicateIds, movingIds } = planActivityRelink(
    activityAtoms,
    input.branchArtifactId
  );

  if (duplicateIds.length > 0) {
    await tx.branchActivityAtom.deleteMany({
      where: {
        id: { in: duplicateIds },
        organizationId: input.organizationId,
      },
    });
  }
  if (movingIds.length > 0) {
    await tx.branchActivityAtom.updateMany({
      where: {
        id: { in: movingIds },
        organizationId: input.organizationId,
      },
      data: { branchArtifactId: input.branchArtifactId },
    });
  }
  for (const update of canonicalUpdates) {
    await tx.branchActivityAtom.updateMany({
      where: { id: update.id, organizationId: input.organizationId },
      data: {
        createdAt: update.createdAt,
        completeness: update.completeness,
      },
    });
  }
  const associationChanged =
    pullRequest.branchArtifactId !== input.branchArtifactId;
  if (associationChanged) {
    await movePullRequestAssociationWithComments(tx, {
      organizationId: input.organizationId,
      pullRequestDetailId: input.pullRequestDetailId,
      pullRequestNumber: pullRequest.number,
      sourceBranchArtifactId: pullRequest.branchArtifactId,
      targetBranchArtifactId: input.branchArtifactId,
    });
    await tx.branchDetail.updateMany({
      where: {
        artifactId: pullRequest.branchArtifactId,
        organizationId: input.organizationId,
        currentPullRequestDetailId: input.pullRequestDetailId,
      },
      data: { currentPullRequestDetailId: null },
    });
  }
  const sessionLinksChanged = await relinkPullRequestSessionLinksInTransaction(
    tx,
    {
      organizationId: input.organizationId,
      pullRequestNumber: pullRequest.number,
      repositoryFullName,
      sourceBranchArtifactIds: branchArtifactIds.filter(
        (branchArtifactId) => branchArtifactId !== input.branchArtifactId
      ),
      targetBranchArtifactId: input.branchArtifactId,
    }
  );
  const activityChanged =
    duplicateIds.length > 0 ||
    movingIds.length > 0 ||
    canonicalUpdates.length > 0;
  if (activityChanged || associationChanged) {
    const sourceBranchArtifactIds = branchArtifactIds.filter(
      (branchArtifactId) => branchArtifactId !== input.branchArtifactId
    );
    await recomputeBranchActivityAggregatesInTransaction(tx, {
      organizationId: input.organizationId,
      branchArtifactIds,
      exactReplacementBranchArtifactIds: activityChanged
        ? sourceBranchArtifactIds
        : [],
    });
  }
  const changed = activityChanged || associationChanged || sessionLinksChanged;
  if (changed) {
    // These notifications become visible only after the ownership move commits.
    for (const branchArtifactId of branchArtifactIds) {
      await emitBranchDetailChanged(tx, input.organizationId, branchArtifactId);
    }
  }
  return changed;
}

/** Serialize attribution validation and every write that can precede relink. */
export async function lockPullRequestActivityIdentityInTransaction(
  tx: Pick<TransactionClient, "$executeRaw">,
  organizationId: string,
  pullRequestDetailId: string
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`iss-6230:pull-request-activity:${organizationId}:${pullRequestDetailId}`}))`;
}

async function movePullRequestAssociationWithComments(
  tx: PullRequestBranchRelinkClient,
  input: {
    organizationId: string;
    pullRequestDetailId: string;
    pullRequestNumber: number;
    sourceBranchArtifactId: string;
    targetBranchArtifactId: string;
  }
): Promise<void> {
  const stagingPullRequest = await tx.pullRequestDetail.create({
    data: {
      branchArtifactId: input.targetBranchArtifactId,
      organizationId: input.organizationId,
      number: input.pullRequestNumber,
      isCurrent: false,
    },
    select: { id: true },
  });
  await relinkPullRequestComments(tx, {
    organizationId: input.organizationId,
    sourcePullRequestDetailId: input.pullRequestDetailId,
    targetPullRequestDetailId: stagingPullRequest.id,
    targetBranchArtifactId: input.targetBranchArtifactId,
  });
  const relinked = await tx.pullRequestDetail.updateMany({
    where: {
      id: input.pullRequestDetailId,
      organizationId: input.organizationId,
      branchArtifactId: input.sourceBranchArtifactId,
    },
    data: {
      branchArtifactId: input.targetBranchArtifactId,
      isCurrent: false,
    },
  });
  if (relinked.count !== 1) {
    throw new Error("pull request branch relink association changed");
  }
  await relinkPullRequestComments(tx, {
    organizationId: input.organizationId,
    sourcePullRequestDetailId: stagingPullRequest.id,
    targetPullRequestDetailId: input.pullRequestDetailId,
    targetBranchArtifactId: input.targetBranchArtifactId,
    signalMoves: false,
  });
  const removedStagingPullRequest = await tx.pullRequestDetail.deleteMany({
    where: {
      id: stagingPullRequest.id,
      organizationId: input.organizationId,
    },
  });
  if (removedStagingPullRequest.count !== 1) {
    throw new Error("pull request branch relink staging row changed");
  }
}

function loadPullRequestActivityAtoms(
  tx: Pick<TransactionClient, "$queryRaw">,
  input: {
    organizationId: string;
    targetBranchArtifactId: string;
    pullRequestDetailId: string;
  }
): Promise<RelinkableActivityAtom[]> {
  return tx.$queryRaw<RelinkableActivityAtom[]>`
    WITH source_keys AS (
      SELECT DISTINCT source, source_event_id
      FROM branch_activity_atoms
      WHERE organization_id = ${input.organizationId}::uuid
        AND pull_request_detail_id = ${input.pullRequestDetailId}::uuid
        AND attribution_kind = ${BranchActivityAttributionKind.PullRequest}
        AND branch_artifact_id <> ${input.targetBranchArtifactId}::uuid
    )
    SELECT
      atom.id,
      atom.version,
      atom.source,
      atom.source_event_id AS "sourceEventId",
      atom.occurred_at AS "occurredAt",
      atom.activity_kind AS "activityKind",
      atom.attribution_kind AS "attributionKind",
      atom.pull_request_detail_id AS "pullRequestDetailId",
      atom.completeness,
      atom.created_at AS "createdAt",
      atom.branch_artifact_id AS "branchArtifactId"
    FROM branch_activity_atoms AS atom
    WHERE atom.organization_id = ${input.organizationId}::uuid
      AND (
        (
          atom.pull_request_detail_id = ${input.pullRequestDetailId}::uuid
          AND atom.attribution_kind = ${BranchActivityAttributionKind.PullRequest}
          AND atom.branch_artifact_id <> ${input.targetBranchArtifactId}::uuid
        )
        OR (
          atom.branch_artifact_id = ${input.targetBranchArtifactId}::uuid
          AND EXISTS (
            SELECT 1
            FROM source_keys
            WHERE source_keys.source = atom.source
              AND source_keys.source_event_id = atom.source_event_id
          )
        )
      )
    ORDER BY atom.source, atom.source_event_id, atom.branch_artifact_id, atom.id
    FOR UPDATE
  `;
}

function groupActivityAtoms(
  sourceAtoms: readonly RelinkableActivityAtom[],
  targetAtoms: readonly RelinkableActivityAtom[]
): Map<string, RelinkableActivityAtom[]> {
  const grouped = new Map<string, RelinkableActivityAtom[]>();
  for (const atom of [...sourceAtoms, ...targetAtoms]) {
    const identity = activityIdentity(atom);
    const atoms = grouped.get(identity) ?? [];
    atoms.push(atom);
    grouped.set(identity, atoms);
  }
  return grouped;
}

function planActivityRelink(
  activityAtoms: readonly RelinkableActivityAtom[],
  targetBranchArtifactId: string
): {
  canonicalUpdates: Array<{
    id: string;
    createdAt: Date;
    completeness: string;
  }>;
  duplicateIds: string[];
  movingIds: string[];
} {
  const sourceAtoms = activityAtoms.filter(
    (atom) => atom.branchArtifactId !== targetBranchArtifactId
  );
  const targetAtoms = activityAtoms.filter(
    (atom) => atom.branchArtifactId === targetBranchArtifactId
  );
  const atomsByIdentity = groupActivityAtoms(sourceAtoms, targetAtoms);
  const duplicateIds: string[] = [];
  const movingIds: string[] = [];
  const canonicalUpdates: Array<{
    id: string;
    createdAt: Date;
    completeness: string;
  }> = [];
  for (const atoms of atomsByIdentity.values()) {
    const [first, ...rest] = atoms;
    if (rest.some((atom) => !sameActivityEvidence(first, atom))) {
      throw new Error("pull request branch relink activity conflict");
    }
    const targetAtom = atoms.find(
      (atom) => atom.branchArtifactId === targetBranchArtifactId
    );
    const canonical =
      targetAtom ??
      [...atoms].sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime() ||
          left.id.localeCompare(right.id)
      )[0];
    const earliestCreatedAt = new Date(
      Math.min(...atoms.map((atom) => atom.createdAt.getTime()))
    );
    const completeness = atoms.some(
      (atom) => atom.completeness === BranchActivityEvidenceCompleteness.Partial
    )
      ? BranchActivityEvidenceCompleteness.Partial
      : canonical.completeness;
    duplicateIds.push(
      ...atoms.filter((atom) => atom.id !== canonical.id).map((atom) => atom.id)
    );
    if (canonical.branchArtifactId !== targetBranchArtifactId) {
      movingIds.push(canonical.id);
    }
    if (
      canonical.createdAt.getTime() !== earliestCreatedAt.getTime() ||
      canonical.completeness !== completeness
    ) {
      canonicalUpdates.push({
        id: canonical.id,
        createdAt: earliestCreatedAt,
        completeness,
      });
    }
  }
  return { canonicalUpdates, duplicateIds, movingIds };
}

function activityIdentity(
  atom: Pick<RelinkableActivityAtom, "source" | "sourceEventId">
): string {
  return `${atom.source}\u0000${atom.sourceEventId}`;
}

function sameActivityEvidence(
  left: RelinkableActivityAtom,
  right: RelinkableActivityAtom
): boolean {
  return (
    left.version === right.version &&
    left.source === right.source &&
    left.sourceEventId === right.sourceEventId &&
    left.occurredAt.getTime() === right.occurredAt.getTime() &&
    left.activityKind === right.activityKind &&
    left.attributionKind === right.attributionKind &&
    left.pullRequestDetailId === right.pullRequestDetailId
  );
}
