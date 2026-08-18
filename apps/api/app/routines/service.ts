import type {
  CreateRoutineInput,
  RecordRoutineRunInput,
  UpdateRoutineInput,
} from "@repo/api/src/types/routine";
import { ROUTINE_RUN_HISTORY_CAP } from "@repo/api/src/types/routine";
import {
  type Routine,
  type RoutineRun,
  type TransactionClient,
  withDb,
} from "@repo/database";
import {
  buildRoutineUpdateData,
  buildRoutineWriteData,
  serializeAttempts,
  serializeInvokedComponents,
} from "@/app/routines/service-mappers";

/**
 * FEA-4365 / PRD-566 — cloud/web persistence for Routines + run history.
 *
 * Backend-only (apps/api). Every read and write is ORG-SCOPED: the caller's
 * `organizationId` is part of the predicate on every query so org A can never
 * read or mutate org B's routines. Team scope is an optional additional filter.
 *
 * Cross-tenant relation safety: a caller from org A can pass a `teamId`/`ownerId`
 * that actually belongs to org B (they are globally-unique UUIDs guarded only by
 * single-column FKs). Before persisting we RESOLVE both relations with an
 * `organizationId` predicate inside the write transaction and reject the write
 * when either lookup fails, so a routine can never claim org A while pointing at
 * org B's team/user.
 *
 * Sync identity: desktop-origin routines/runs carry a crewd source id
 * (`ScheduledTask.id` / `RunRecord.id`) that is an ARBITRARY string, not the
 * cloud UUID PK. Upserts key on the ORG-SCOPED unique `[organizationId,
 * sourceId]` / `[organizationId, sourceRunId]`, so re-delivering the same source
 * entity is idempotent per org and one tenant's conflict update can never land
 * on another tenant's row.
 */

type ListRoutinesArgs = {
  organizationId: string;
  teamId?: string | null;
  limit?: number;
  offset?: number;
};

// Clamp list paging to sane floors/ceilings so a hostile or buggy caller can't
// request a negative offset or an unbounded page.
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_LIMIT;
  }
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

function clampOffset(offset: number | undefined): number {
  if (offset === undefined) {
    return 0;
  }
  return Math.max(0, Math.trunc(offset));
}

/**
 * Create a routine owned by the caller's org. `organizationId` is applied
 * server-side and can never be overridden by the input body. Related team/owner
 * tenancy is validated against the caller's org first — returns null when either
 * points at another org (route → 400/404).
 */
async function createRoutine(
  organizationId: string,
  input: CreateRoutineInput
): Promise<Routine | null> {
  return await withDb.tx(async (tx) => {
    const ok = await relationsBelongToOrg(tx, organizationId, input);
    if (!ok) {
      return null;
    }
    const data = buildRoutineWriteData(organizationId, input);
    return await tx.routine.create({ data });
  });
}

/**
 * Atomic upsert of a desktop-origin routine, scoped to the caller's org. Keyed
 * on the ORG-SCOPED unique `[organizationId, sourceId]`: the conflict target
 * INCLUDES `organizationId`, so the update branch can only ever match a row
 * already owned by this org — two orgs syncing the same source id land on two
 * different rows and neither can clobber the other (no cross-tenant race, no
 * findFirst-then-create). Related team/owner tenancy is validated first. Returns
 * null when a relation points at another org.
 */
async function upsertRoutineBySource(
  organizationId: string,
  sourceId: string,
  input: CreateRoutineInput
): Promise<Routine | null> {
  const data = buildRoutineWriteData(organizationId, { ...input, sourceId });
  return await withDb.tx(async (tx) => {
    const ok = await relationsBelongToOrg(tx, organizationId, input);
    if (!ok) {
      return null;
    }
    // Update payload never touches identity/tenancy/source.
    const { organizationId: _org, sourceId: _src, ...updateData } = data;
    return await tx.routine.upsert({
      where: {
        organizationId_sourceId: { organizationId, sourceId },
      },
      create: data,
      update: updateData,
    });
  });
}

/**
 * Org-scoped partial update. Uses `updateMany` gated on `{ id, organizationId }`
 * so a cross-org id can never mutate another tenant's row; returns null when
 * nothing matched (wrong org or missing), which the route maps to 404. When the
 * update changes provider or supplies team/owner, those are validated/normalized
 * inside the same transaction.
 */
