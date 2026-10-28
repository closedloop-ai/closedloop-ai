import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import { isTerminalStatusForSubtype } from "@repo/api/src/types/document";
import { type TransactionClient, withDb } from "@repo/database";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { captureAutomatedUnblock } from "@/lib/artifact-activity-capture";
import {
  BLOCKED_STATUS,
  type BlockedCandidateRow,
  type InboundBlockerRow,
  liveBlockerEdgeFilter,
  selectUnblockableIds,
  UNBLOCKED_STATUS,
} from "./blocked-dependent-resolution";

/**
 * Auto-clear stale `BLOCKED` artifacts once their blockers resolve (ISS-9632).
 *
 * Two entry points over one shared resolver:
 *
 * - `resolveBlocksForChangedArtifacts` — the forward path, driven off the set
 *   of artifacts a status write ACTUALLY moved (never the requested set: an
 *   artifact already at the target status did not transition and must not
 *   re-trigger a sweep). Every status write path calls it: the single
 *   `PUT /documents/[id]`, and both batch routes through
 *   `emitBatchStatusSideEffects`.
 * - `resolveBlocksForRemovedEdges` — the other half of "a blocker is resolved":
 *   the `BLOCKS` edge was DELETED rather than its source terminalized. Called by
 *   `DELETE /artifact-links/[id]`.
 * - `reconcileStaleBlockedArtifacts` — the org-scoped reconciliation sweep over
 *   rows that went stale before the forward path existed, with
 *   `previewStaleBlockedArtifacts` as its read-only twin. Idempotent by
 *   construction: only rows still `BLOCKED` are candidates, so a second run
 *   over a reconciled org moves nothing.
 *
 * Every query is org-scoped and set-based, and every `IN (…)` predicate is
 * bounded: candidate sets are processed in chunks of
 * {@link UNBLOCK_CANDIDATE_CHUNK_SIZE} so a blocker with a very wide dependent
 * fan-out cannot build a predicate past Postgres's bind-parameter limit, and
 * each chunk's guarded bulk update is one atomic statement, committed on its
 * own transaction under {@link UNBLOCK_CHUNK_TX_TIMEOUT_MS}, rather than
 * serializing the whole fan-out inside one interactive-transaction timeout.
 *
 * INDEXES — no schema change or migration is involved, but the claim is per
 * query, not blanket:
 *  - "what does X block" / "what blocks Y" are served by `ArtifactLink`'s
 *    `[organizationId, sourceId, linkType]` and `[organizationId, targetId,
 *    linkType]`.
 *  - The candidate and update predicates are primary-key driven (`id IN …`).
 *  - The sweep's population scan is the one that needs care: `Artifact`'s only
 *    status-bearing index is `[organizationId, type, status]`, so the scan
 *    pins `type` to `DOCUMENT` to keep the equality prefix sargable. That is
 *    not merely an optimisation — `BLOCKED` belongs to the Document-subtype
 *    status vocabulary (PRD-495), so a non-`DOCUMENT` artifact carrying it is
 *    not in this population by definition.
 */

type UnblockOutcome = {
  /**
   * Dependents the resolver judged unblockable. A SUPERSET of
   * {@link UnblockOutcome.unblockedIds}: the update re-asserts the whole rule —
   * still `BLOCKED`, still no live inbound `BLOCKS` edge — so a row a concurrent
   * write moved out of `BLOCKED`, or one whose blocker came back between the
   * read and the write, is resolved but declined rather than clobbered.
   */
  resolvedIds: string[];
  /**
   * Dependents this call ACTUALLY moved `BLOCKED` → `TODO`. This is the set to
   * report and to record activity for; reporting `resolvedIds` as if it were
   * this one would claim transitions that never happened.
   */
  unblockedIds: string[];
};

/** Rows the sweep reads per page. Keyset-paginated, so it never re-reads. */
const RECONCILE_BLOCKED_PAGE_SIZE = 200;

