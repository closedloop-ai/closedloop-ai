/**
 * Atomic bulk root-artifact rank rewrite for one project (ISS-8999).
 *
 * The single-item primitive (`documentService.moveArtifact`) needs one ordered
 * request per root, so applying a dependency-constrained rank over ~1,250 roots
 * takes minutes and leaves the project in a partial order for the whole window.
 * This service takes the COMPLETE desired root order and commits it in one
 * transaction after optimistic-concurrency validation, or commits nothing.
 *
 * Split out of `document-service.ts` (which owns document CRUD, is at the
 * file-size grandfather ceiling, and already delegates ordering concerns to
 * `document-sort-order.ts`).
 *
 * ATOMICITY. Every read and every write below runs inside ONE `withDb.tx`
 * callback, so Postgres rolls the whole operation back on any failure and no
 * rank can move without all of them moving. No failed write is caught to keep
 * issuing queries in the same transaction: the two replay reads that follow a
 * claim collision run OUTSIDE it, after that transaction has ended. That
 * rollback is Postgres', not this callback's, so `bulkRankArtifacts` must be
 * the OUTERMOST transaction — `withDb.tx` joins an ambient one without opening
 * a savepoint, and a caller that wrapped this in its own transaction would keep
 * the claim row a mid-operation failure is supposed to erase. The route calls it
 * with no transaction open, which is the only supported entry point.
 *
 * CONCURRENCY. Atomicity is not isolation: two callers can each be atomic and
 * still lose one another's work, because the rank is shared state read and then
 * rewritten. `lockProjectRank` closes that; see its docstring.
 *
 * ROOT POPULATION. A root is a DOCUMENT artifact in the project that no
 * surviving PRODUCES edge parents — the same definition
 * `project-tree-service.ts` renders, resolved through the same
 * `resolveCanonicalParents`. Nested documents and non-DOCUMENT roots (branches,
 * deployments) are never in the ranked population and their `sortOrder` is
 * never touched.
 */

import { createHash } from "node:crypto";
import { LinkType } from "@repo/api/src/types/artifact";
import type {
  BulkRankArtifactsRequest,
  BulkRankConflictDetail,
} from "@repo/api/src/types/project-artifact-bulk-rank";
import { BulkRankConflictReason } from "@repo/api/src/types/project-artifact-bulk-rank";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import {
  type ArtifactLink,
  ArtifactType,
  Prisma,
  type TransactionClient,
  withDb,
} from "@repo/database";
import {
  compareStackRankKeys,
  type StackRankKeys,
} from "@/app/artifacts/artifact-tree-shared";
import { resolveCanonicalParents } from "@/app/artifacts/project-tree-service/canonical-parents";
import { documentService } from "@/app/documents/document-service";
import {
  lockProjectRank,
  STACK_RANK_GAP,
} from "@/app/documents/document-sort-order";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";

/**
 * Hex characters kept from the SHA-256 of the ordered root population. 32 hex
 * chars is 128 bits of the digest — far past the point where an accidental
 * collision between two orderings of one project could let a stale write land.
 */
const RANK_EPOCH_HEX_LENGTH = 32;

/** One project root as the rank read sees it: identity plus its sort keys. */
type RankRootRow = StackRankKeys;

/** The project's ranked root population at one instant, plus its epoch. */
export type ProjectRankState = {
  rankEpoch: string;
  orderedRootIds: string[];
};

/** The roots a committed bulk rank rewrote, for its per-artifact receipts. */
export type BulkRankWrite = {
  rankedArtifacts: { artifactId: string; sortOrderChanged: boolean }[];
};

/** Outcome of a bulk rank rewrite that the route maps to a status code. */
export type BulkRankSuccess = {
  rankEpoch: string;
  orderedArtifactIds: string[];
  replayed: boolean;
};

/**
 * Tagged failure returned instead of thrown, per apps/api "errors as values".
 * `conflict` is present exactly when `status` is `Status.Conflict`, and carries
 * the added / removed / reparented breakdown the caller needs to re-read and
 * retry.
 */
export type BulkRankError = {
  status: StatusCode;
  message: string;
  conflict?: BulkRankConflictDetail;
};

/**
 * Opaque optimistic-concurrency token over the project's ranked roots: their
 * order AND their stack-rank values. It changes on any rank write by any
 * producer — including `moveArtifact`, which knows nothing about this endpoint
 * — because it is derived from the ranked state itself rather than bumped by a
 * writer that has to remember to.
 *
 * Callers must treat it as opaque: equality against a later read is the only
 * defined operation.
 */
