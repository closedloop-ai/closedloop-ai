import { ArtifactType } from "@repo/api/src/types/artifact";
import { GitHubPRState } from "@repo/api/src/types/github";
import { v7 as uuidv7 } from "uuid";
import { chunksOf } from "@/lib/chunks-of";
import type { AgentSessionUpsertTx } from "../records";
import { bindParameterChunkSize } from "../write-chunking";
import type { SessionBranchRepositoryAuthority } from "./shared";

/**
 * Materialize only the artifact-first internal data plane for monitored
 * activity. This helper deliberately creates no Session link or publication
 * evidence, including for default branches.
 */
export async function ensureInternalBranchActivityTargets(
  tx: AgentSessionUpsertTx,
  input: {
    organizationId: string;
    projectId: string | null;
    targets: readonly {
      repositoryAuthority: SessionBranchRepositoryAuthority | undefined;
      repositoryFullName: string;
      branchName: string;
    }[];
  }
): Promise<Map<string, string>> {
  const targets = [
    ...new Map(
      input.targets
        .filter(
          (target) =>
            target.repositoryAuthority !== undefined &&
            !target.repositoryAuthority.identityConflict
        )
        .map((target) => [internalBranchTargetIdentity(target), target])
    ).values(),
  ].sort((left, right) =>
    internalBranchTargetIdentity(left).localeCompare(
      internalBranchTargetIdentity(right)
    )
  );
  if (targets.length === 0) {
    return new Map();
  }
  const lockKeys = targets
    .map((target) =>
      internalBranchTargetLockKey(
        input.organizationId,
        target.repositoryFullName,
        target.branchName
      )
    )
    .sort();
  // `$executeRaw`, never `$queryRaw`: `pg_advisory_xact_lock()` returns `void`,
  // which Prisma cannot deserialize, so a row-returning call throws on every
  // execution (ISS-8780).
  //
  // One statement per key rather than one batched `unnest`: acquisition order is
  // what stops two concurrent transactions holding each other's keys, and
  // neither a SQL `ORDER BY` nor a bare `unnest()` Function Scan constrains it —
  // the target-list function is evaluated during the scan, before any sort, and
  // row order out of `unnest` is not a guarantee Postgres makes. Sequential
  // statements over the sorted keys are the order. The batched form that does
  // keep caller order is `advisory_xact_lock_text_keys_in_order` (migration
  // `20261001180000_iss11608_advisory_xact_lock_text_keys_in_order`), used by
  // `acquirePullRequestProviderIdentityLocksInTransaction` — but it is NOT a
  // drop-in here: it locks `hashtextextended(key, 0)`, while this site locks the
  // int4 `hashtext(key)` slot. Swapping it in would move every key below to a
  // different slot, and pods still taking `hashtext` would stop excluding it.
  for (const lockKey of lockKeys) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
  }
  const existing = await findBranchDetails(tx, input.organizationId, targets);
  const artifactIdByIdentity = new Map(
    existing.map((branch) => [
      internalBranchTargetIdentity(branch),
      branch.artifactId,
    ])
  );
  const missing = targets
    .filter(
      (target) =>
        !artifactIdByIdentity.has(internalBranchTargetIdentity(target))
    )
    .map((target) => ({ target, artifactId: uuidv7() }));
  if (missing.length === 0) {
    return artifactIdByIdentity;
  }
  for (const chunk of chunksOf(missing, ARTIFACT_INSERT_CHUNK_SIZE)) {
    await tx.artifact.createMany({
      data: chunk.map(({ target, artifactId }) => ({
        id: artifactId,
        type: ArtifactType.Branch,
        organizationId: input.organizationId,
        projectId: input.projectId,
        name: target.branchName,
        status: GitHubPRState.Open,
        externalUrl: `https://github.com/${target.repositoryFullName}/tree/${encodeURIComponent(target.branchName)}`,
      })),
    });
  }
  // `skipDuplicates`, because the lock above serializes only THIS helper. The
  // push webhook reaches `branchService.upsertBranchArtifact` for the same
  // PRD-510 D2 identity — both sides normalize through `normalizeRepoFullName`,
  // so they collide on `branch_detail_org_repo_full_name_branch_key` — and it
  // takes no branch-identity lock. Without this, a webhook that commits between
  // the recheck above and this insert raises P2002, and since a failed write
  // poisons the surrounding interactive transaction the whole session-ingest
  // slice is rejected even though the row it wanted now exists.
  for (const chunk of chunksOf(missing, BRANCH_DETAIL_INSERT_CHUNK_SIZE)) {
    await tx.branchDetail.createMany({
      data: chunk.map(({ target, artifactId }) => ({
        artifactId,
        organizationId: input.organizationId,
        repositoryId: target.repositoryAuthority?.repositoryId ?? null,
        repositoryFullName: target.repositoryFullName,
        branchName: target.branchName,
      })),
      skipDuplicates: true,
    });
  }
  // Re-read rather than trusting the ids we minted: a skipped row belongs to the
  // other writer, and its artifact id is the one every caller must resolve to.
  const settled = await findBranchDetails(
    tx,
    input.organizationId,
    missing.map(({ target }) => target)
  );
  for (const branch of settled) {
    artifactIdByIdentity.set(
      internalBranchTargetIdentity(branch),
      branch.artifactId
    );
  }
  const settledArtifactIds = new Set(
    settled.map((branch) => branch.artifactId)
  );
  const orphanedArtifactIds = missing
    .map(({ artifactId }) => artifactId)
    .filter((artifactId) => !settledArtifactIds.has(artifactId));
  // An artifact minted for an identity the other writer won carries no detail
  // row and nothing references it. Created in this transaction, dropped in it.
  for (const chunk of chunksOf(orphanedArtifactIds, ORPHAN_DELETE_CHUNK_SIZE)) {
    await tx.artifact.deleteMany({ where: { id: { in: chunk } } });
  }
  return artifactIdByIdentity;
}