async function updateRoutine(
  organizationId: string,
  id: string,
  input: UpdateRoutineInput
): Promise<Routine | null> {
  return await withDb.tx(async (tx) => {
    const existing = await tx.routine.findFirst({
      where: { id, organizationId },
      select: { id: true, provider: true },
    });
    if (!existing) {
      return null;
    }
    const ok = await relationsBelongToOrg(tx, organizationId, input);
    if (!ok) {
      return null;
    }
    // A provider transition clears the outgoing provider's capability fields.
    const nextProvider =
      input.provider && input.provider !== existing.provider
        ? input.provider
        : null;
    const data = buildRoutineUpdateData(input, nextProvider);
    await tx.routine.updateMany({ where: { id, organizationId }, data });
    return await tx.routine.findUnique({ where: { id } });
  });
}

/** Org-scoped read of a single routine; null when not owned by the caller. */
async function getRoutine(
  organizationId: string,
  id: string
): Promise<Routine | null> {
  return await withDb((db) =>
    db.routine.findFirst({ where: { id, organizationId } })
  );
}

/** Org- (and optionally team-) scoped list, newest-updated first. */
async function listRoutines(args: ListRoutinesArgs): Promise<{
  items: Routine[];
  total: number;
}> {
  const { organizationId, teamId } = args;
  const limit = clampLimit(args.limit);
  const offset = clampOffset(args.offset);
  const where =
    teamId === undefined ? { organizationId } : { organizationId, teamId };
  return await withDb(async (db) => {
    const [items, total] = await Promise.all([
      db.routine.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        take: limit,
        skip: offset,
      }),
      db.routine.count({ where }),
    ]);
    return { items, total };
  });
}

/**
 * Org-scoped delete. Returns whether a row was actually removed so the route can
 * 404 a cross-org / missing id rather than silently succeeding.
 */
async function deleteRoutine(
  organizationId: string,
  id: string
): Promise<boolean> {
  const result = await withDb((db) =>
    db.routine.deleteMany({ where: { id, organizationId } })
  );
  return result.count > 0;
}

/**
 * Persist one run of a routine and refresh the routine's bookkeeping, atomically.
 *
 * In ONE transaction: verify the routine is owned by the caller's org; UPSERT
 * the run keyed on the org-scoped `[organizationId, sourceRunId]` when the caller
 * supplied a source id (so re-delivering the same crewd `RunRecord` updates the
 * existing row — a RUNNING row can transition to terminal — instead of inserting
 * a duplicate that consumes a retention slot); SWEEP history down to
 * `ROUTINE_RUN_HISTORY_CAP`; then derive the routine's `lastRun*` cache from the
 * RETAINED newest row so the badge can never point at a row the sweep deleted and
 * never rewinds to an older, out-of-order run. Returns null when the routine
 * isn't owned by the caller (route → 404).
 */
async function recordRun(
  organizationId: string,
  routineId: string,
  input: RecordRoutineRunInput
): Promise<RoutineRun | null> {
  return await withDb.tx(async (tx) => {
    const routine = await tx.routine.findFirst({
      where: { id: routineId, organizationId },
      select: { id: true },
    });
    if (!routine) {
      return null;
    }

    const run = await persistRun(tx, organizationId, routineId, input);
    await sweepRunHistory(tx, routineId);
    await refreshLastRunCache(tx, routineId);
    return run;
  });
}