export function computeRankEpoch(roots: readonly RankRootRow[]): string {
  const hash = createHash("sha256");
  for (const root of roots) {
    // `sortOrder` is in the digest, not just the id order: two reads can list
    // the same ids in the same order while a rewrite has re-spaced every rank
    // beneath them, and a later insert lands differently against each spacing.
    hash.update(`${root.id}:${root.sortOrder ?? ""}\n`);
  }
  return hash.digest("hex").slice(0, RANK_EPOCH_HEX_LENGTH);
}

/**
 * Read the project's ranked root population inside `tx`, ordered exactly as the
 * project tree renders it. Also returns the id set of every DOCUMENT in the
 * project so a caller can tell a REPARENTED id (still a project document, now
 * nested) from one that left the project entirely.
 */
async function readRankState(
  tx: TransactionClient,
  projectId: string,
  organizationId: string
): Promise<{
  state: ProjectRankState;
  documentIdsInProject: Set<string>;
  roots: RankRootRow[];
}> {
  const artifacts = await tx.artifact.findMany({
    where: { projectId, organizationId },
    select: { id: true, type: true, sortOrder: true, createdAt: true },
  });

  const internalLinks = await readInternalProducesLinks(
    tx,
    organizationId,
    projectId
  );
  const canonicalParents = resolveCanonicalParents(internalLinks);

  const documentIdsInProject = new Set<string>();
  const roots: RankRootRow[] = [];
  for (const artifact of artifacts) {
    if (artifact.type !== ArtifactType.DOCUMENT) {
      continue;
    }
    documentIdsInProject.add(artifact.id);
    if (canonicalParents.has(artifact.id)) {
      continue;
    }
    roots.push({
      id: artifact.id,
      sortOrder: artifact.sortOrder,
      createdAt: artifact.createdAt,
    });
  }
  roots.sort(compareStackRankKeys);

  return {
    state: {
      rankEpoch: computeRankEpoch(roots),
      orderedRootIds: roots.map((root) => root.id),
    },
    documentIdsInProject,
    roots,
  };
}

/**
 * The PRODUCES edges whose BOTH ends are inside the project. Only PRODUCES
 * expresses parentage; BLOCKS and RELATES_TO leave both artifacts as
 * independent roots. An edge from outside the project cannot un-root a member
 * of it either, which is why both ends are required — matching the tree.
 *
 * Both ends are expressed as a PROJECT-SCOPED relation filter rather than as
 * `sourceId in (…) AND targetId in (…)` over the ids just read. The request cap
 * bounds the ROOTS a caller may send, not the artifacts a project contains, so
 * an id list would carry every artifact in the project TWICE as bind parameters
 * and a large project could exceed Postgres' 65,535-parameter limit on this
 * read — failing before anything is ranked. A relation filter is one join
 * predicate whose parameter count does not grow with the project.
 */