/**
 * One `(repositoryFullName, branchName)` `OR` arm per target, sliced at the
 * bind budget: nothing bounds how many distinct Branch targets one Session's
 * monitored activity may name (ISS-9860).
 */
async function findBranchDetails(
  tx: AgentSessionUpsertTx,
  organizationId: string,
  targets: readonly { repositoryFullName: string; branchName: string }[]
): Promise<
  { artifactId: string; repositoryFullName: string; branchName: string }[]
> {
  const rows: {
    artifactId: string;
    repositoryFullName: string;
    branchName: string;
  }[] = [];
  for (const chunk of chunksOf(targets, BRANCH_DETAIL_LOOKUP_CHUNK_SIZE)) {
    rows.push(
      ...(await tx.branchDetail.findMany({
        where: {
          organizationId,
          OR: chunk.map((target) => ({
            repositoryFullName: target.repositoryFullName,
            branchName: target.branchName,
          })),
        },
        select: {
          artifactId: true,
          repositoryFullName: true,
          branchName: true,
        },
      }))
    );
  }
  return rows;
}

/** Serialize the artifact-plus-BranchDetail create behind its canonical key. */
function internalBranchTargetLockKey(
  organizationId: string,
  repositoryFullName: string,
  branchName: string
): string {
  return `iss-6230:internal-branch-target:${organizationId}:${repositoryFullName}:${branchName}`;
}

function internalBranchTargetIdentity(target: {
  repositoryFullName: string;
  branchName: string;
}): string {
  return `${target.repositoryFullName}\u0000${target.branchName}`;
}

/** Two binds per target beside the fixed `organizationId`. */
const BRANCH_DETAIL_LOOKUP_CHUNK_SIZE = bindParameterChunkSize(2, 1);
/**
 * Bind parameters one row costs in a `createMany`: every column in the model,
 * client-filled defaults included — sized against the schema like
 * `BRANCH_ACTIVITY_ATOM_COLUMN_COUNT`, not the literal a writer spells out.
 */
const ARTIFACT_COLUMN_COUNT = 17;
const BRANCH_DETAIL_COLUMN_COUNT = 50;
const ARTIFACT_INSERT_CHUNK_SIZE = bindParameterChunkSize(
  ARTIFACT_COLUMN_COUNT,
  0
);
const BRANCH_DETAIL_INSERT_CHUNK_SIZE = bindParameterChunkSize(
  BRANCH_DETAIL_COLUMN_COUNT,
  0
);
const ORPHAN_DELETE_CHUNK_SIZE = bindParameterChunkSize(1, 0);