/** Org- (and routine-) scoped run history, newest first. */
async function listRuns(args: {
  organizationId: string;
  routineId: string;
  limit?: number;
  offset?: number;
}): Promise<{ items: RoutineRun[]; total: number }> {
  const { organizationId, routineId } = args;
  const limit = clampLimit(args.limit);
  const offset = clampOffset(args.offset);
  const where = { organizationId, routineId };
  return await withDb(async (db) => {
    const [items, total] = await Promise.all([
      db.routineRun.findMany({
        where,
        orderBy: { startedAt: "desc" },
        take: limit,
        skip: offset,
      }),
      db.routineRun.count({ where }),
    ]);
    return { items, total };
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a routine's optional `teamId`/`ownerId` against the caller's org.
 * Returns false when either is present but belongs to a DIFFERENT org (or does
 * not exist), so the caller refuses the write rather than persisting a routine
 * that claims one org while referencing another org's team/user. An absent
 * relation is fine (returns true).
 */
async function relationsBelongToOrg(
  tx: TransactionClient,
  organizationId: string,
  input: { teamId?: string | null; ownerId?: string | null }
): Promise<boolean> {
  if (input.teamId) {
    const team = await tx.team.findFirst({
      where: { id: input.teamId, organizationId },
      select: { id: true },
    });
    if (!team) {
      return false;
    }
  }
  if (input.ownerId) {
    const owner = await tx.user.findFirst({
      where: { id: input.ownerId, organizationId },
      select: { id: true },
    });
    if (!owner) {
      return false;
    }
  }
  return true;
}

/**
 * Insert or (when a source run id is present) org-scoped-upsert one run row.
 * Re-delivering the same `[organizationId, sourceRunId]` updates the existing
 * row so ingestion is idempotent and a RUNNING row can reach its terminal state.
 */
async function persistRun(
  tx: TransactionClient,
  organizationId: string,
  routineId: string,
  input: RecordRoutineRunInput
): Promise<RoutineRun> {
  const runFields = {
    routineId,
    taskName: input.taskName ?? null,
    status: input.status,
    startedAt: input.startedAt ? new Date(input.startedAt) : new Date(),
    finishedAt: input.finishedAt ? new Date(input.finishedAt) : null,
    provider: input.provider ?? null,
    modelId: input.modelId ?? null,
    summary: input.summary,
    error: input.error ?? null,
    logPath: input.logPath ?? null,
    sessionId: input.sessionId ?? null,
    sessionIds: input.sessionIds,
    invokedComponents: serializeInvokedComponents(input.invokedComponents),
    attempts: serializeAttempts(input.attempts),
  };
  if (input.sourceRunId) {
    return await tx.routineRun.upsert({
      where: {
        organizationId_sourceRunId: {
          organizationId,
          sourceRunId: input.sourceRunId,
        },
      },
      create: { organizationId, sourceRunId: input.sourceRunId, ...runFields },
      update: runFields,
    });
  }
  return await tx.routineRun.create({
    data: { organizationId, ...runFields },
  });
}

/**
 * Delete every run for a routine beyond the newest `ROUTINE_RUN_HISTORY_CAP`.
 * Ordered by `[startedAt desc, id desc]` — the SAME deterministic order the list
 * read and the last-run cache use — so which rows are retained is consistent
 * across all three. Retention is bounded after every recorded run.
 */
async function sweepRunHistory(
  tx: TransactionClient,
  routineId: string
): Promise<void> {
  const keep = await tx.routineRun.findMany({
    where: { routineId },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    take: ROUTINE_RUN_HISTORY_CAP,
    select: { id: true },
  });
  const keepIds = keep.map((row) => row.id);
  await tx.routineRun.deleteMany({
    where: { routineId, id: { notIn: keepIds } },
  });
}

/**
 * Recompute the routine's `lastRun*` cache from its RETAINED newest run (same
 * `[startedAt desc, id desc]` order as the sweep/list). Deriving the cache from
 * the surviving row — rather than from whichever run was just recorded — means
 * an out-of-order/backfilled older run never rewinds the badge, and the cached
 * `lastRunId` can never dangle at a row the sweep deleted. Clears the cache when
 * no runs remain.
 */
async function refreshLastRunCache(
  tx: TransactionClient,
  routineId: string
): Promise<void> {
  const newest = await tx.routineRun.findFirst({
    where: { routineId },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      startedAt: true,
      status: true,
      sessionId: true,
    },
  });
  await tx.routine.update({
    where: { id: routineId },
    data: {
      lastRunId: newest?.id ?? null,
      lastRunAt: newest?.startedAt ?? null,
      lastStatus: newest?.status ?? null,
      lastRunSessionId: newest?.sessionId ?? null,
    },
  });
}

export const routinesService = {
  createRoutine,
  upsertRoutineBySource,
  updateRoutine,
  getRoutine,
  listRoutines,
  deleteRoutine,
  recordRun,
  listRuns,
};