async function readInternalProducesLinks(
  tx: TransactionClient,
  organizationId: string,
  projectId: string
): Promise<ArtifactLink[]> {
  const endInProject = { projectId, organizationId };
  const links = await tx.artifactLink.findMany({
    where: {
      organizationId,
      linkType: LinkType.Produces,
      source: endInProject,
      target: endInProject,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return links;
}

/**
 * Compare the requested order against the population just read. Returns the
 * conflict detail when they disagree, or `null` when the request is exactly the
 * current roots in some order and the epoch still matches.
 *
 * Population is checked before the epoch because it is strictly more
 * informative: a changed population always changes the epoch too, so reporting
 * `stale_epoch` for it would tell the caller to re-read without saying what
 * moved.
 */
function findRankConflict(args: {
  requestedIds: readonly string[];
  expectedRankEpoch: string;
  state: ProjectRankState;
  documentIdsInProject: ReadonlySet<string>;
}): BulkRankConflictDetail | null {
  const { requestedIds, expectedRankEpoch, state, documentIdsInProject } = args;
  const requested = new Set(requestedIds);
  const currentRoots = new Set(state.orderedRootIds);

  const addedArtifactIds = state.orderedRootIds.filter(
    (id) => !requested.has(id)
  );
  const removedArtifactIds: string[] = [];
  const reparentedArtifactIds: string[] = [];
  for (const id of requestedIds) {
    if (currentRoots.has(id)) {
      continue;
    }
    // Still a document of this project, just no longer a root: the caller's
    // order is stale in a way re-reading the tree will explain, which is a
    // different remedy from an id that left the project altogether.
    if (documentIdsInProject.has(id)) {
      reparentedArtifactIds.push(id);
    } else {
      removedArtifactIds.push(id);
    }
  }

  const populationChanged =
    addedArtifactIds.length > 0 ||
    removedArtifactIds.length > 0 ||
    reparentedArtifactIds.length > 0;
  if (!populationChanged && expectedRankEpoch === state.rankEpoch) {
    return null;
  }

  return {
    reason: populationChanged
      ? BulkRankConflictReason.PopulationMismatch
      : BulkRankConflictReason.StaleEpoch,
    expectedRankEpoch,
    actualRankEpoch: state.rankEpoch,
    addedArtifactIds,
    removedArtifactIds,
    reparentedArtifactIds,
  };
}

/**
 * The epoch the requested order WILL carry once committed. Derivable before the
 * write because `documentService.reorder` lays the given ids out on the
 * `STACK_RANK_GAP` grid deterministically, which is what lets the idempotency
 * row be claimed in the same transaction as the rewrite instead of after it.
 */
function projectedRankEpoch(orderedArtifactIds: readonly string[]): string {
  const placeholderCreatedAt = new Date(0);
  return computeRankEpoch(
    orderedArtifactIds.map((id, index) => ({
      id,
      sortOrder: index * STACK_RANK_GAP,
      createdAt: placeholderCreatedAt,
    }))
  );
}

/**
 * Read a project's current rank state — the epoch plus the ordered root ids —
 * for `GET /projects/:id/artifacts/rank`. This is the read a bulk caller pairs
 * with its next write: both halves come from one consistent snapshot, so the
 * epoch it sends back describes exactly the order it saw.
 *
 * REPEATABLE READ, not the default. `readRankState` issues two statements — the
 * artifacts, then the PRODUCES edges — and under READ COMMITTED each takes its
 * own snapshot. A create or reparent landing between them would produce a
 * hybrid population belonging to no single committed state, and the epoch
 * returned here would describe an order the database never held. This
 * transaction only reads, so a stricter level costs it nothing and cannot
 * raise a serialization failure.
 */
function getRankState(
  projectId: string,
  organizationId: string
): Promise<ProjectRankState> {
  return withDb.tx(
    async (tx) => {
      const { state } = await readRankState(tx, projectId, organizationId);
      return state;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
  );
}

/**
 * Look up a previously committed operation for this replay key. Org-scoped, so
 * a key minted in one organization can never replay another's commit.
 */
function findCommittedEvent(
  projectId: string,
  organizationId: string,
  idempotencyKey: string
): Promise<CommittedRankEvent | null> {
  return withDb((db) =>
    readCommittedEvent(db, projectId, organizationId, idempotencyKey)
  );
}

/** What a replayed operation returns to its caller. */
type CommittedRankEvent = { rankEpoch: string; orderedArtifactIds: string[] };

/** The replay lookup itself, against any client — pooled or transactional. */
function readCommittedEvent(
  client: Pick<TransactionClient, "projectRankEvent">,
  projectId: string,
  organizationId: string,
  idempotencyKey: string
): Promise<CommittedRankEvent | null> {
  return client.projectRankEvent.findUnique({
    where: {
      organizationId_projectId_idempotencyKey: {
        organizationId,
        projectId,
        idempotencyKey,
      },
    },
    select: { rankEpoch: true, orderedArtifactIds: true },
  });
}

/** Marker returned from the transaction when the replay key was already taken. */
const CLAIM_LOST = "claim-lost" as const;

/**
 * Apply the complete desired root order for `projectId`, atomically.
 *
 * Sequence, all inside one transaction:
 *  0. take the project's rank lock, so no other bulk rank write for this
 *     project can interleave with the read-then-write below, then re-check the
 *     replay key now that waiting is over;
 *  1. read the ranked root population and its epoch;
 *  2. reject a stale population or epoch — nothing has been written yet;
 *  3. claim the replay key with an ON CONFLICT DO NOTHING insert, which is also
 *     the bulk rank EVENT record;
 *  4. rewrite every root's `sortOrder` in one `UPDATE … FROM (VALUES …)` via
 *     `documentService.reorder`, which participates in this transaction through
 *     `withDb.tx`'s AsyncLocalStorage.
 *
 * Claiming before rewriting is what makes a retry safe: the claim and the ranks
 * commit or roll back together, so a timed-out attempt leaves neither behind and
 * the retry re-applies, while an attempt that DID commit loses the claim and
 * replays its own committed result instead of re-ranking.
 */
async function bulkRankArtifacts(
  projectId: string,
  organizationId: string,
  input: BulkRankArtifactsRequest,
  actorUserId: string | null,
  recordRanked?: RecordWriteInTransaction<BulkRankWrite>
): Promise<Result<BulkRankSuccess, BulkRankError>> {
  // Replay fast path. Read OUTSIDE the transaction and before validation:
  // a retry of an attempt that already committed carries the epoch the caller
  // read BEFORE that commit, so validating first would 409 a request whose work
  // is already done. The atomic claim in step 3 — not this read — is what
  // actually decides who applies the rewrite.
  const alreadyCommitted = await findCommittedEvent(
    projectId,
    organizationId,
    input.idempotencyKey
  );
  if (alreadyCommitted) {
    return Result.ok({ ...alreadyCommitted, replayed: true });
  }

  const outcome = await withDb.tx(async (tx) => {
    await lockProjectRank(tx, projectId);

    // The fast path above ran BEFORE the lock, so a rival carrying the same
    // replay key can have committed while this request waited for it. Its
    // commit is now the current epoch, and validating first would answer 409 to
    // a retry whose work is already done — the exact outcome the replay key
    // exists to prevent. Read, never write, so it cannot poison this
    // transaction.
    const committedUnderLock = await readCommittedEvent(
      tx,
      projectId,
      organizationId,
      input.idempotencyKey
    );
    if (committedUnderLock) {
      return Result.ok<BulkRankSuccess, BulkRankError>({
        ...committedUnderLock,
        replayed: true,
      });
    }

    const { state, documentIdsInProject, roots } = await readRankState(
      tx,
      projectId,
      organizationId
    );

    const conflict = findRankConflict({
      requestedIds: input.orderedArtifactIds,
      expectedRankEpoch: input.expectedRankEpoch,
      state,
      documentIdsInProject,
    });
    if (conflict) {
      return Result.err<BulkRankSuccess, BulkRankError>({
        status: Status.Conflict,
        message: `Project ${projectId} rank state changed since it was read`,
        conflict,
      });
    }

    const committedEpoch = projectedRankEpoch(input.orderedArtifactIds);
    // `skipDuplicates` is ON CONFLICT DO NOTHING on the
    // (organization, project, idempotency key) unique index — an atomic claim,
    // not a read-then-insert. A concurrent request holding the same key blocks
    // here until its transaction ends, then sees count 0.
    const claim = await tx.projectRankEvent.createMany({
      data: [
        {
          organizationId,
          projectId,
          idempotencyKey: input.idempotencyKey,
          source: input.source,
          actorUserId,
          rankEpoch: committedEpoch,
          orderedArtifactIds: [...input.orderedArtifactIds],
        },
      ],
      skipDuplicates: true,
    });
    if (claim.count === 0) {
      return CLAIM_LOST;
    }

    // One `UPDATE … FROM (VALUES …)` for the whole population, not one
    // statement or round trip per root.
    await documentService.reorder(
      projectId,
      [...input.orderedArtifactIds],
      organizationId
    );
    await recordRanked?.(tx, rankedWrite(roots, input.orderedArtifactIds));

    return Result.ok<BulkRankSuccess, BulkRankError>({
      rankEpoch: committedEpoch,
      orderedArtifactIds: [...input.orderedArtifactIds],
      replayed: false,
    });
  });

  if (outcome !== CLAIM_LOST) {
    return outcome;
  }

  // The claim was taken by a request that committed while this one was reading.
  // This read runs after that transaction ENDED — never inside it — so nothing
  // here issues a query on a transaction a failed write already poisoned.
  const committed = await findCommittedEvent(
    projectId,
    organizationId,
    input.idempotencyKey
  );
  if (!committed) {
    return Result.err({
      status: Status.Conflict,
      message: `Bulk rank operation ${input.idempotencyKey} is already in progress for project ${projectId}`,
    });
  }
  return Result.ok({ ...committed, replayed: true });
}

export const artifactBulkRankService = {
  getRankState,
  bulkRankArtifacts,
};

/**
 * What a committed bulk rank wrote, per root in the requested order: whether
 * its `sortOrder` moved. `documentService.reorder` lays the order out on the
 * `STACK_RANK_GAP` grid, so a root already at its grid slot did not change.
 */
function rankedWrite(
  roots: readonly RankRootRow[],
  orderedArtifactIds: readonly string[]
): BulkRankWrite {
  const previous = new Map(roots.map((root) => [root.id, root.sortOrder]));
  return {
    rankedArtifacts: orderedArtifactIds.map((artifactId, index) => ({
      artifactId,
      sortOrderChanged: previous.get(artifactId) !== index * STACK_RANK_GAP,
    })),
  };
}