/**
 * Upper bound on candidate ids in any one `IN (…)` predicate. Bounds both the
 * bind-parameter count and the work inside a single transaction. A 200-row
 * guarded write expired the 5s interactive transaction this path ran under
 * before {@link UNBLOCK_CHUNK_TX_TIMEOUT_MS} — Prisma's default, still 5s
 * everywhere that does not override it. Smaller chunks preserve coverage while
 * each completed chunk is reported and audited independently. This is the real
 * bound on per-transaction work — {@link UNBLOCK_CHUNK_TX_TIMEOUT_MS} is only
 * the backstop for a chunk that runs slow, never a licence to widen this one.
 */
export const UNBLOCK_CANDIDATE_CHUNK_SIZE = 32;

/** What one org-scoped reconciliation pass found, and what it moved. */
export type ReconcileOutcome = {
  organizationId: string;
  /** `BLOCKED` rows examined. */
  scanned: number;
  /** Rows whose blockers have all resolved. Reported by preview AND apply. */
  resolvedIds: string[];
  /** Rows actually moved to `TODO`. Always empty in preview mode. */
  unblockedIds: string[];
};

function emptyOutcome(): UnblockOutcome {
  return { resolvedIds: [], unblockedIds: [] };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/**
 * The shared READ half: of `candidateIds`, which artifacts are still `BLOCKED`
 * with every blocker resolved.
 *
 * Two statements — narrow the candidates to rows that are genuinely still
 * `BLOCKED`, then read every inbound `BLOCKS` edge for all of them in ONE
 * grouped query. Never a query per dependent.
 *
 * The blocker sources are resolved by a SEPARATE org-scoped read rather than a
 * relation join off the link row, and that is a tenant boundary, not a style
 * choice. `ArtifactLink.organizationId` is a plain column with nothing forcing
 * it to agree with its endpoints' orgs, so a link this org owns can point at
 * another org's artifact. Joining through it would read that foreign artifact's
 * status and let it decide this org's outcome — a cross-tenant read and a side
 * channel. Filtering the join instead would be worse: an excluded edge looks
 * like a resolved one, which is the wrong direction to fail. So the sources are
 * looked up org-scoped, and an edge whose source does not come back is paired
 * with `null` and counts as still blocking.
 */
async function resolveUnblockableIds(
  tx: TransactionClient,
  organizationId: string,
  candidateIds: readonly string[]
): Promise<string[]> {
  if (candidateIds.length === 0) {
    return [];
  }

  const candidates: BlockedCandidateRow[] = await tx.artifact.findMany({
    where: {
      organizationId,
      id: { in: [...candidateIds] },
      status: BLOCKED_STATUS,
    },
    select: { id: true, subtype: true },
  });
  if (candidates.length === 0) {
    return [];
  }

  const edges = await tx.artifactLink.findMany({
    where: {
      organizationId,
      linkType: LinkType.Blocks,
      targetId: { in: candidates.map((candidate) => candidate.id) },
    },
    select: { targetId: true, sourceId: true },
  });
  if (edges.length === 0) {
    return [];
  }

  const sources = await tx.artifact.findMany({
    where: {
      organizationId,
      id: { in: [...new Set(edges.map((edge) => edge.sourceId))] },
    },
    select: { id: true, subtype: true, status: true },
  });
  const sourceById = new Map(sources.map((source) => [source.id, source]));

  const inboundBlockers: InboundBlockerRow[] = edges.map((edge) => ({
    targetId: edge.targetId,
    source: sourceById.get(edge.sourceId) ?? null,
  }));

  return selectUnblockableIds({ candidates, inboundBlockers });
}

/**
 * The shared resolver plus its single set-based write, for ONE bounded chunk of
 * candidates.
 *
 * THE WRITE DOES NOT TRUST THE READ. It re-asserts the WHOLE rule in its own
 * `WHERE` — the row is still `BLOCKED`, and it still has no live inbound
 * `BLOCKS` edge per {@link liveBlockerEdgeFilter} — so the decision is made
 * against the rows as they are at write time rather than as they were some
 * statements earlier (whitlockk, ISS-9632 review). Re-asserting only the status
 * closed half the window: a blocker REOPENED, or a brand-new `BLOCKS` edge
 * INSERTED, between the read and the write would still have landed the
 * dependent in `TODO` with a live blocker — and irrecoverably, because nothing
 * reconsiders a row once it has left `BLOCKED`.
 *
 * This is a predicate, not a lock. At READ COMMITTED the update takes its own
 * snapshot, so anything that COMMITTED before the statement began is seen and
 * declines the row; no blocker row is locked and no status write anywhere else
 * is serialized against this one. What remains is the overlap of the two
 * statements themselves, where "unblocked, then the blocker reopened" is a legal
 * serialization with the same end state as running them in that order — not a
 * silent override of a block that was already back.
 *
 * `updateManyAndReturn` rather than `updateMany` because the ids that LANDED are
 * what the audit trail and the reconciliation report speak about; a count cannot
 * say WHICH rows the predicate declined, and a re-read after the fact cannot
 * tell a row this call moved from one a concurrent writer moved.
 *
 * Its `withDb` calls JOIN the chunk transaction {@link forEachUnblockedChunk}
 * opens, so they commit with that chunk's receipt (ISS-10993). The predicate
 * above is what makes the decision correct either way; the transaction binds
 * the receipt to the write, it does not lock the rule in.
 */
async function unblockCandidateChunk(
  organizationId: string,
  candidateIds: readonly string[]
): Promise<UnblockOutcome> {
  const resolvedIds = await withDb((db) =>
    resolveUnblockableIds(db, organizationId, candidateIds)
  );
  if (resolvedIds.length === 0) {
    return emptyOutcome();
  }

  const written = await withDb((db) =>
    db.artifact.updateManyAndReturn({
      where: {
        organizationId,
        id: { in: resolvedIds },
        status: BLOCKED_STATUS,
        targetLinks: { none: liveBlockerEdgeFilter(organizationId) },
      },
      data: { status: UNBLOCKED_STATUS },
      select: { id: true },
    })
  );
  return { resolvedIds, unblockedIds: written.map((row) => row.id) };
}

/**
 * Resolve a candidate set in bounded chunks, WITHOUT writing. Chunked for the
 * same reason the writing path is: `pageSize` is caller-supplied and clamped
 * only at the bottom, so a large page must not collapse into one large
 * `IN (…)`. The two size constants happening to be equal today is a
 * coincidence, not a bound.
 */
async function resolveCandidatesInChunks(
  organizationId: string,
  candidateIds: readonly string[]
): Promise<string[]> {
  const resolved: string[] = [];
  for (const ids of chunk(candidateIds, UNBLOCK_CANDIDATE_CHUNK_SIZE)) {
    resolved.push(
      ...(await withDb((db) => resolveUnblockableIds(db, organizationId, ids)))
    );
  }
  return resolved;
}

/**
 * Process a candidate set in bounded chunks. Advisory reads happen before each
 * chunk's own atomic guarded-write statement, and `onCommitted` runs only
 * after that statement has succeeded.
 *
 * The per-chunk callback is not a convenience. Because each chunk commits
 * independently, a throw on chunk N leaves chunks 1..N-1 already written; a
 * caller that only acted on the aggregate return value would silently skip the
 * audit rows for those committed transitions, and a status that changed with no
 * actor and no audit row is indistinguishable from a bug. Callers therefore act
 * per committed chunk and accumulate OUTSIDE their try, so a partial run
 * reports what really landed rather than nothing.
 */
async function forEachUnblockedChunk(
  organizationId: string,
  candidateIds: readonly string[],
  onCommitted: (chunkOutcome: UnblockOutcome) => void,
  /**
   * The activity receipt, written on the CHUNK'S OWN transaction (ISS-10993) so
   * a receipt that cannot be persisted rolls that chunk's transitions back
   * instead of leaving a status the platform changed with no row naming it.
   * Runs before the chunk commits; `onCommitted` still runs after, so the
   * outcome a caller accumulates is only ever what really landed.
   */
  captureInTx?: (
    tx: TransactionClient,
    chunkOutcome: UnblockOutcome
  ) => Promise<void>
): Promise<void> {
  for (const ids of chunk(candidateIds, UNBLOCK_CANDIDATE_CHUNK_SIZE)) {
    onCommitted(
      await withDb.tx(
        async (tx) => {
          const chunkOutcome = await unblockCandidateChunk(organizationId, ids);
          await captureInTx?.(tx, chunkOutcome);
          return chunkOutcome;
        },
        { timeout: UNBLOCK_CHUNK_TX_TIMEOUT_MS }
      )
    );
  }
}

/** Accumulate one committed chunk into a running outcome. */
function accumulate(into: UnblockOutcome, chunkOutcome: UnblockOutcome): void {
  into.resolvedIds.push(...chunkOutcome.resolvedIds);
  into.unblockedIds.push(...chunkOutcome.unblockedIds);
}

/**
 * Forward path. Given the artifacts a status write actually moved, unblock
 * every dependent whose blockers are now all resolved.
 *
 * `changedArtifactIds` is re-read here rather than trusted as terminal: the
 * post-commit row is the authoritative status, and reading it keeps both call
 * sites down to "hand me the ids that changed".
 */
async function findUnblockCandidates(params: {
  organizationId: string;
  changedArtifactIds: readonly string[];
}): Promise<string[]> {
  const changedIds = [...new Set(params.changedArtifactIds)];
  if (changedIds.length === 0) {
    return [];
  }

  return await withDb(async (db) => {
    const changed = await db.artifact.findMany({
      where: { organizationId: params.organizationId, id: { in: changedIds } },
      select: { id: true, subtype: true, status: true },
    });

    const terminalIds = changed
      .filter((artifact) =>
        isTerminalStatusForSubtype(artifact.subtype, artifact.status)
      )
      .map((artifact) => artifact.id);
    if (terminalIds.length === 0) {
      return [];
    }

    const edges = await db.artifactLink.findMany({
      where: {
        organizationId: params.organizationId,
        linkType: LinkType.Blocks,
        sourceId: { in: terminalIds },
      },
      select: { targetId: true },
    });
    return [...new Set(edges.map((edge) => edge.targetId))];
  });
}

/**
 * Forward path WITHOUT the audit row or the failure isolation. Given the
 * artifacts a status write actually moved, unblock every dependent whose
 * blockers are now all resolved.
 *
 * `changedArtifactIds` is re-read rather than trusted as terminal: the
 * post-commit row is the authoritative status, and reading it keeps both call
 * sites down to "hand me the ids that changed".
 */
async function unblockDependentsOfChanged(params: {
  organizationId: string;
  changedArtifactIds: readonly string[];
}): Promise<UnblockOutcome> {
  const outcome = emptyOutcome();
  const candidateIds = await findUnblockCandidates(params);
  await forEachUnblockedChunk(
    params.organizationId,
    candidateIds,
    (chunkOutcome) => accumulate(outcome, chunkOutcome)
  );
  return outcome;
}

/**
 * Forward-path entry point for the two status write paths, including the
 * automated-transition audit row.
 *
 * Best-effort by design: the status write the caller asked for has already
 * committed by the time this runs, so a failure here is logged and swallowed
 * rather than turned into a 500 for a write that succeeded — the same posture
 * the audit-ledger and activity-capture hooks on these routes already take.
 * `reconcileStaleBlockedArtifacts` is the backstop for anything a failure here
 * leaves behind.
 *
 * PARTIAL RUNS ARE REAL, AND ARE REPORTED AS SUCH. Each chunk commits in its
 * own transaction, so a throw on chunk N leaves chunks 1..N-1 written. The
 * audit rows are therefore recorded per COMMITTED chunk, before the next one
 * runs — not once at the end, which a throw would skip, leaving those committed
 * transitions with no actor and no audit row. For the same reason the outcome
 * accumulates OUTSIDE the try, so the catch returns what actually landed rather
 * than claiming a clean no-op the database would contradict.
 */
async function resolveBlocksForChangedArtifacts(params: {
  organizationId: string;
  changedArtifactIds: readonly string[];
}): Promise<UnblockOutcome> {
  const outcome = emptyOutcome();
  try {
    const candidateIds = await findUnblockCandidates(params);
    await forEachUnblockedChunk(
      params.organizationId,
      candidateIds,
      (chunkOutcome) => accumulate(outcome, chunkOutcome),
      (tx, chunkOutcome) =>
        auditUnblockedChunk(tx, params.organizationId, chunkOutcome)
    );
  } catch (error) {
    log.error("Failed to auto-clear blocked dependents", {
      organizationId: params.organizationId,
      changedCount: params.changedArtifactIds.length,
      unblockedBeforeFailure: outcome.unblockedIds.length,
      error: parseError(error),
    });
  }
  return outcome;
}

/**
 * The OTHER half of "a blocker is resolved" (whitlockk, ISS-9632 review): the edge
 * was DELETED rather than its source terminalized. `selectUnblockableIds`
 * already treats an absent edge as resolved, but nothing woke the resolver on a
 * delete, so a dependent whose remaining blockers were already terminal stayed
 * `BLOCKED` with nothing live holding it. `DELETE /artifact-links/[id]` calls
 * this with the removed edge's target.
 *
 * The dependents are handed straight to the chunked write — there is no
 * "changed artifact" to walk outward from, and the write proves org membership
 * and the blocker rule itself. Same best-effort posture as
 * {@link resolveBlocksForChangedArtifacts}: the delete has already committed, so
 * a failure here is logged and swallowed rather than turned into a 500 for a
 * delete that succeeded.
 */
async function resolveBlocksForRemovedEdges(params: {
  organizationId: string;
  dependentIds: readonly string[];
}): Promise<UnblockOutcome> {
  const outcome = emptyOutcome();
  try {
    await forEachUnblockedChunk(
      params.organizationId,
      [...new Set(params.dependentIds)],
      (chunkOutcome) => accumulate(outcome, chunkOutcome),
      (tx, chunkOutcome) =>
        auditUnblockedChunk(tx, params.organizationId, chunkOutcome)
    );
  } catch (error) {
    log.error("Failed to auto-clear dependents of a removed BLOCKS edge", {
      organizationId: params.organizationId,
      dependentCount: params.dependentIds.length,
      unblockedBeforeFailure: outcome.unblockedIds.length,
      error: parseError(error),
    });
  }
  return outcome;
}

/**
 * Walk the org's `BLOCKED` population one keyset page at a time, handing each
 * page to `handlePage`, and accumulate what it reports.
 *
 * Keyset rather than offset pagination specifically because the applying sweep
 * mutates rows OUT of the `BLOCKED` population as it goes: an offset would skip
 * the rows that shifted down behind it. Ids it moves stay behind the cursor.
 *
 * The keyset is an explicit `id > cursor` predicate, NOT Prisma's `cursor`
 * option, for the same reason: `cursor` anchors on a row that must still be in
 * the FILTERED result set, and every row the applying sweep moves leaves that
 * set. The anchor would vanish and the walk would stop pages early.
 */
async function sweepBlockedArtifacts(params: {
  organizationId: string;
  pageSize?: number;
  handlePage: (candidateIds: string[]) => Promise<UnblockOutcome>;
}): Promise<ReconcileOutcome> {
  const pageSize = Math.max(1, params.pageSize ?? RECONCILE_BLOCKED_PAGE_SIZE);
  const resolvedIds: string[] = [];
  const unblockedIds: string[] = [];
  let scanned = 0;
  let cursor: string | undefined;

  for (;;) {
    const page = await withDb((db) =>
      db.artifact.findMany({
        where: {
          organizationId: params.organizationId,
          type: ArtifactType.Document,
          status: BLOCKED_STATUS,
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        select: { id: true },
        orderBy: { id: "asc" },
        take: pageSize,
      })
    );
    if (page.length === 0) {
      break;
    }

    scanned += page.length;
    cursor = page.at(-1)?.id;
    const outcome = await params.handlePage(page.map((row) => row.id));
    resolvedIds.push(...outcome.resolvedIds);
    unblockedIds.push(...outcome.unblockedIds);

    if (page.length < pageSize) {
      break;
    }
  }

  return {
    organizationId: params.organizationId,
    scanned,
    resolvedIds,
    unblockedIds,
  };
}

/**
 * One-time (re-runnable) reconciliation over the artifacts that went stale
 * before the forward path existed. Org-scoped and idempotent — a second run
 * finds the rows it already moved sitting in `TODO`, so they are not candidates
 * and it moves nothing.
 *
 * It produces the SAME audit trail as the forward path (whitlockk, ISS-9632
 * review). A backfill is the one run where a reader is most likely to ask "who
 * moved this?", and a status the platform changed with no actor and no activity
 * row is indistinguishable from a bug — which is exactly what
 * `ArtifactActivityActorType.System` exists to prevent.
 */
function reconcileStaleBlockedArtifacts(params: {
  organizationId: string;
  pageSize?: number;
}): Promise<ReconcileOutcome> {
  return sweepBlockedArtifacts({
    ...params,
    handlePage: async (candidateIds) => {
      const outcome = emptyOutcome();
      // The same in-transaction receipt the forward path takes (ISS-10993). The
      // script used to await a list of separately-started inserts, because the
      // request path scheduled its own through `waitUntil` and a script has no
      // request lifetime to flush that against. Nothing schedules now, so both
      // paths write the receipt on the chunk's own transaction and a chunk that
      // cannot record one does not commit.
      await forEachUnblockedChunk(
        params.organizationId,
        candidateIds,
        (chunkOutcome) => accumulate(outcome, chunkOutcome),
        (tx, chunkOutcome) =>
          auditUnblockedChunk(tx, params.organizationId, chunkOutcome)
      );
      return outcome;
    },
  });
}

/**
 * The same sweep with the write removed: reports exactly which artifacts
 * {@link reconcileStaleBlockedArtifacts} would move, without moving them. This
 * is what makes the backfill's justification checkable before it is applied.
 * `unblockedIds` is empty on this path because nothing was written — the answer
 * is `resolvedIds`.
 */
function previewStaleBlockedArtifacts(params: {
  organizationId: string;
  pageSize?: number;
}): Promise<ReconcileOutcome> {
  return sweepBlockedArtifacts({
    ...params,
    handlePage: async (candidateIds) => ({
      resolvedIds: await resolveCandidatesInChunks(
        params.organizationId,
        candidateIds
      ),
      unblockedIds: [],
    }),
  });
}

/** The `BLOCKED` → `TODO` change rows for a set of artifacts that moved. */
function toUnblockChanges(
  artifactIds: readonly string[]
): Array<{ artifactId: string; before: string; after: string }> {
  return artifactIds.map((artifactId) => ({
    artifactId,
    before: BLOCKED_STATUS,
    after: UNBLOCKED_STATUS,
  }));
}

/**
 * Record the automated transition for one COMMITTED chunk, driven off what the
 * write landed and never off what the resolver decided: an audit row for a
 * transition the update declined tells a reader of the activity feed that the
 * platform did something it did not do.
 */
function auditUnblockedChunk(
  tx: TransactionClient,
  organizationId: string,
  chunkOutcome: UnblockOutcome
): Promise<void> {
  if (chunkOutcome.unblockedIds.length === 0) {
    return Promise.resolve();
  }
  return captureAutomatedUnblock({
    tx,
    organizationId,
    changes: toUnblockChanges(chunkOutcome.unblockedIds),
  });
}

export const blockedDependentUnblockService = {
  /**
   * The DB operation on its own, WITHOUT the audit row or the failure
   * isolation. Exposed because it is the honest seam for a test that wants the
   * write without the receipt.
   */
  unblockDependentsOfChanged,
  resolveBlocksForChangedArtifacts,
  resolveBlocksForRemovedEdges,
  reconcileStaleBlockedArtifacts,
  previewStaleBlockedArtifacts,
};

/**
 * Interactive-transaction ceiling for one chunk's guarded write plus its
 * activity receipt (ISS-10993 moved the receipt inside the transaction, which
 * left this call on Prisma's 5s default). 30s matches the two other budgeted
 * transactions on this surface — `PLAN_TX_TIMEOUT_MS` in
 * `app/desktop/transcripts/service.ts` and `STALE_SESSION_TRANSACTION_TIMEOUT_MS`
 * in `app/agent-sessions/stale-session-reaper-service.ts` — and clears the
 * worst run observed expiring the default (14.5s) with room for a loaded CI
 * box. It is a backstop, not the bound on the work: what bounds that is
 * {@link UNBLOCK_CANDIDATE_CHUNK_SIZE}, which caps every chunk at a fixed row
 * count however wide the fan-out.
 */
const UNBLOCK_CHUNK_TX_TIMEOUT_MS = 30_000;
